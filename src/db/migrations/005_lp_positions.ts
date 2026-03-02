export const migration005 = `
CREATE TABLE IF NOT EXISTS lp_positions (
  position_id TEXT NOT NULL UNIQUE,
  pool_id TEXT NOT NULL,
  protocol TEXT NOT NULL,
  pool_type TEXT NOT NULL,
  wallet_name TEXT NOT NULL,
  mint_a TEXT NOT NULL,
  mint_b TEXT NOT NULL,
  symbol_a TEXT,
  symbol_b TEXT,
  deposit_amount_a REAL,
  deposit_amount_b REAL,
  deposit_price_a_usd REAL,
  deposit_price_b_usd REAL,
  deposit_value_usd REAL,
  deposit_signature TEXT,
  deposit_at TEXT,
  lower_price REAL,
  upper_price REAL,
  fees_claimed_a REAL DEFAULT 0,
  fees_claimed_b REAL DEFAULT 0,
  fees_claimed_usd REAL DEFAULT 0,
  farm_rewards_usd REAL DEFAULT 0,
  status TEXT DEFAULT 'open',
  withdraw_amount_a REAL,
  withdraw_amount_b REAL,
  withdraw_value_usd REAL,
  realized_pnl_usd REAL,
  close_signature TEXT,
  close_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_lp_positions_wallet
  ON lp_positions(wallet_name);
CREATE INDEX IF NOT EXISTS idx_lp_positions_pool
  ON lp_positions(pool_id);
CREATE INDEX IF NOT EXISTS idx_lp_positions_status
  ON lp_positions(status);
`;
