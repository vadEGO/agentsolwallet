import { getDb } from '../database.js';

export interface PriceRow {
  id: number;
  mint: string;
  price_usd: number;
  source: string;
  timestamp: string;
}

export function insertPrice(mint: string, priceUsd: number, source: string): void {
  getDb().prepare(
    'INSERT INTO price_history (mint, price_usd, source) VALUES (?, ?, ?)'
  ).run(mint, priceUsd, source);
}

export function getLatestPrice(mint: string): PriceRow | undefined {
  return getDb().prepare(
    'SELECT * FROM price_history WHERE mint = ? ORDER BY timestamp DESC LIMIT 1'
  ).get(mint) as PriceRow | undefined;
}

export function getPriceAt(mint: string, timestamp: string): PriceRow | undefined {
  return getDb().prepare(
    'SELECT * FROM price_history WHERE mint = ? AND timestamp <= ? ORDER BY timestamp DESC LIMIT 1'
  ).get(mint, timestamp) as PriceRow | undefined;
}

export function getPriceHistory(mint: string, limit = 100): PriceRow[] {
  return getDb().prepare(
    'SELECT * FROM price_history WHERE mint = ? ORDER BY timestamp DESC LIMIT ?'
  ).all(mint, limit) as PriceRow[];
}
