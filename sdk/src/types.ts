import type { Rpc, SolanaRpcApi, TransactionSigner, Instruction } from '@solana/kit';

// ── Logger ──────────────────────────────────────────────────

export interface Logger {
  verbose(msg: string): void;
  warn(msg: string): void;
}

// ── Config Provider ──────────────────────────────────────────

export interface ConfigProvider {
  get(key: string): unknown;
}

// ── Cache Provider ───────────────────────────────────────────

export interface PriceCacheEntry {
  mint: string;
  price_usd: number;
  source: string;
}

export interface TokenCacheEntry {
  mint: string;
  symbol: string | null;
  name: string | null;
  decimals: number;
  logo_uri: string | null;
  tags: string | null;
  source: string;
  updated_at: string;
}

export interface TokenUpsert {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  logo_uri: string | null;
  tags: string | null;
  source: string;
}

export interface TokenListCacheRow {
  mint: string;
  rank: number;
  price_usd: number | null;
  volume_24h_usd: number | null;
  metadata: string | null;
  fetched_at?: string;
}

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

export interface CacheProvider {
  // Price cache
  getLatestPrice(mint: string): PriceCacheEntry | undefined;
  insertPrice(mint: string, priceUsd: number, source: string): void;

  // Token cache
  getTokenByMint(mint: string): TokenCacheEntry | undefined;
  getTokenBySymbol(symbol: string): TokenCacheEntry[];
  isTokenCacheStale(mint: string, ttlHours?: number): boolean;
  upsertTokenBatch(tokens: TokenUpsert[]): void;

  // Optional capabilities — token lists
  getTokenList?(category: string, interval: string | null): TokenListCacheRow[];
  replaceTokenList?(category: string, interval: string | null, entries: Omit<TokenListCacheRow, 'fetched_at'>[]): void;
  isTokenListStale?(category: string, interval: string | null, ttlMinutes: number): boolean;

  // Optional capabilities — snapshots
  createSnapshot?(label?: string): number;
  insertSnapshotEntry?(entry: Omit<SnapshotEntryRow, 'id'>): void;
  getSnapshotEntries?(snapshotId: number): SnapshotEntryRow[];
  getSnapshot?(id: number): SnapshotRow | undefined;
  getLatestSnapshot?(): SnapshotRow | undefined;
  listSnapshots?(limit: number): SnapshotRow[];
}

// ── Transaction Logger ──────────────────────────────────────

export interface TxLogEntry {
  signature: string;
  type: string;
  walletName?: string;
  fromMint?: string;
  toMint?: string;
  fromAmount?: string;
  toAmount?: string;
  fromPriceUsd?: number;
  toPriceUsd?: number;
  status: string;
  error?: string;
}

export interface TransactionLogger {
  log(entry: TxLogEntry): void;
  updateStatus(signature: string, status: string, error?: string): void;
}

// ── Signer Provider ─────────────────────────────────────────

export interface SignerProvider {
  getSigner(identifier: string): Promise<TransactionSigner>;
  getAddress(identifier: string): Promise<string>;
  /** Raw keypair bytes for v1 compat (MarginFi oracle crank). Optional. */
  getRawBytes?(identifier: string): Uint8Array;
}

// ── Sol Context ─────────────────────────────────────────────

export interface SolContext {
  rpc: Rpc<SolanaRpcApi>;
  /** RPC endpoint URL string. Needed by v1 compat providers (MarginFi, Drift). */
  rpcUrl?: string;
  logger: Logger;
  config: ConfigProvider;
  cache: CacheProvider;
  txLogger: TransactionLogger;
  signer: SignerProvider;
  /** Optional instruction appended to every transaction for on-chain analytics. */
  analyticsInstruction?: () => Instruction | null;
}

// ── SDK Options (for createSolSdk) ──────────────────────────

export interface SolSdkOptions {
  rpc: Rpc<SolanaRpcApi>;
  /** RPC endpoint URL string. Needed by v1 compat providers (MarginFi, Drift). */
  rpcUrl?: string;
  logger?: Logger;
  config?: ConfigProvider;
  cache?: CacheProvider;
  txLogger?: TransactionLogger;
  signer: SignerProvider;
  analyticsInstruction?: () => Instruction | null;
}

// ── Send Result ─────────────────────────────────────────────

export interface SendResult {
  signature: string;
  status: string;
  attempts: number;
  elapsed_ms: number;
  explorerUrl: string;
}
