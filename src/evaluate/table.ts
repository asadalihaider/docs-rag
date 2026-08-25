export type Alignment = 'left' | 'right';

export interface Column {
  header: string;
  align?: Alignment;
}

/** Render a fixed-width ASCII table. Used by `docs-rag eval` and `docs-rag stats`. */
export function renderTable(columns: Column[], rows: string[][]): string {
  const widths = columns.map((column, index) =>
    Math.max(column.header.length, ...rows.map((row) => (row[index] ?? '').length)),
  );

  const pad = (text: string, width: number, align: Alignment) =>
    align === 'right' ? text.padStart(width) : text.padEnd(width);

  const line = (cells: string[]) =>
    '| ' +
    cells.map((cell, i) => pad(cell, widths[i] ?? 0, columns[i]?.align ?? 'left')).join(' | ') +
    ' |';

  const divider =
    '|' +
    widths
      .map((w, i) => {
        const bar = '-'.repeat(w + 2);
        return columns[i]?.align === 'right' ? bar.slice(0, -1) + ':' : bar;
      })
      .join('|') +
    '|';

  return [line(columns.map((c) => c.header)), divider, ...rows.map(line)].join('\n');
}

export function percent(value: number | null, digits = 1): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(digits)}%`;
}

export function fixed(value: number | null, digits = 3): string {
  return value === null ? 'n/a' : value.toFixed(digits);
}
