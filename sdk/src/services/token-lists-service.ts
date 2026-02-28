import { getJupiterBaseUrl, getJupiterHeaders } from '../utils/jupiter-api.js';
import { withRetry, isRetryableHttpError, RateLimiter } from '../utils/retry.js';
import type { SolContext } from '../types.js';

export interface TokenListEntry {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  logoUri?: string;
  priceUsd?: number;
  volume24hUsd?: number;
  change24hPct?: number;
  metadata?: Record<string, unknown>;
}

export interface CategoryInfo {
  id: string;
  label: string;
  description: string;
  supportsInterval: boolean;
}

export interface TokenListsService {
  getCategories(): CategoryInfo[];
  browseTokens(category: string, opts?: { interval?: string; limit?: number }): Promise<TokenListEntry[]>;
}

const VALID_INTERVALS = ['5m', '1h', '6h', '24h'];

const CATEGORY_MAP: Record<string, { path: (interval: string) => string; supportsInterval: boolean; label: string; description: string }> = {
  'trending':    { path: (i) => `/tokens/v2/toptrending/${i}`,      supportsInterval: true,  label: 'Trending',      description: 'Top trending tokens by search + trade activity' },
  'top-traded':  { path: (i) => `/tokens/v2/toptraded/${i}`,        supportsInterval: true,  label: 'Top Traded',    description: 'Most traded tokens by volume' },
  'top-organic': { path: (i) => `/tokens/v2/toporganicscore/${i}`,  supportsInterval: true,  label: 'Top Organic',   description: 'Highest organic score (real vs wash trading)' },
  'recent':      { path: () => `/tokens/v2/recent`,                 supportsInterval: false, label: 'Recent',        description: 'Recently launched tokens' },
  'lst':         { path: () => `/tokens/v2/tag?query=lst`,          supportsInterval: false, label: 'LST',           description: 'Liquid staking tokens' },
  'verified':    { path: () => `/tokens/v2/tag?query=verified`,     supportsInterval: false, label: 'Verified',      description: 'Jupiter-verified tokens' },
};

export function createTokenListsService(ctx: SolContext): TokenListsService {
  const { logger, cache } = ctx;
  const jupiterLimiter = new RateLimiter(30, 60_000);

  function getCategories(): CategoryInfo[] {
    return Object.entries(CATEGORY_MAP).map(([id, info]) => ({
      id,
      label: info.label,
      description: info.description,
      supportsInterval: info.supportsInterval,
    }));
  }

  function ttlForCategory(category: string): number {
    if (category === 'lst' || category === 'verified') return 30;
    return 1;
  }

  function enrichFromCache(mint: string): Partial<TokenListEntry> {
    const row = cache.getTokenByMint(mint);
    if (!row) return {};
    return {
      symbol: row.symbol ?? '',
      name: row.name ?? '',
      decimals: row.decimals,
      logoUri: row.logo_uri ?? undefined,
    };
  }

  function recycleData(entries: TokenListEntry[]): void {
    const tokens = entries
      .filter(e => e.symbol && e.decimals != null)
      .map(e => ({
        mint: e.mint,
        symbol: e.symbol,
        name: e.name,
        decimals: e.decimals,
        logo_uri: e.logoUri ?? null,
        tags: null,
        source: 'jupiter-browse',
      }));

    if (tokens.length > 0) {
      cache.upsertTokenBatch(tokens);
    }

    for (const e of entries) {
      if (e.priceUsd != null && e.priceUsd > 0) {
        cache.insertPrice(e.mint, e.priceUsd, 'jupiter-browse');
      }
    }
  }

  async function browseTokens(
    category: string,
    opts?: { interval?: string; limit?: number }
  ): Promise<TokenListEntry[]> {
    const info = CATEGORY_MAP[category];
    if (!info) throw new Error(`Unknown category: ${category}. Available: ${Object.keys(CATEGORY_MAP).join(', ')}`);

    const interval = info.supportsInterval ? (opts?.interval ?? '1h') : null;
    const ttl = ttlForCategory(category);

    // Check cache
    if (cache.isTokenListStale && cache.getTokenList && cache.replaceTokenList) {
      if (!cache.isTokenListStale(category, interval, ttl)) {
        logger.verbose(`Serving ${category} from cache`);
        const cached = cache.getTokenList(category, interval);
        const limit = opts?.limit ?? 20;
        return cached.slice(0, limit).map(row => {
          const meta = row.metadata ? JSON.parse(row.metadata) as Record<string, unknown> : undefined;
          return {
            mint: row.mint,
            symbol: '',
            name: '',
            decimals: 0,
            priceUsd: row.price_usd ?? undefined,
            volume24hUsd: row.volume_24h_usd ?? undefined,
            change24hPct: meta?.change24hPct as number | undefined,
            metadata: meta,
            ...enrichFromCache(row.mint),
          };
        });
      }
    }

    if (info.supportsInterval && interval && !VALID_INTERVALS.includes(interval)) {
      throw new Error(`Invalid interval: ${interval}. Choose from: ${VALID_INTERVALS.join(', ')}`);
    }

    const base = getJupiterBaseUrl(ctx);
    const headers = getJupiterHeaders(ctx);
    const path = info.path(interval ?? '1h');
    const url = `${base}${path}`;

    logger.verbose(`Fetching ${category} tokens: ${url}`);
    await jupiterLimiter.acquire();

    const res = await withRetry(() => fetch(url, { headers }), {
      maxRetries: 2,
      shouldRetry: isRetryableHttpError,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Jupiter ${category} API failed (${res.status}): ${body}`);
    }

    const data = await res.json() as any[];
    const fetchLimit = Math.max(opts?.limit ?? 20, 50);

    const entries: TokenListEntry[] = data.slice(0, fetchLimit).map((t: any) => {
      const stats24h = t.stats24h;
      const volume24h = stats24h
        ? (stats24h.buyVolume ?? 0) + (stats24h.sellVolume ?? 0)
        : undefined;

      const entry: TokenListEntry = {
        mint: t.address || t.id,
        symbol: t.symbol ?? '???',
        name: t.name ?? '',
        decimals: t.decimals ?? 0,
        logoUri: t.logoURI || t.icon,
        priceUsd: t.usdPrice ?? t.price,
        volume24hUsd: volume24h || undefined,
        change24hPct: stats24h?.priceChange,
      };

      const meta: Record<string, unknown> = {};
      if (t.organicScore != null) meta.organicScore = t.organicScore;
      if (t.organicScoreLabel) meta.organicScoreLabel = t.organicScoreLabel;
      if (t.holderCount != null) meta.holderCount = t.holderCount;
      if (t.mcap != null) meta.mcap = t.mcap;
      if (t.liquidity != null) meta.liquidity = t.liquidity;
      if (t.stats1h?.priceChange != null) meta.change1hPct = t.stats1h.priceChange;
      if (t.stats6h?.priceChange != null) meta.change6hPct = t.stats6h.priceChange;
      if (Object.keys(meta).length > 0) entry.metadata = meta;

      return entry;
    });

    recycleData(entries);

    // Store in cache if supported
    if (cache.replaceTokenList) {
      cache.replaceTokenList(category, interval, entries.map((e, i) => {
        const cacheMeta = { ...e.metadata };
        if (e.change24hPct != null) cacheMeta.change24hPct = e.change24hPct;
        return {
          mint: e.mint,
          rank: i + 1,
          price_usd: e.priceUsd ?? null,
          volume_24h_usd: e.volume24hUsd ?? null,
          metadata: Object.keys(cacheMeta).length > 0 ? JSON.stringify(cacheMeta) : null,
        };
      }));
    }

    const limit = opts?.limit ?? 20;
    return entries.slice(0, limit);
  }

  return { getCategories, browseTokens };
}
