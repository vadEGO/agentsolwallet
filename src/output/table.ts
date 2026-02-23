export interface Column {
  key: string;
  header: string;
  align?: 'left' | 'right';
  width?: number;
  format?: (value: unknown) => string;
}

export function table(rows: Record<string, unknown>[], columns: Column[]): string {
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

  const header = columns.map((col, i) => pad(col.header, widths[i], col.align)).join('  ');
  const separator = widths.map(w => '─'.repeat(w)).join('──');

  const body = formatted.map(row =>
    columns.map((col, i) => pad(row[i], widths[i], col.align)).join('  ')
  ).join('\n');

  return `${header}\n${separator}\n${body}`;
}

function pad(str: string, width: number, align: 'left' | 'right' = 'left'): string {
  if (align === 'right') return str.padStart(width);
  return str.padEnd(width);
}
