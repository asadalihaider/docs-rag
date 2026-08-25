import { sha256 } from '../util/hash.js';
import { estimateTokens } from '../util/tokens.js';
import type { Chunk, SourceDocument, StoredChunk } from '../types.js';
import { parseBlocks, type Block } from './blocks.js';

export interface ChunkOptions {
  /** Preferred chunk size in tokens. */
  targetTokens?: number;
  /** Hard ceiling; a chunk is never packed beyond this (a single code fence may exceed it). */
  maxTokens?: number;
  /** Chunks smaller than this are merged into a neighbour when it is safe to do so. */
  minTokens?: number;
  /** Tokens of trailing context repeated at the head of the next chunk. */
  overlapTokens?: number;
  /** Include the heading breadcrumb line when computing sizes. Off by default. */
  countHeadingInBudget?: boolean;
}

export const DEFAULT_CHUNK_OPTIONS: Required<ChunkOptions> = {
  targetTokens: 400,
  maxTokens: 700,
  minTokens: 120,
  overlapTokens: 60,
  countHeadingInBudget: false,
};

/**
 * The text actually handed to the embedder and to the prompt builder.
 *
 * Prepending the document title and heading breadcrumb is the cheapest
 * retrieval win available: a chunk under `Troubleshooting > Job stuck in
 * pending` frequently never repeats the words "troubleshooting" or "pending"
 * in its body, so without the breadcrumb neither the dense nor the sparse
 * retriever can connect it to a question phrased in those terms. Keeping it out
 * of `Chunk.content` means the stored text stays byte-faithful to the source,
 * which matters for citation excerpts.
 */
export function contextualText(chunk: {
  documentTitle?: string;
  headingPath: string[];
  content: string;
}): string {
  const breadcrumb = [chunk.documentTitle, ...chunk.headingPath].filter(Boolean).join(' > ');
  return breadcrumb ? `${breadcrumb}\n\n${chunk.content}` : chunk.content;
}

interface WorkingChunk {
  headingPath: string[];
  blocks: Block[];
  /** Blocks repeated from the previous chunk as overlap context. */
  overlap: Block[];
}

interface OpenChunk {
  chunk: WorkingChunk;
  tokens: number;
}

/**
 * Heading-aware markdown chunker.
 *
 * Algorithm:
 *   1. Scan the document into heading / code / text blocks (see `blocks.ts`).
 *   2. Maintain a heading stack so every block knows its full ancestry.
 *   3. Split oversized *text* blocks into paragraph- then sentence-sized pieces.
 *      Code fences are never split — a fence larger than `maxTokens` becomes its
 *      own chunk, because half a `docker-compose.yml` is worse than useless as a
 *      retrieval result.
 *   4. Pack blocks into chunks up to `targetTokens`, starting a fresh chunk
 *      whenever the heading path changes.
 *   5. Prepend `overlapTokens` of trailing blocks from the previous chunk when
 *      continuing within the same section, so a fact split across a boundary is
 *      still retrievable from either side.
 *   6. Merge chunks below `minTokens` into an adjacent chunk when the two share
 *      a heading ancestor, so stub sections do not become their own noisy
 *      retrieval units.
 */
export function chunkDocument(doc: SourceDocument, options: ChunkOptions = {}): Chunk[] {
  const opts = { ...DEFAULT_CHUNK_OPTIONS, ...options };
  if (opts.minTokens >= opts.targetTokens) {
    throw new RangeError('minTokens must be smaller than targetTokens');
  }
  if (opts.maxTokens < opts.targetTokens) {
    throw new RangeError('maxTokens must be >= targetTokens');
  }

  const blocks = parseBlocks(doc.body);
  const working = packBlocks(blocks, opts, doc.title);
  const merged = mergeSmall(working, opts, doc.title);

  return merged.map((wc, ordinal) => {
    const content = renderBlocks([...wc.overlap, ...wc.blocks]);
    const all = [...wc.overlap, ...wc.blocks];
    const startLine = all[0]?.startLine ?? 1;
    const endLine = all[all.length - 1]?.endLine ?? startLine;
    return {
      id: `${doc.id}#${ordinal}`,
      documentId: doc.id,
      ordinal,
      headingPath: wc.headingPath,
      content,
      contentHash: sha256(`${wc.headingPath.join(' > ')}\n${content}`),
      tokenCount: estimateTokens(content),
      startLine,
      endLine,
    };
  });
}

/* ------------------------------------------------------------------ */

function packBlocks(
  blocks: Block[],
  opts: Required<ChunkOptions>,
  documentTitle: string,
): WorkingChunk[] {
  const chunks: WorkingChunk[] = [];
  const headingStack: Array<{ level: number; text: string }> = [];

  /** The chunk currently accepting blocks, plus its running token total. */
  let open: OpenChunk | null = null;

  const headingPath = () => headingStack.map((h) => h.text);

  const overheadTokens = (path: string[]) =>
    opts.countHeadingInBudget ? estimateTokens([documentTitle, ...path].join(' > ')) : 0;

  const openChunk = (path: string[], overlap: Block[]): OpenChunk => {
    const chunk: WorkingChunk = { headingPath: path, blocks: [], overlap };
    const tokens =
      overlap.reduce((sum, b) => sum + estimateTokens(b.text), 0) + overheadTokens(path);
    const state: OpenChunk = { chunk, tokens };
    open = state;
    return state;
  };

  /** Commit the open chunk if it holds real content; empty ones are discarded. */
  const commit = () => {
    if (open && open.chunk.blocks.length > 0) chunks.push(open.chunk);
    open = null;
  };

  /**
   * Headings seen since the last content block, waiting to be attached to the
   * chunk that content opens.
   *
   * The heading line is kept *in the chunk body*, not only in `headingPath`.
   * Two reasons. First, small sections get merged into a neighbour and a merged
   * chunk keeps only the shared ancestor path — so without this the words
   * "Homebrew" or "Rate limits" would vanish from the index entirely, and a
   * query using them could never match. Second, a heading is often the only
   * place the key noun phrase appears at all; dropping it throws away the single
   * highest-signal line in the section.
   */
  let pendingHeadings: Extract<Block, { kind: 'heading' }>[] = [];

  for (const block of blocks) {
    if (block.kind === 'heading') {
      while (
        headingStack.length > 0 &&
        (headingStack[headingStack.length - 1] as { level: number }).level >= block.level
      ) {
        headingStack.pop();
      }
      headingStack.push({ level: block.level, text: block.text });
      // A heading always starts a new chunk, and overlap never crosses a
      // section boundary — carrying the tail of "Installation" into
      // "Configuration" would attach the wrong heading path to that text.
      commit();
      pendingHeadings.push(block);
      continue;
    }

    const pieces = block.kind === 'code' ? [block] : splitTextBlock(block, opts.targetTokens);

    for (const piece of pieces) {
      const pieceTokens = estimateTokens(piece.text);

      if (open === null) {
        open = openChunk(headingPath(), []);
      } else if (open.tokens + pieceTokens > opts.maxTokens && open.chunk.blocks.length > 0) {
        const overlap = takeOverlap(open.chunk.blocks, opts.overlapTokens);
        commit();
        open = openChunk(headingPath(), overlap);
      }

      // Attach any headings that introduced this content, in document order.
      if (pendingHeadings.length > 0) {
        for (const heading of pendingHeadings) {
          const text = `${'#'.repeat(heading.level)} ${heading.text}`;
          open.chunk.blocks.push({ ...heading, kind: 'text', text });
          open.tokens += estimateTokens(text);
        }
        pendingHeadings = [];
      }

      open.chunk.blocks.push(piece);
      open.tokens += pieceTokens;

      // At or past target: close now and let the next block start a fresh chunk
      // with overlap, instead of drifting toward maxTokens.
      if (open.tokens >= opts.targetTokens) {
        const overlap = takeOverlap(open.chunk.blocks, opts.overlapTokens);
        const path = open.chunk.headingPath;
        commit();
        open = openChunk(path, overlap);
      }
    }
  }

  commit();
  return chunks;
}

/**
 * Split a text block that exceeds the target size.
 * Paragraph boundaries first, then sentence boundaries, then a hard word split
 * as a last resort (a single 400-token "sentence" is usually a wrapped table).
 */
function splitTextBlock(block: Block, targetTokens: number): Block[] {
  if (estimateTokens(block.text) <= targetTokens) return [block];

  const paragraphs = block.text.split(/\n{2,}/).filter((p) => p.trim().length > 0);
  const units = paragraphs.length > 1 ? paragraphs : splitLongParagraph(block.text, targetTokens);

  // Line numbers are apportioned proportionally — precise enough for the
  // "lines 40–58" hint shown next to a citation.
  const totalLines = Math.max(1, block.endLine - block.startLine + 1);
  const totalChars = Math.max(1, block.text.length);
  let cursorChars = 0;
  const out: Block[] = [];

  for (const unit of units) {
    const startLine = block.startLine + Math.floor((cursorChars / totalChars) * totalLines);
    cursorChars += unit.length;
    const endLine =
      block.startLine +
      Math.min(totalLines - 1, Math.floor((cursorChars / totalChars) * totalLines));
    out.push({ kind: 'text', text: unit, startLine, endLine: Math.max(startLine, endLine) });
  }
  return out;
}

function splitLongParagraph(text: string, targetTokens: number): string[] {
  const sentences = text.split(/(?<=[.!?:])\s+/);
  const out: string[] = [];
  let buffer = '';

  const flush = () => {
    if (buffer.trim()) out.push(buffer.trim());
    buffer = '';
  };

  for (const sentence of sentences) {
    const candidate = buffer ? `${buffer} ${sentence}` : sentence;
    if (estimateTokens(candidate) > targetTokens && buffer) {
      flush();
      buffer = sentence;
    } else {
      buffer = candidate;
    }
  }
  flush();

  // Last resort: a single unsplittable run (long table row, minified blob).
  return out.flatMap((piece) =>
    estimateTokens(piece) <= targetTokens * 1.5 ? [piece] : hardSplit(piece, targetTokens),
  );
}

function hardSplit(text: string, targetTokens: number): string[] {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let buffer: string[] = [];
  for (const word of words) {
    buffer.push(word);
    if (estimateTokens(buffer.join(' ')) >= targetTokens) {
      out.push(buffer.join(' '));
      buffer = [];
    }
  }
  if (buffer.length > 0) out.push(buffer.join(' '));
  return out;
}

/** Trailing blocks worth at most `budget` tokens, oldest-first. Never a code fence. */
function takeOverlap(blocks: Block[], budget: number): Block[] {
  if (budget <= 0) return [];
  const picked: Block[] = [];
  let total = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i] as Block;
    // Repeating a whole code fence as overlap wastes most of the budget and
    // makes duplicate code appear in two chunks; prose overlap is what helps.
    if (block.kind === 'code') break;
    const tokens = estimateTokens(block.text);
    if (total + tokens > budget) break;
    picked.unshift(block);
    total += tokens;
  }
  return picked;
}

function commonPrefix(a: string[], b: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) break;
    out.push(a[i] as string);
  }
  return out;
}

/**
 * Merge chunks below `minTokens` into a neighbour.
 *
 * Only merges when the two chunks share a heading ancestor (or one has no
 * heading at all), and the merged chunk keeps the *common* heading path — so a
 * merge never claims a chunk came from a section it did not.
 */
function mergeSmall(
  chunks: WorkingChunk[],
  opts: Required<ChunkOptions>,
  documentTitle: string,
): WorkingChunk[] {
  const sizeOf = (c: WorkingChunk) =>
    estimateTokens(renderBlocks([...c.overlap, ...c.blocks])) +
    (opts.countHeadingInBudget ? estimateTokens([documentTitle, ...c.headingPath].join(' > ')) : 0);

  const result: WorkingChunk[] = [];
  for (const chunk of chunks) {
    const previous = result[result.length - 1];
    if (!previous) {
      result.push(chunk);
      continue;
    }

    const chunkSize = sizeOf(chunk);
    const previousSize = sizeOf(previous);
    const smallest = Math.min(chunkSize, previousSize);
    if (smallest >= opts.minTokens) {
      result.push(chunk);
      continue;
    }

    const prefix = commonPrefix(previous.headingPath, chunk.headingPath);
    const compatible =
      prefix.length > 0 || previous.headingPath.length === 0 || chunk.headingPath.length === 0;
    const combined = previousSize + chunkSize;

    if (!compatible || combined > opts.maxTokens) {
      result.push(chunk);
      continue;
    }

    // Keep the more specific path when one is an ancestor of the other,
    // otherwise fall back to the shared ancestor.
    const isAncestor =
      prefix.length === previous.headingPath.length || prefix.length === chunk.headingPath.length;
    const mergedPath = isAncestor
      ? previous.headingPath.length >= chunk.headingPath.length
        ? previous.headingPath
        : chunk.headingPath
      : prefix;

    // Overlap that duplicates content we are now merging in would be repeated
    // verbatim, so drop the successor's overlap blocks.
    result[result.length - 1] = {
      headingPath: mergedPath,
      blocks: [...previous.blocks, ...chunk.blocks],
      overlap: previous.overlap,
    };
  }
  return result;
}

function renderBlocks(blocks: Block[]): string {
  return blocks
    .map((b) => b.text.replace(/\s+$/, ''))
    .filter((t) => t.length > 0)
    .join('\n\n')
    .trim();
}

/** Convenience for tests and the pipeline: chunk + attach document metadata. */
export function toStoredChunk(chunk: Chunk, doc: SourceDocument): StoredChunk {
  return { ...chunk, documentPath: doc.id, documentTitle: doc.title };
}
