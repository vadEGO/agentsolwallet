import { getDb } from '../database.js';

export interface TokenRow {
  mint: string;
  symbol: string | null;
  name: string | null;
  decimals: number;
  logo_uri: string | null;
  tags: string | null;
  source: string;
  updated_at: string;
}

export function upsertToken(token: Omit<TokenRow, 'updated_at'>): void {
  getDb().prepare(`
    INSERT INTO token_cache (mint, symbol, name, decimals, logo_uri, tags, source, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(mint) DO UPDATE SET
      symbol = excluded.symbol,
      name = excluded.name,
      decimals = excluded.decimals,
      logo_uri = excluded.logo_uri,
      tags = excluded.tags,
      source = excluded.source,
      updated_at = datetime('now')
  `).run(token.mint, token.symbol, token.name, token.decimals, token.logo_uri, token.tags, token.source);
}

export function upsertTokenBatch(tokens: Omit<TokenRow, 'updated_at'>[]): void {
  const stmt = getDb().prepare(`
    INSERT INTO token_cache (mint, symbol, name, decimals, logo_uri, tags, source, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(mint) DO UPDATE SET
      symbol = excluded.symbol,
      name = excluded.name,
      decimals = excluded.decimals,
      logo_uri = excluded.logo_uri,
      tags = excluded.tags,
      source = excluded.source,
      updated_at = datetime('now')
  `);
  const tx = getDb().transaction((items: typeof tokens) => {
    for (const t of items) {
      stmt.run(t.mint, t.symbol, t.name, t.decimals, t.logo_uri, t.tags, t.source);
    }
  });
  tx(tokens);
}

export function getTokenByMint(mint: string): TokenRow | undefined {
  return getDb().prepare('SELECT * FROM token_cache WHERE mint = ?').get(mint) as TokenRow | undefined;
}

export function getTokenBySymbol(symbol: string): TokenRow[] {
  return getDb().prepare(
    'SELECT * FROM token_cache WHERE UPPER(symbol) = UPPER(?) ORDER BY updated_at DESC'
  ).all(symbol) as TokenRow[];
}

export function searchTokens(query: string): TokenRow[] {
  const like = `%${query}%`;
  return getDb().prepare(
    'SELECT * FROM token_cache WHERE UPPER(symbol) LIKE UPPER(?) OR UPPER(name) LIKE UPPER(?) ORDER BY symbol LIMIT 20'
  ).all(like, like) as TokenRow[];
}

export function getAllTokens(): TokenRow[] {
  return getDb().prepare('SELECT * FROM token_cache ORDER BY symbol').all() as TokenRow[];
}

export function isTokenCacheStale(mint: string, ttlHours = 24): boolean {
  const row = getDb().prepare(
    "SELECT updated_at FROM token_cache WHERE mint = ? AND datetime(updated_at, '+' || ? || ' hours') > datetime('now')"
  ).get(mint, ttlHours) as { updated_at: string } | undefined;
  return !row;
}
