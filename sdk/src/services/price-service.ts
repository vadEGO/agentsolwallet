import { withRetry, isRetryableHttpError, RateLimiter } from '../utils/retry.js';
import { SOL_MINT } from '../utils/solana.js';
import { getJupiterBaseUrl, getJupiterHeaders } from '../utils/jupiter-api.js';
import type { SolContext } from '../types.js';

const jupiterLimiter = new RateLimiter(30, 60_000);
const coingeckoLimiter = new RateLimiter(25, 60_000);

export interface PriceResult {
  mint: string;
  priceUsd: number;
  source: string;
}

export interface PriceService {
  getPrices(mints: string[]): Promise<Map<string, PriceResult>>;
  getPrice(mint: string): Promise<PriceResult | undefined>;
  getCachedPrice(mint: string): PriceResult | undefined;
}

// CoinGecko fallback — maps Solana mint to CoinGecko ID for well-known tokens
const COINGECKO_IDS: Record<string, string> = {
  [SOL_MINT]: 'solana',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'usd-coin',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'tether',
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN': 'jupiter-exchange-solana',
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': 'bonk',
};

export function createPriceService(ctx: SolContext): PriceService {
  const { logger, cache } = ctx;

  async function fetchJupiterPrices(mints: string[]): Promise<Map<string, PriceResult>> {
    const results = new Map<string, PriceResult>();
    if (mints.length === 0) return results;

    await jupiterLimiter.acquire();

    const ids = mints.join(',');
    const url = `${getJupiterBaseUrl(ctx)}/price/v3?ids=${ids}`;
    logger.verbose(`Fetching Jupiter prices for ${mints.length} tokens`);

    const res = await withRetry(() => fetch(url, { headers: getJupiterHeaders(ctx) }), {
      maxRetries: 2,
      shouldRetry: isRetryableHttpError,
    });

    if (!res.ok) throw new Error(`Jupiter price API error: ${res.status}`);
    const data = await res.json() as Record<string, { usdPrice: number }>;

    for (const [mint, info] of Object.entries(data)) {
      if (info?.usdPrice) {
        results.set(mint, { mint, priceUsd: info.usdPrice, source: 'jupiter' });
      }
    }

    return results;
  }

  async function fetchCoingeckoPrices(mints: string[]): Promise<Map<string, PriceResult>> {
    const results = new Map<string, PriceResult>();

    const ids = mints.map(m => COINGECKO_IDS[m]).filter(Boolean);
    if (ids.length === 0) return results;

    await coingeckoLimiter.acquire();

    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd`;
    logger.verbose(`Fetching CoinGecko prices for ${ids.length} tokens`);

    const res = await withRetry(() => fetch(url), {
      maxRetries: 2,
      shouldRetry: isRetryableHttpError,
    });

    if (!res.ok) throw new Error(`CoinGecko API error: ${res.status}`);
    const data = await res.json() as Record<string, { usd: number }>;

    const idToMint = new Map<string, string>();
    for (const [mint, id] of Object.entries(COINGECKO_IDS)) {
      idToMint.set(id, mint);
    }

    for (const [id, info] of Object.entries(data)) {
      const mint = idToMint.get(id);
      if (mint && info?.usd) {
        results.set(mint, { mint, priceUsd: info.usd, source: 'coingecko' });
      }
    }

    return results;
  }

  async function getPrices(mints: string[]): Promise<Map<string, PriceResult>> {
    if (mints.length === 0) return new Map();

    const results = new Map<string, PriceResult>();

    // Try Jupiter first
    try {
      const jupiterResults = await fetchJupiterPrices(mints);
      for (const [mint, price] of jupiterResults) {
        results.set(mint, price);
        cache.insertPrice(price.mint, price.priceUsd, price.source);
      }
    } catch (err) {
      logger.verbose(`Jupiter price API failed: ${err}`);
    }

    // Try CoinGecko for any missing mints
    const missing = mints.filter(m => !results.has(m));
    if (missing.length > 0) {
      try {
        const fallback = await fetchCoingeckoPrices(missing);
        for (const [mint, price] of fallback) {
          results.set(mint, price);
          cache.insertPrice(price.mint, price.priceUsd, price.source);
        }
      } catch (err) {
        logger.verbose(`CoinGecko fallback failed: ${err}`);
      }
    }

    // For any still-missing mints, try cached prices
    const stillMissing = mints.filter(m => !results.has(m));
    for (const mint of stillMissing) {
      const cached = cache.getLatestPrice(mint);
      if (cached) {
        results.set(mint, { mint: cached.mint, priceUsd: cached.price_usd, source: `${cached.source}-cached` });
      }
    }

    return results;
  }

  async function getPrice(mint: string): Promise<PriceResult | undefined> {
    const results = await getPrices([mint]);
    return results.get(mint);
  }

  function getCachedPrice(mint: string): PriceResult | undefined {
    const row = cache.getLatestPrice(mint);
    if (!row) return undefined;
    return { mint: row.mint, priceUsd: row.price_usd, source: row.source };
  }

  return { getPrices, getPrice, getCachedPrice };
}
