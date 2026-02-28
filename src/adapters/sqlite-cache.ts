import type {
  CacheProvider, PriceCacheEntry, TokenCacheEntry, TokenUpsert,
  TokenListCacheRow, SnapshotRow, SnapshotEntryRow,
} from '@solana-compass/sdk';
import * as priceRepo from '../db/repos/price-repo.js';
import * as tokenRepo from '../db/repos/token-repo.js';
import * as tokenListRepo from '../db/repos/token-list-repo.js';
import * as snapshotRepo from '../db/repos/snapshot-repo.js';

export class SqliteCache implements CacheProvider {
  // ── Price cache ─────────────────────────────────────────

  getLatestPrice(mint: string): PriceCacheEntry | undefined {
    const row = priceRepo.getLatestPrice(mint);
    if (!row) return undefined;
    return { mint: row.mint, price_usd: row.price_usd, source: row.source };
  }

  insertPrice(mint: string, priceUsd: number, source: string): void {
    priceRepo.insertPrice(mint, priceUsd, source);
  }

  // ── Token cache ─────────────────────────────────────────

  getTokenByMint(mint: string): TokenCacheEntry | undefined {
    return tokenRepo.getTokenByMint(mint) as TokenCacheEntry | undefined;
  }

  getTokenBySymbol(symbol: string): TokenCacheEntry[] {
    return tokenRepo.getTokenBySymbol(symbol) as TokenCacheEntry[];
  }

  isTokenCacheStale(mint: string, ttlHours?: number): boolean {
    return tokenRepo.isTokenCacheStale(mint, ttlHours);
  }

  upsertTokenBatch(tokens: TokenUpsert[]): void {
    tokenRepo.upsertTokenBatch(tokens);
  }

  // ── Token lists ─────────────────────────────────────────

  getTokenList(category: string, interval: string | null): TokenListCacheRow[] {
    return tokenListRepo.getList(category, interval).map(row => ({
      mint: row.mint,
      rank: row.rank,
      price_usd: row.price_usd,
      volume_24h_usd: row.volume_24h_usd,
      metadata: row.metadata,
      fetched_at: row.fetched_at,
    }));
  }

  replaceTokenList(category: string, interval: string | null, entries: Omit<TokenListCacheRow, 'fetched_at'>[]): void {
    tokenListRepo.replaceList(category, interval, entries);
  }

  isTokenListStale(category: string, interval: string | null, ttlMinutes: number): boolean {
    return tokenListRepo.isListStale(category, interval, ttlMinutes);
  }

  // ── Snapshots ───────────────────────────────────────────

  createSnapshot(label?: string): number {
    return snapshotRepo.createSnapshot(label);
  }

  insertSnapshotEntry(entry: Omit<SnapshotEntryRow, 'id'>): void {
    snapshotRepo.insertSnapshotEntry(entry);
  }

  getSnapshotEntries(snapshotId: number): SnapshotEntryRow[] {
    return snapshotRepo.getSnapshotEntries(snapshotId) as SnapshotEntryRow[];
  }

  getSnapshot(id: number): SnapshotRow | undefined {
    return snapshotRepo.getSnapshot(id) as SnapshotRow | undefined;
  }

  getLatestSnapshot(): SnapshotRow | undefined {
    return snapshotRepo.getLatestSnapshot() as SnapshotRow | undefined;
  }

  listSnapshots(limit: number): SnapshotRow[] {
    return snapshotRepo.listSnapshots(limit) as SnapshotRow[];
  }
}
