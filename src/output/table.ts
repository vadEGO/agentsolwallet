export interface Column {
  key: string;
  header: string;
  align?: 'left' | 'right';
  width?: number;
  format?: (value: unknown) => string;
}

export interface TableOptions {
  /** Stretch the table to at least this width by distributing extra space between columns */
  minWidth?: number;
}

export function table(rows: Record<string, unknown>[], columns: Column[], opts?: TableOptions): string {
  if (rows.length === 0) return '(no data)';

  const formatted = rows.map(row =>
    columns.map(col => {
      const val = row[col.key];
      return col.format ? col.format(val) : String(val ?? '');
    })
  );

  const widths = columns.map((col, i) => {
    const dataMax = formatted.reduce((max, row) => Math.max(max, row[i].length), 0);
    return Math.max(col.header.length, col.width ?? 0, dataMax);
  });

  // Compute gap between columns — default 2, expanded to fill minWidth
  const numGaps = columns.length - 1;
  const contentWidth = widths.reduce((s, w) => s + w, 0);
  const naturalWidth = contentWidth + numGaps * 2;
  const targetWidth = Math.max(naturalWidth, opts?.minWidth ?? 0);

  let gapStr: string;
  if (numGaps > 0 && targetWidth > naturalWidth) {
    const totalGapSpace = targetWidth - contentWidth;
    const baseGap = Math.floor(totalGapSpace / numGaps);
    const remainder = totalGapSpace - baseGap * numGaps;
    // Build gaps — distribute remainder one extra space to the first N gaps
    gapStr = ''; // won't use a single string, need per-gap
  }

  // Per-gap widths for even distribution
  const gaps: number[] = [];
  if (numGaps > 0) {
    const totalGapSpace = targetWidth - contentWidth;
    const baseGap = Math.floor(totalGapSpace / numGaps);
    const remainder = totalGapSpace - baseGap * numGaps;
    for (let i = 0; i < numGaps; i++) {
      gaps.push(baseGap + (i < remainder ? 1 : 0));
    }
  }

  function joinRow(cells: string[]): string {
    return cells.map((cell, i) => i < cells.length - 1 ? cell + ' '.repeat(gaps[i]) : cell).join('');
  }

  const header = joinRow(columns.map((col, i) => pad(col.header, widths[i], col.align)));
  const separator = '─'.repeat(targetWidth);

  const body = formatted.map(row =>
    joinRow(columns.map((col, i) => pad(row[i], widths[i], col.align)))
  ).join('\n');

  return `${header}\n${separator}\n${body}`;
}

function pad(str: string, width: number, align: 'left' | 'right' = 'left'): string {
  if (align === 'right') return str.padStart(width);
  return str.padEnd(width);
}
