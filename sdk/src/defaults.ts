import type {
  Logger,
  TransactionLogger,
  ConfigProvider,
  CacheProvider,
  PriceCacheEntry,
  TokenCacheEntry,
  TokenUpsert,
  TxLogEntry,
} from './types.js';

// ── NoopLogger ──────────────────────────────────────────────

export class NoopLogger implements Logger {
  verbose(_msg: string): void {}
  warn(_msg: string): void {}
}

// ── NoopTransactionLogger ───────────────────────────────────

export class NoopTransactionLogger implements TransactionLogger {
  log(_entry: TxLogEntry): void {}
  updateStatus(_signature: string, _status: string, _error?: string): void {}
}

// ── InMemoryConfig ──────────────────────────────────────────

export class InMemoryConfig implements ConfigProvider {
  private data: Record<string, unknown>;

  constructor(data: Record<string, unknown> = {}) {
    this.data = data;
  }

  get(key: string): unknown {
    // Support dot-notation: 'api.jupiterApiKey'
    const parts = key.split('.');
    let current: unknown = this.data;
    for (const part of parts) {
      if (current == null || typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }
}

// ── InMemoryCache ───────────────────────────────────────────

export class InMemoryCache implements CacheProvider {
  private prices = new Map<string, PriceCacheEntry>();
  private tokens = new Map<string, TokenCacheEntry>();
  private tokensBySymbol = new Map<string, TokenCacheEntry[]>();

  getLatestPrice(mint: string): PriceCacheEntry | undefined {
    return this.prices.get(mint);
  }

  insertPrice(mint: string, priceUsd: number, source: string): void {
    this.prices.set(mint, { mint, price_usd: priceUsd, source });
  }

  getTokenByMint(mint: string): TokenCacheEntry | undefined {
    return this.tokens.get(mint);
  }

  getTokenBySymbol(symbol: string): TokenCacheEntry[] {
    return this.tokensBySymbol.get(symbol.toUpperCase()) ?? [];
  }

  isTokenCacheStale(_mint: string, _ttlHours?: number): boolean {
    return true; // In-memory cache doesn't track timestamps
  }

  upsertTokenBatch(tokens: TokenUpsert[]): void {
    for (const t of tokens) {
      const entry: TokenCacheEntry = {
        mint: t.mint,
        symbol: t.symbol,
        name: t.name,
        decimals: t.decimals,
        logo_uri: t.logo_uri,
        tags: t.tags,
        source: t.source,
        updated_at: new Date().toISOString(),
      };
      this.tokens.set(t.mint, entry);
      if (t.symbol) {
        const key = t.symbol.toUpperCase();
        const existing = this.tokensBySymbol.get(key) ?? [];
        const idx = existing.findIndex(e => e.mint === t.mint);
        if (idx >= 0) {
          existing[idx] = entry;
        } else {
          existing.push(entry);
        }
        this.tokensBySymbol.set(key, existing);
      }
    }
  }
}
