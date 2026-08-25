import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { sha256 } from '../util/hash.js';
import { parseFrontmatter } from './frontmatter.js';
import type { SourceDocument } from '../types.js';

export interface WalkOptions {
  extensions?: string[];
  /** Directory names skipped anywhere in the tree. */
  ignoreDirs?: string[];
}

const DEFAULT_IGNORE = ['node_modules', '.git', '.next', 'dist', 'build', '.docs-rag'];

/** Recursively collect markdown file paths, sorted for deterministic ingest order. */
export async function findMarkdownFiles(
  root: string,
  options: WalkOptions = {},
): Promise<string[]> {
  const extensions = options.extensions ?? ['.md', '.mdx'];
  const ignore = new Set(options.ignoreDirs ?? DEFAULT_IGNORE);
  const out: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.name.startsWith('.') && entry.isDirectory()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (ignore.has(entry.name)) continue;
        await walk(full);
      } else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
        out.push(full);
      }
    }
  }

  const rootStat = await stat(root);
  if (rootStat.isFile()) return [root];
  await walk(root);
  return out;
}

/** Read and parse one markdown file into a {@link SourceDocument}. */
export async function loadDocument(root: string, absolutePath: string): Promise<SourceDocument> {
  const raw = await readFile(absolutePath, 'utf8');
  const { data, body } = parseFrontmatter(raw);
  // Always use POSIX-style ids so an index built on Windows matches one built on Linux.
  const id = relative(root, absolutePath).split(sep).join('/');

  return {
    id,
    absolutePath,
    title: resolveTitle(data, body, id),
    frontmatter: data,
    body,
    contentHash: sha256(raw),
  };
}

function resolveTitle(frontmatter: Record<string, unknown>, body: string, id: string): string {
  const fromFrontmatter = frontmatter['title'];
  if (typeof fromFrontmatter === 'string' && fromFrontmatter.trim()) return fromFrontmatter.trim();

  const h1 = body.match(/^#\s+(.+?)\s*#*\s*$/m);
  if (h1?.[1]) return h1[1].trim();

  const base = id.split('/').pop() ?? id;
  return base.replace(/\.mdx?$/, '').replace(/[-_]/g, ' ');
}
