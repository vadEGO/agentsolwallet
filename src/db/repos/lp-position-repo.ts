import { getDb } from '../database.js';

export interface LpPositionRow {
  position_id: string;
  pool_id: string;
  protocol: string;
  pool_type: string;
  wallet_name: string;
  mint_a: string;
  mint_b: string;
  symbol_a: string | null;
  symbol_b: string | null;
  deposit_amount_a: number | null;
  deposit_amount_b: number | null;
  deposit_price_a_usd: number | null;
  deposit_price_b_usd: number | null;
  deposit_value_usd: number | null;
  deposit_signature: string | null;
  deposit_at: string | null;
  lower_price: number | null;
  upper_price: number | null;
  fees_claimed_a: number;
  fees_claimed_b: number;
  fees_claimed_usd: number;
  farm_rewards_usd: number;
  status: string;
  withdraw_amount_a: number | null;
  withdraw_amount_b: number | null;
  withdraw_value_usd: number | null;
  realized_pnl_usd: number | null;
  close_signature: string | null;
  close_at: string | null;
}

export function insertPosition(entry: {
  position_id: string;
  pool_id: string;
  protocol: string;
  pool_type: string;
  wallet_name: string;
  mint_a: string;
  mint_b: string;
  symbol_a?: string;
  symbol_b?: string;
  deposit_amount_a?: number;
  deposit_amount_b?: number;
  deposit_price_a_usd?: number;
  deposit_price_b_usd?: number;
  deposit_value_usd?: number;
  deposit_signature?: string;
  lower_price?: number;
  upper_price?: number;
}): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO lp_positions
      (position_id, pool_id, protocol, pool_type, wallet_name,
       mint_a, mint_b, symbol_a, symbol_b,
       deposit_amount_a, deposit_amount_b, deposit_price_a_usd, deposit_price_b_usd,
       deposit_value_usd, deposit_signature, deposit_at,
       lower_price, upper_price)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)
  `).run(
    entry.position_id, entry.pool_id, entry.protocol, entry.pool_type, entry.wallet_name,
    entry.mint_a, entry.mint_b, entry.symbol_a ?? null, entry.symbol_b ?? null,
    entry.deposit_amount_a ?? null, entry.deposit_amount_b ?? null,
    entry.deposit_price_a_usd ?? null, entry.deposit_price_b_usd ?? null,
    entry.deposit_value_usd ?? null, entry.deposit_signature ?? null,
    entry.lower_price ?? null, entry.upper_price ?? null,
  );
}

export function getPosition(positionId: string): LpPositionRow | undefined {
  return getDb().prepare(
    'SELECT * FROM lp_positions WHERE position_id = ?'
  ).get(positionId) as LpPositionRow | undefined;
}

export function getOpenPositions(walletName?: string): LpPositionRow[] {
  if (walletName) {
    return getDb().prepare(
      'SELECT * FROM lp_positions WHERE wallet_name = ? AND status = ? ORDER BY deposit_at DESC'
    ).all(walletName, 'open') as LpPositionRow[];
  }
  return getDb().prepare(
    'SELECT * FROM lp_positions WHERE status = ? ORDER BY deposit_at DESC'
  ).all('open') as LpPositionRow[];
}

export function updateFeeClaim(
  positionId: string,
  feesA: number,
  feesB: number,
  feesUsd: number,
): boolean {
  const result = getDb().prepare(`
    UPDATE lp_positions
    SET fees_claimed_a = fees_claimed_a + ?,
        fees_claimed_b = fees_claimed_b + ?,
        fees_claimed_usd = fees_claimed_usd + ?
    WHERE position_id = ?
  `).run(feesA, feesB, feesUsd, positionId);
  return result.changes > 0;
}

export function updateFarmRewards(positionId: string, rewardsUsd: number): boolean {
  const result = getDb().prepare(`
    UPDATE lp_positions
    SET farm_rewards_usd = farm_rewards_usd + ?
    WHERE position_id = ?
  `).run(rewardsUsd, positionId);
  return result.changes > 0;
}

export function updatePartialWithdraw(positionId: string, percent: number): boolean {
  const factor = 1 - percent / 100;
  const result = getDb().prepare(`
    UPDATE lp_positions
    SET deposit_amount_a = deposit_amount_a * ?,
        deposit_amount_b = deposit_amount_b * ?,
        deposit_value_usd = deposit_value_usd * ?
    WHERE position_id = ?
  `).run(factor, factor, factor, positionId);
  return result.changes > 0;
}

export function closePosition(
  positionId: string,
  withdrawAmountA: number,
  withdrawAmountB: number,
  withdrawValueUsd: number,
  realizedPnlUsd: number,
  closeSignature: string,
): boolean {
  const result = getDb().prepare(`
    UPDATE lp_positions
    SET status = 'closed',
        withdraw_amount_a = ?,
        withdraw_amount_b = ?,
        withdraw_value_usd = ?,
        realized_pnl_usd = ?,
        close_signature = ?,
        close_at = datetime('now')
    WHERE position_id = ?
  `).run(withdrawAmountA, withdrawAmountB, withdrawValueUsd, realizedPnlUsd, closeSignature, positionId);
  return result.changes > 0;
}
