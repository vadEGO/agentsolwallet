import { getWellKnownBySymbol, getWellKnownByMint } from '../utils/token-list.js';
import * as tokenRepo from '../db/repos/token-repo.js';
import { verbose } from '../output/formatter.js';
import { withRetry, isRetryableHttpError } from '../utils/retry.js';

// Pluggable provider interface
export interface TokenMetadata {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  logoUri?: string;
  tags?: string[];
}

export interface TokenMetadataProvider {
  name: string;
  search(query: string): Promise<TokenMetadata[]>;
  getByMint(mints: string[]): Promise<TokenMetadata[]>;
}

// Jupiter Token API v2 provider
export class JupiterTokenProvider implements TokenMetadataProvider {
  name = 'jupiter';
  private baseUrl = 'https://lite-api.jup.ag';

  async search(query: string): Promise<TokenMetadata[]> {
    const url = `${this.baseUrl}/tokens/v2/search?query=${encodeURIComponent(query)}`;
    verbose(`Fetching token metadata: ${url}`);

    const res = await withRetry(() => fetch(url), {
      maxRetries: 2,
      shouldRetry: isRetryableHttpError,
    });

    if (!res.ok) throw new Error(`Jupiter token search failed: ${res.status}`);
    const data = await res.json() as any[];

    return data.map(t => ({
      mint: t.address || t.id,
      symbol: t.symbol,
      name: t.name,
      decimals: t.decimals,
      logoUri: t.logoURI || t.icon,
      tags: t.tags,
    }));
  }

  async getByMint(mints: string[]): Promise<TokenMetadata[]> {
    if (mints.length === 0) return [];

    // Jupiter v2: fetch by comma-separated mint addresses (max 100 per request)
    const results: TokenMetadata[] = [];
    for (let i = 0; i < mints.length; i += 100) {
      const batch = mints.slice(i, i + 100);
      const url = `${this.baseUrl}/tokens/v2/${batch.join(',')}`;
      verbose(`Fetching token metadata for ${batch.length} mints`);

      const res = await withRetry(() => fetch(url), {
        maxRetries: 2,
        shouldRetry: isRetryableHttpError,
      });

      if (!res.ok) continue;
      const data = await res.json() as any[];

      for (const t of data) {
        results.push({
          mint: t.address || t.id,
          symbol: t.symbol,
          name: t.name,
          decimals: t.decimals,
          logoUri: t.logoURI || t.icon,
          tags: t.tags,
        });
      }
    }
    return results;
  }
}

// Default providers — extensible
const providers: TokenMetadataProvider[] = [new JupiterTokenProvider()];

export function registerProvider(provider: TokenMetadataProvider): void {
  providers.push(provider);
}

// Resolution chain: hardcoded → SQLite cache → live providers
export async function resolveToken(symbolOrMint: string): Promise<TokenMetadata | undefined> {
  // 1. Hardcoded well-known tokens
  const wellKnown = getWellKnownBySymbol(symbolOrMint) || getWellKnownByMint(symbolOrMint);
  if (wellKnown) {
    return {
      mint: wellKnown.mint,
      symbol: wellKnown.symbol,
      name: wellKnown.name,
      decimals: wellKnown.decimals,
    };
  }

  // 2. SQLite cache — by symbol
  const bySymbol = tokenRepo.getTokenBySymbol(symbolOrMint);
  if (bySymbol.length > 0 && !tokenRepo.isTokenCacheStale(bySymbol[0].mint)) {
    const t = bySymbol[0];
    return { mint: t.mint, symbol: t.symbol || '', name: t.name || '', decimals: t.decimals, logoUri: t.logo_uri || undefined };
  }

  // 2b. SQLite cache — by mint address
  const byMint = tokenRepo.getTokenByMint(symbolOrMint);
  if (byMint && !tokenRepo.isTokenCacheStale(byMint.mint)) {
    return { mint: byMint.mint, symbol: byMint.symbol || '', name: byMint.name || '', decimals: byMint.decimals, logoUri: byMint.logo_uri || undefined };
  }

  // 3. Live provider lookup
  for (const provider of providers) {
    try {
      // If it looks like a mint address, fetch by mint
      if (symbolOrMint.length >= 32) {
        const results = await provider.getByMint([symbolOrMint]);
        if (results.length > 0) {
          cacheTokens(results, provider.name);
          return results[0];
        }
      }

      // Search by symbol/name
      const results = await provider.search(symbolOrMint);
      if (results.length > 0) {
        cacheTokens(results, provider.name);
        return results[0];
      }
    } catch (err) {
      verbose(`Provider ${provider.name} failed: ${err}`);
    }
  }

  return undefined;
}

// Resolve multiple tokens efficiently
export async function resolveTokens(queries: string[]): Promise<Map<string, TokenMetadata>> {
  const results = new Map<string, TokenMetadata>();
  const unresolved: string[] = [];

  for (const q of queries) {
    // Check hardcoded + cache first
    const wellKnown = getWellKnownBySymbol(q) || getWellKnownByMint(q);
    if (wellKnown) {
      results.set(q, { mint: wellKnown.mint, symbol: wellKnown.symbol, name: wellKnown.name, decimals: wellKnown.decimals });
      continue;
    }
    const cached = tokenRepo.getTokenBySymbol(q)[0] || tokenRepo.getTokenByMint(q);
    if (cached && !tokenRepo.isTokenCacheStale(cached.mint)) {
      results.set(q, { mint: cached.mint, symbol: cached.symbol || '', name: cached.name || '', decimals: cached.decimals });
      continue;
    }
    unresolved.push(q);
  }

  // Batch resolve unresolved ones
  if (unresolved.length > 0) {
    for (const q of unresolved) {
      const resolved = await resolveToken(q);
      if (resolved) results.set(q, resolved);
    }
  }

  return results;
}

function cacheTokens(tokens: TokenMetadata[], source: string): void {
  tokenRepo.upsertTokenBatch(
    tokens.map(t => ({
      mint: t.mint,
      symbol: t.symbol,
      name: t.name,
      decimals: t.decimals,
      logo_uri: t.logoUri || null,
      tags: t.tags ? JSON.stringify(t.tags) : null,
      source,
    }))
  );
}

// Sync: populate cache from well-known tokens
export async function syncTokenCache(): Promise<number> {
  const { WELL_KNOWN_TOKENS } = await import('../utils/token-list.js');

  // Cache all well-known tokens
  tokenRepo.upsertTokenBatch(
    WELL_KNOWN_TOKENS.map(t => ({
      mint: t.mint,
      symbol: t.symbol,
      name: t.name,
      decimals: t.decimals,
      logo_uri: null,
      tags: JSON.stringify(['well-known']),
      source: 'hardcoded',
    }))
  );

  // Try to fetch extended metadata from Jupiter for all well-known mints
  try {
    const provider = providers[0];
    const mints = WELL_KNOWN_TOKENS.map(t => t.mint);
    const fetched = await provider.getByMint(mints);
    cacheTokens(fetched, provider.name);
    return WELL_KNOWN_TOKENS.length + fetched.length;
  } catch {
    return WELL_KNOWN_TOKENS.length;
  }
}
