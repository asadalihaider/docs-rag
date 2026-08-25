import { parse as parseYaml } from 'yaml';

export interface Frontmatter {
  data: Record<string, unknown>;
  body: string;
  /** Number of lines consumed by the frontmatter block, for line-number fidelity. */
  offsetLines: number;
}

const FENCE = /^---[ \t]*\r?$|^---[ \t]*$/;

/**
 * Parse a YAML frontmatter block.
 *
 * Only a block that starts on the very first line counts — a `---` further down
 * the file is a thematic break, not frontmatter. Malformed YAML is treated as
 * "no frontmatter" rather than a hard failure, because one bad file should not
 * abort an ingest of a hundred.
 */
export function parseFrontmatter(source: string): Frontmatter {
  const text = source.startsWith('﻿') ? source.slice(1) : source;
  const lines = text.split('\n');
  if (lines.length === 0 || !FENCE.test(lines[0] ?? '')) {
    return { data: {}, body: text, offsetLines: 0 };
  }

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (FENCE.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  if (end === -1) return { data: {}, body: text, offsetLines: 0 };

  const raw = lines.slice(1, end).join('\n');
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = parseYaml(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    data = {};
  }

  return {
    data,
    body: lines.slice(end + 1).join('\n'),
    offsetLines: end + 1,
  };
}
