import { getDb } from '../database.js';

export interface TokenListRow {
  category: string;
  interval: string | null;
  mint: string;
  rank: number;
  price_usd: number | null;
  volume_24h_usd: number | null;
  metadata: string | null;
  fetched_at: string;
}

export function isListStale(category: string, interval: string | null, ttlMinutes: number): boolean {
  const row = getDb().prepare(
    `SELECT fetched_at FROM token_list_cache
     WHERE category = ? AND (interval IS ? OR (interval IS NULL AND ? IS NULL))
     ORDER BY fetched_at DESC LIMIT 1`
  ).get(category, interval, interval) as { fetched_at: string } | undefined;

  if (!row) return true;

  const age = Date.now() - new Date(row.fetched_at + 'Z').getTime();
  return age > ttlMinutes * 60_000;
}

export function getList(category: string, interval: string | null): TokenListRow[] {
  return getDb().prepare(
    `SELECT * FROM token_list_cache
     WHERE category = ? AND (interval IS ? OR (interval IS NULL AND ? IS NULL))
     ORDER BY rank ASC`
  ).all(category, interval, interval) as TokenListRow[];
}

export function replaceList(category: string, interval: string | null, entries: Omit<TokenListRow, 'category' | 'interval' | 'fetched_at'>[]): void {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(
      `DELETE FROM token_list_cache
       WHERE category = ? AND (interval IS ? OR (interval IS NULL AND ? IS NULL))`
    ).run(category, interval, interval);

    const stmt = db.prepare(
      `INSERT INTO token_list_cache (category, interval, mint, rank, price_usd, volume_24h_usd, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    for (const e of entries) {
      stmt.run(category, interval, e.mint, e.rank, e.price_usd, e.volume_24h_usd, e.metadata);
    }
  });
  tx();
}
