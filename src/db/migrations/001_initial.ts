export const migration001 = `
-- Wallets
CREATE TABLE IF NOT EXISTS wallets (
  name TEXT PRIMARY KEY,
  address TEXT NOT NULL UNIQUE,
  file_path TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_wallets_address ON wallets(address);

-- Wallet labels (many-to-many tags)
CREATE TABLE IF NOT EXISTS wallet_labels (
  wallet_name TEXT NOT NULL REFERENCES wallets(name) ON DELETE CASCADE,
  label TEXT NOT NULL,
  PRIMARY KEY (wallet_name, label)
);
CREATE INDEX IF NOT EXISTS idx_wallet_labels_label ON wallet_labels(label);

-- Token metadata cache
CREATE TABLE IF NOT EXISTS token_cache (
  mint TEXT PRIMARY KEY,
  symbol TEXT,
  name TEXT,
  decimals INTEGER NOT NULL,
  logo_uri TEXT,
  tags TEXT,
  source TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_token_cache_symbol ON token_cache(symbol);

-- Price history
CREATE TABLE IF NOT EXISTS price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL,
  price_usd REAL NOT NULL,
  source TEXT NOT NULL,
  timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_price_history_mint ON price_history(mint);
CREATE INDEX IF NOT EXISTS idx_price_history_timestamp ON price_history(timestamp);

-- Snapshots
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS snapshot_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  wallet_name TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  mint TEXT NOT NULL,
  symbol TEXT,
  balance TEXT NOT NULL,
  price_usd REAL,
  value_usd REAL,
  position_type TEXT DEFAULT 'token',
  protocol TEXT,
  pool_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_snapshot_entries_snapshot ON snapshot_entries(snapshot_id);

-- Transaction log
CREATE TABLE IF NOT EXISTS transaction_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signature TEXT UNIQUE,
  type TEXT NOT NULL,
  wallet_name TEXT,
  from_mint TEXT,
  to_mint TEXT,
  from_amount TEXT,
  to_amount TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tx_log_signature ON transaction_log(signature);
CREATE INDEX IF NOT EXISTS idx_tx_log_wallet ON transaction_log(wallet_name);

-- Balance cache
CREATE TABLE IF NOT EXISTS balance_cache (
  wallet_address TEXT NOT NULL,
  mint TEXT NOT NULL,
  balance TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (wallet_address, mint)
);

-- Positions (for yield fee tracking)
CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_address TEXT NOT NULL,
  type TEXT NOT NULL,
  protocol TEXT NOT NULL,
  mint TEXT,
  pool_id TEXT,
  deposit_amount TEXT NOT NULL,
  deposit_value_usd REAL,
  deposit_tx TEXT,
  deposit_at TEXT NOT NULL,
  withdraw_amount TEXT,
  withdraw_value_usd REAL,
  withdraw_tx TEXT,
  withdraw_at TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  yield_fee_taken REAL DEFAULT 0,
  UNIQUE(deposit_tx)
);
CREATE INDEX IF NOT EXISTS idx_positions_wallet ON positions(wallet_address);
CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
`;
