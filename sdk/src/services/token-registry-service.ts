import { getWellKnownBySymbol, getWellKnownByMint } from '../utils/token-list.js';
import { withRetry, isRetryableHttpError } from '../utils/retry.js';
import { getJupiterBaseUrl, getJupiterHeaders } from '../utils/jupiter-api.js';
import { WELL_KNOWN_TOKENS } from '../utils/token-list.js';
import type { SolContext } from '../types.js';

export interface TokenMetadata {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  logoUri?: string;
  tags?: string[];
}

export interface TokenRegistryService {
  resolveToken(symbolOrMint: string): Promise<TokenMetadata | undefined>;
  resolveTokens(queries: string[]): Promise<Map<string, TokenMetadata>>;
  syncTokenCache(): Promise<number>;
}

export function createTokenRegistryService(ctx: SolContext): TokenRegistryService {
  const { logger, cache } = ctx;

  async function searchJupiter(query: string): Promise<TokenMetadata[]> {
    const url = `${getJupiterBaseUrl(ctx)}/tokens/v2/search?query=${encodeURIComponent(query)}`;
    logger.verbose(`Fetching token metadata: ${url}`);

    const res = await withRetry(() => fetch(url, { headers: getJupiterHeaders(ctx) }), {
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

  async function getByMintJupiter(mints: string[]): Promise<TokenMetadata[]> {
    if (mints.length === 0) return [];

    const results: TokenMetadata[] = [];
    for (let i = 0; i < mints.length; i += 100) {
      const batch = mints.slice(i, i + 100);
      const url = `${getJupiterBaseUrl(ctx)}/tokens/v2/${batch.join(',')}`;
      logger.verbose(`Fetching token metadata for ${batch.length} mints`);

      const res = await withRetry(() => fetch(url, { headers: getJupiterHeaders(ctx) }), {
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

  function cacheTokens(tokens: TokenMetadata[], source: string): void {
    cache.upsertTokenBatch(
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

  async function resolveToken(symbolOrMint: string): Promise<TokenMetadata | undefined> {
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

    // 2. Cache — by symbol
    const bySymbol = cache.getTokenBySymbol(symbolOrMint);
    if (bySymbol.length > 0 && !cache.isTokenCacheStale(bySymbol[0].mint)) {
      const t = bySymbol[0];
      return { mint: t.mint, symbol: t.symbol || '', name: t.name || '', decimals: t.decimals, logoUri: t.logo_uri || undefined };
    }

    // 2b. Cache — by mint address
    const byMint = cache.getTokenByMint(symbolOrMint);
    if (byMint && !cache.isTokenCacheStale(byMint.mint)) {
      return { mint: byMint.mint, symbol: byMint.symbol || '', name: byMint.name || '', decimals: byMint.decimals, logoUri: byMint.logo_uri || undefined };
    }

    // 3. Live provider lookup
    try {
      if (symbolOrMint.length >= 32) {
        const results = await getByMintJupiter([symbolOrMint]);
        if (results.length > 0) {
          cacheTokens(results, 'jupiter');
          return results[0];
        }
      }

      const results = await searchJupiter(symbolOrMint);
      if (results.length > 0) {
        cacheTokens(results, 'jupiter');
        return results[0];
      }
    } catch (err) {
      logger.verbose(`Jupiter token lookup failed: ${err}`);
    }

    return undefined;
  }

  async function resolveTokens(queries: string[]): Promise<Map<string, TokenMetadata>> {
    const results = new Map<string, TokenMetadata>();
    const unresolved: string[] = [];

    for (const q of queries) {
      const wellKnown = getWellKnownBySymbol(q) || getWellKnownByMint(q);
      if (wellKnown) {
        results.set(q, { mint: wellKnown.mint, symbol: wellKnown.symbol, name: wellKnown.name, decimals: wellKnown.decimals });
        continue;
      }
      const cached = cache.getTokenBySymbol(q)[0] || cache.getTokenByMint(q);
      if (cached && !cache.isTokenCacheStale(cached.mint)) {
        results.set(q, { mint: cached.mint, symbol: cached.symbol || '', name: cached.name || '', decimals: cached.decimals });
        continue;
      }
      unresolved.push(q);
    }

    if (unresolved.length > 0) {
      for (const q of unresolved) {
        const resolved = await resolveToken(q);
        if (resolved) results.set(q, resolved);
      }
    }

    return results;
  }

  async function syncTokenCache(): Promise<number> {
    cache.upsertTokenBatch(
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

    try {
      const mints = WELL_KNOWN_TOKENS.map(t => t.mint);
      const fetched = await getByMintJupiter(mints);
      cacheTokens(fetched, 'jupiter');
      return WELL_KNOWN_TOKENS.length + fetched.length;
    } catch {
      return WELL_KNOWN_TOKENS.length;
    }
  }

  return { resolveToken, resolveTokens, syncTokenCache };
}
