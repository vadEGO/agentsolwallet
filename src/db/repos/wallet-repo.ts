import { getDb } from '../database.js';

export interface WalletRow {
  name: string;
  address: string;
  file_path: string;
  created_at: string;
  updated_at: string;
}

export function insertWallet(name: string, address: string, filePath: string): void {
  getDb().prepare(
    'INSERT INTO wallets (name, address, file_path) VALUES (?, ?, ?)'
  ).run(name, address, filePath);
}

export function getWallet(name: string): WalletRow | undefined {
  return getDb().prepare('SELECT * FROM wallets WHERE name = ?').get(name) as WalletRow | undefined;
}

export function getWalletByAddress(address: string): WalletRow | undefined {
  return getDb().prepare('SELECT * FROM wallets WHERE address = ?').get(address) as WalletRow | undefined;
}

export function listWallets(): WalletRow[] {
  return getDb().prepare('SELECT * FROM wallets ORDER BY created_at').all() as WalletRow[];
}

export function listWalletsByLabel(label: string): WalletRow[] {
  return getDb().prepare(`
    SELECT w.* FROM wallets w
    JOIN wallet_labels wl ON w.name = wl.wallet_name
    WHERE wl.label = ?
    ORDER BY w.created_at
  `).all(label) as WalletRow[];
}

export function removeWallet(name: string): boolean {
  const result = getDb().prepare('DELETE FROM wallets WHERE name = ?').run(name);
  return result.changes > 0;
}

export function addLabel(walletName: string, label: string): void {
  getDb().prepare(
    'INSERT OR IGNORE INTO wallet_labels (wallet_name, label) VALUES (?, ?)'
  ).run(walletName, label);
}

export function removeLabel(walletName: string, label: string): void {
  getDb().prepare(
    'DELETE FROM wallet_labels WHERE wallet_name = ? AND label = ?'
  ).run(walletName, label);
}

export function getLabels(walletName: string): string[] {
  const rows = getDb().prepare(
    'SELECT label FROM wallet_labels WHERE wallet_name = ? ORDER BY label'
  ).all(walletName) as { label: string }[];
  return rows.map(r => r.label);
}

export function walletCount(): number {
  const row = getDb().prepare('SELECT COUNT(*) as count FROM wallets').get() as { count: number };
  return row.count;
}

export function getDefaultWalletName(): string | undefined {
  const row = getDb().prepare('SELECT name FROM wallets ORDER BY created_at LIMIT 1').get() as { name: string } | undefined;
  return row?.name;
}
