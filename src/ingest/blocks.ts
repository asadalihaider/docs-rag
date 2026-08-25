/**
 * A tiny, purpose-built markdown block scanner.
 *
 * A full CommonMark parser (remark + mdast) would be more correct, but it also
 * throws away the byte/line fidelity we need for citations and forces us to
 * re-serialise nodes back to markdown before embedding. What the chunker
 * actually needs is much narrower: know where headings are, know where fenced
 * code starts and stops so we never cut through one, and keep loose lists and
 * tables together. That is what this does, on raw lines, in ~120 lines.
 */
export type Block =
  | { kind: 'heading'; level: number; text: string; startLine: number; endLine: number }
  | { kind: 'code'; text: string; startLine: number; endLine: number }
  | { kind: 'text'; text: string; startLine: number; endLine: number };

const ATX = /^ {0,3}(#{1,6})\s+(.*?)\s*(?:\s#+)?\s*$/;
const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const SETEXT_H1 = /^ {0,3}=+\s*$/;
const SETEXT_H2 = /^ {0,3}-{2,}\s*$/;
const LIST_ITEM = /^\s*(?:[-*+]\s+|\d+[.)]\s+)/;
const TABLE_ROW = /^\s*\|/;
const BLOCKQUOTE = /^\s*>/;
// `---` is only a thematic break here when it is *not* a setext underline; the
// setext branch runs first and only fires when a paragraph line precedes it.
const THEMATIC_BREAK = /^ {0,3}(?:\*\s*){3,}$|^ {0,3}(?:_\s*){3,}$|^ {0,3}-{3,}\s*$/;

/** Split markdown into headings, fenced code blocks and text blocks. */
export function parseBlocks(markdown: string, lineOffset = 0): Block[] {
  const lines = markdown.split('\n');
  const blocks: Block[] = [];

  let buffer: string[] = [];
  let bufferStart = 0;

  const flushText = (endLine: number) => {
    if (buffer.length === 0) return;
    const text = buffer.join('\n').replace(/\s+$/, '');
    if (text.trim().length > 0) {
      blocks.push({ kind: 'text', text, startLine: bufferStart, endLine });
    }
    buffer = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const lineNo = lineOffset + i + 1;

    // --- fenced code -------------------------------------------------
    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      const marker = fence[2] as string;
      const fenceChar = marker[0] as string;
      const fenceLen = marker.length;
      // An opening fence's info string may not contain the fence character
      // (CommonMark), which is how we avoid treating `` `code` `` as a fence.
      const info = fence[3] ?? '';
      if (!info.includes(fenceChar)) {
        flushText(lineNo - 1);
        const start = lineNo;
        const collected: string[] = [line];
        let j = i + 1;
        for (; j < lines.length; j++) {
          const candidate = lines[j] as string;
          collected.push(candidate);
          const close = /^\s*(`{3,}|~{3,})\s*$/.exec(candidate);
          if (
            close &&
            (close[1] as string)[0] === fenceChar &&
            (close[1] as string).length >= fenceLen
          ) {
            break;
          }
        }
        // An unterminated fence runs to end of document — same as CommonMark.
        blocks.push({
          kind: 'code',
          text: collected.join('\n'),
          startLine: start,
          endLine: lineOffset + Math.min(j, lines.length - 1) + 1,
        });
        i = j;
        bufferStart = lineOffset + i + 2;
        continue;
      }
    }

    // --- ATX heading -------------------------------------------------
    const atx = ATX.exec(line);
    if (atx) {
      flushText(lineNo - 1);
      blocks.push({
        kind: 'heading',
        level: (atx[1] as string).length,
        text: (atx[2] as string).trim(),
        startLine: lineNo,
        endLine: lineNo,
      });
      bufferStart = lineNo + 1;
      continue;
    }

    // --- setext heading ----------------------------------------------
    // Only valid when the buffer holds exactly one paragraph line and the
    // underline is not really a thematic break or a table separator.
    if ((SETEXT_H1.test(line) || SETEXT_H2.test(line)) && buffer.length > 0) {
      const candidate = buffer[buffer.length - 1] as string;
      const isParagraph =
        candidate.trim().length > 0 &&
        !LIST_ITEM.test(candidate) &&
        !TABLE_ROW.test(candidate) &&
        !BLOCKQUOTE.test(candidate);
      if (isParagraph) {
        buffer.pop();
        flushText(lineNo - 2);
        blocks.push({
          kind: 'heading',
          level: SETEXT_H1.test(line) ? 1 : 2,
          text: candidate.trim(),
          startLine: lineNo - 1,
          endLine: lineNo,
        });
        bufferStart = lineNo + 1;
        continue;
      }
    }

    // --- blank line: paragraph boundary, unless we are inside a loose list ---
    if (line.trim() === '') {
      if (buffer.length === 0) {
        bufferStart = lineNo + 1;
        continue;
      }
      const next = nextNonBlank(lines, i + 1);
      const inList = LIST_ITEM.test(lastNonBlank(buffer) ?? '');
      const nextIsList = next !== null && LIST_ITEM.test(next);
      const inTable = TABLE_ROW.test(lastNonBlank(buffer) ?? '');
      const nextIsTable = next !== null && TABLE_ROW.test(next);
      // Keep loose lists and multi-part tables in a single block: splitting a
      // bulleted CLI-flag reference into one chunk per bullet destroys context.
      if ((inList && nextIsList) || (inTable && nextIsTable)) {
        buffer.push('');
        continue;
      }
      flushText(lineNo - 1);
      bufferStart = lineNo + 1;
      continue;
    }

    if (THEMATIC_BREAK.test(line)) {
      flushText(lineNo - 1);
      bufferStart = lineNo + 1;
      continue;
    }

    if (buffer.length === 0) bufferStart = lineNo;
    buffer.push(line);
  }

  flushText(lineOffset + lines.length);
  return blocks;
}

function nextNonBlank(lines: string[], from: number): string | null {
  for (let i = from; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.trim() !== '') return line;
  }
  return null;
}

function lastNonBlank(buffer: string[]): string | null {
  for (let i = buffer.length - 1; i >= 0; i--) {
    const line = buffer[i] as string;
    if (line.trim() !== '') return line;
  }
  return null;
}
