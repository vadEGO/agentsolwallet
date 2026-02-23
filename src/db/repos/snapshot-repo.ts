import { getDb } from '../database.js';

export interface SnapshotRow {
  id: number;
  label: string | null;
  created_at: string;
}

export interface SnapshotEntryRow {
  id: number;
  snapshot_id: number;
  wallet_name: string;
  wallet_address: string;
  mint: string;
  symbol: string | null;
  balance: string;
  price_usd: number | null;
  value_usd: number | null;
  position_type: string;
  protocol: string | null;
  pool_id: string | null;
}

export function createSnapshot(label?: string): number {
  const result = getDb().prepare(
    'INSERT INTO snapshots (label) VALUES (?)'
  ).run(label ?? null);
  return Number(result.lastInsertRowid);
}

export function insertSnapshotEntry(entry: Omit<SnapshotEntryRow, 'id'>): void {
  getDb().prepare(`
    INSERT INTO snapshot_entries
      (snapshot_id, wallet_name, wallet_address, mint, symbol, balance, price_usd, value_usd, position_type, protocol, pool_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.snapshot_id, entry.wallet_name, entry.wallet_address,
    entry.mint, entry.symbol, entry.balance, entry.price_usd, entry.value_usd,
    entry.position_type, entry.protocol, entry.pool_id
  );
}

export function getSnapshot(id: number): SnapshotRow | undefined {
  return getDb().prepare('SELECT * FROM snapshots WHERE id = ?').get(id) as SnapshotRow | undefined;
}

export function listSnapshots(limit = 50): SnapshotRow[] {
  return getDb().prepare('SELECT * FROM snapshots ORDER BY created_at DESC LIMIT ?').all(limit) as SnapshotRow[];
}

export function getSnapshotEntries(snapshotId: number): SnapshotEntryRow[] {
  return getDb().prepare(
    'SELECT * FROM snapshot_entries WHERE snapshot_id = ? ORDER BY wallet_name, symbol'
  ).all(snapshotId) as SnapshotEntryRow[];
}

export function deleteSnapshot(id: number): boolean {
  const result = getDb().prepare('DELETE FROM snapshots WHERE id = ?').run(id);
  return result.changes > 0;
}

export function getLatestSnapshot(): SnapshotRow | undefined {
  return getDb().prepare('SELECT * FROM snapshots ORDER BY created_at DESC LIMIT 1').get() as SnapshotRow | undefined;
}

export function getSnapshotBefore(timestamp: string): SnapshotRow | undefined {
  return getDb().prepare(
    'SELECT * FROM snapshots WHERE created_at <= ? ORDER BY created_at DESC LIMIT 1'
  ).get(timestamp) as SnapshotRow | undefined;
}
