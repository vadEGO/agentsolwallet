export const migration003 = `
CREATE TABLE IF NOT EXISTS token_list_cache (
  category TEXT NOT NULL,
  interval TEXT,
  mint TEXT NOT NULL,
  rank INTEGER NOT NULL,
  price_usd REAL,
  volume_24h_usd REAL,
  metadata TEXT,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_token_list_cache_lookup
  ON token_list_cache(category, interval, fetched_at);
`;
