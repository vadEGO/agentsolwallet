import { withRetry, isRetryableHttpError, RateLimiter } from '../utils/retry.js';
import { verbose } from '../output/formatter.js';
import * as priceRepo from '../db/repos/price-repo.js';
import { SOL_MINT } from '../utils/solana.js';

const jupiterLimiter = new RateLimiter(30, 60_000); // 30 req/min
const coingeckoLimiter = new RateLimiter(25, 60_000); // 25 req/min (conservative)

export interface PriceResult {
  mint: string;
  priceUsd: number;
  source: string;
}

// Jupiter Price API v2
async function fetchJupiterPrices(mints: string[]): Promise<Map<string, PriceResult>> {
  const results = new Map<string, PriceResult>();
  if (mints.length === 0) return results;

  await jupiterLimiter.acquire();

  const ids = mints.join(',');
  const url = `https://api.jup.ag/price/v2?ids=${ids}`;
  verbose(`Fetching Jupiter prices for ${mints.length} tokens`);

  const res = await withRetry(() => fetch(url), {
    maxRetries: 2,
    shouldRetry: isRetryableHttpError,
  });

  if (!res.ok) throw new Error(`Jupiter price API error: ${res.status}`);
  const data = await res.json() as { data: Record<string, { price: string }> };

  for (const [mint, info] of Object.entries(data.data || {})) {
    if (info?.price) {
      const priceUsd = parseFloat(info.price);
      results.set(mint, { mint, priceUsd, source: 'jupiter' });
    }
  }

  return results;
}

// CoinGecko fallback — maps Solana mint to CoinGecko ID for well-known tokens
const COINGECKO_IDS: Record<string, string> = {
  [SOL_MINT]: 'solana',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'usd-coin',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'tether',
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN': 'jupiter-exchange-solana',
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': 'bonk',
};

async function fetchCoingeckoPrices(mints: string[]): Promise<Map<string, PriceResult>> {
  const results = new Map<string, PriceResult>();

  const ids = mints.map(m => COINGECKO_IDS[m]).filter(Boolean);
  if (ids.length === 0) return results;

  await coingeckoLimiter.acquire();

  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd`;
  verbose(`Fetching CoinGecko prices for ${ids.length} tokens`);

  const res = await withRetry(() => fetch(url), {
    maxRetries: 2,
    shouldRetry: isRetryableHttpError,
  });

  if (!res.ok) throw new Error(`CoinGecko API error: ${res.status}`);
  const data = await res.json() as Record<string, { usd: number }>;

  // Reverse-map CoinGecko IDs to mints
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

export async function getPrices(mints: string[]): Promise<Map<string, PriceResult>> {
  if (mints.length === 0) return new Map();

  const results = new Map<string, PriceResult>();

  // Try Jupiter first
  try {
    const jupiterResults = await fetchJupiterPrices(mints);
    for (const [mint, price] of jupiterResults) {
      results.set(mint, price);
      priceRepo.insertPrice(price.mint, price.priceUsd, price.source);
    }
  } catch (err) {
    verbose(`Jupiter price API failed: ${err}`);
  }

  // Try CoinGecko for any missing mints
  const missing = mints.filter(m => !results.has(m));
  if (missing.length > 0) {
    try {
      const fallback = await fetchCoingeckoPrices(missing);
      for (const [mint, price] of fallback) {
        results.set(mint, price);
        priceRepo.insertPrice(price.mint, price.priceUsd, price.source);
      }
    } catch (err) {
      verbose(`CoinGecko fallback failed: ${err}`);
    }
  }

  // For any still-missing mints, try cached prices
  const stillMissing = mints.filter(m => !results.has(m));
  for (const mint of stillMissing) {
    const cached = priceRepo.getLatestPrice(mint);
    if (cached) {
      results.set(mint, { mint: cached.mint, priceUsd: cached.price_usd, source: `${cached.source}-cached` });
    }
  }

  return results;
}

export async function getPrice(mint: string): Promise<PriceResult | undefined> {
  const results = await getPrices([mint]);
  return results.get(mint);
}

// Get cached price (no network)
export function getCachedPrice(mint: string): PriceResult | undefined {
  const row = priceRepo.getLatestPrice(mint);
  if (!row) return undefined;
  return { mint: row.mint, priceUsd: row.price_usd, source: row.source };
}
