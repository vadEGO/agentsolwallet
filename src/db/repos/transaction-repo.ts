import { getDb } from '../database.js';

export interface TransactionRow {
  id: number;
  signature: string;
  type: string;
  wallet_name: string | null;
  from_mint: string | null;
  to_mint: string | null;
  from_amount: string | null;
  to_amount: string | null;
  from_price_usd: number | null;
  to_price_usd: number | null;
  status: string;
  error: string | null;
  created_at: string;
}

export function getRecentTransactions(opts: {
  walletName?: string;
  type?: string;
  limit?: number;
} = {}): TransactionRow[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.walletName) {
    conditions.push('wallet_name = ?');
    params.push(opts.walletName);
  }
  if (opts.type) {
    conditions.push('type = ?');
    params.push(opts.type);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = opts.limit ?? 20;

  return getDb().prepare(
    `SELECT * FROM transaction_log ${where} ORDER BY created_at DESC LIMIT ?`
  ).all(...params, limit) as TransactionRow[];
}

export function getTransactionBySignature(signature: string): TransactionRow | undefined {
  return getDb().prepare(
    'SELECT * FROM transaction_log WHERE signature = ?'
  ).get(signature) as TransactionRow | undefined;
}

export function upsertTransaction(row: Omit<TransactionRow, 'id'>): void {
  getDb().prepare(`
    INSERT INTO transaction_log
      (signature, type, wallet_name, from_mint, to_mint, from_amount, to_amount, from_price_usd, to_price_usd, status, error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(signature) DO UPDATE SET
      type = excluded.type,
      wallet_name = COALESCE(excluded.wallet_name, transaction_log.wallet_name),
      from_mint = COALESCE(transaction_log.from_mint, excluded.from_mint),
      to_mint = COALESCE(transaction_log.to_mint, excluded.to_mint),
      from_amount = COALESCE(transaction_log.from_amount, excluded.from_amount),
      to_amount = COALESCE(transaction_log.to_amount, excluded.to_amount),
      from_price_usd = COALESCE(transaction_log.from_price_usd, excluded.from_price_usd),
      to_price_usd = COALESCE(transaction_log.to_price_usd, excluded.to_price_usd),
      status = excluded.status,
      error = excluded.error,
      created_at = excluded.created_at
  `).run(
    row.signature,
    row.type,
    row.wallet_name,
    row.from_mint,
    row.to_mint,
    row.from_amount,
    row.to_amount,
    row.from_price_usd,
    row.to_price_usd,
    row.status,
    row.error,
    row.created_at,
  );
}

export function getTransactionCount(walletName?: string): number {
  if (walletName) {
    const row = getDb().prepare(
      'SELECT COUNT(*) as count FROM transaction_log WHERE wallet_name = ?'
    ).get(walletName) as { count: number };
    return row.count;
  }
  const row = getDb().prepare('SELECT COUNT(*) as count FROM transaction_log').get() as { count: number };
  return row.count;
}
