/** Collapse runs of whitespace, trim. Used for excerpts and display. */
export function squish(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Truncate on a word boundary, appending an ellipsis when text was removed. */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(' ');
  return (lastSpace > maxChars * 0.6 ? slice.slice(0, lastSpace) : slice).trimEnd() + '…';
}

/**
 * Split prose into sentences.
 *
 * Deliberately simple and abbreviation-aware only for the abbreviations that
 * actually show up in technical docs (`e.g.`, `i.e.`, `vs.`, `etc.`). Markdown
 * list items and headings are treated as sentence boundaries in their own right,
 * because in documentation a bullet is usually a complete statement.
 */
export function splitSentences(text: string): string[] {
  const protectedText = text
    .replace(/\be\.g\./gi, 'e␟g␟')
    .replace(/\bi\.e\./gi, 'i␟e␟')
    .replace(/\bvs\./gi, 'vs␟')
    .replace(/\betc\./gi, 'etc␟');

  const out: string[] = [];
  for (const line of protectedText.split(/\n+/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Strip list bullets and heading markers before splitting.
    const cleaned = trimmed.replace(/^(?:[-*+]\s+|\d+\.\s+|#{1,6}\s+|>\s+)/, '');
    for (const part of cleaned.split(/(?<=[.!?])\s+(?=[A-Z(`[])/)) {
      const sentence = part.replace(/␟/g, '.').trim();
      if (sentence.length > 0) out.push(sentence);
    }
  }
  return out;
}

/** Render a heading path for display: `Installation > Docker`. */
export function renderHeadingPath(path: readonly string[]): string {
  return path.join(' > ');
}
