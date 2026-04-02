// DLMM and CpAmm are loaded lazily via createRequire (CJS) to avoid ESM compat issues.
// - @meteora-ag/dlmm's ESM entry uses directory imports from @coral-xyz/anchor (Node rejects)
// - @meteora-ag/cp-amm-sdk's ESM entry does `import { BN } from '@coral-xyz/anchor'` but
//   anchor 0.32.1's ESM build doesn't export BN (only the CJS build does)
// Loading via CJS require() sidesteps both issues.
import { createRequire } from 'node:module';
import { PublicKey, Keypair } from '@solana/web3.js';
import BN from 'bn.js';
import type { Instruction } from '@solana/kit';
import { getV1Connection, toV2Instructions } from '../../compat/meteora-compat.js';
import { injectSigners, type TransactionService } from '../transaction-service.js';

// ── Lazy SDK loaders (CJS) ───────────────────────────────

const require = createRequire(import.meta.url);

let _dlmm: any = null;
let _strategyType: any = null;
let _cpAmm: any = null;

function getDLMMSync(): any {
  if (!_dlmm) {
    const mod = require('@meteora-ag/dlmm');
    _dlmm = mod.default ?? mod;
    _strategyType = mod.StrategyType ?? _dlmm.StrategyType;
  }
  return _dlmm;
}

async function getDLMM(): Promise<any> {
  return getDLMMSync();
}

async function getStrategyType(): Promise<any> {
  if (!_strategyType) getDLMMSync();
  return _strategyType;
}

async function getCpAmm(connection: any): Promise<any> {
  if (!_cpAmm) {
    const mod = require('@meteora-ag/cp-amm-sdk');
    const CpAmmCls = mod.CpAmm ?? mod.default?.CpAmm ?? mod.default;
    _cpAmm = new CpAmmCls(connection);
  }
  return _cpAmm;
}
import { uiToTokenAmount, tokenAmountToUi, SOL_MINT } from '../../utils/solana.js';
import { isNativeSol, buildWrapSolInstructions, buildUnwrapSolInstructions, buildEnsureAtaInstructions } from '../../utils/wsol.js';
import { address } from '@solana/kit';
import type { SolContext } from '../../types.js';
import type { TokenRegistryService, TokenMetadata } from '../token-registry-service.js';
import type { PriceService } from '../price-service.js';
import type {
  LpProvider,
  LpProviderCapabilities,
  LpPoolInfo,
  LpPositionInfo,
  LpDepositParams,
  LpDepositQuote,
  LpWithdrawParams,
  LpWriteResult,
  LpFarmInfo,
  LpFarmResult,
  CreatePoolParams,
  PoolConfig,
  PoolType,
} from './lp-provider.js';

// ── Constants ─────────────────────────────────────────────

const DLMM_PAIRS_API = 'https://dlmm-api.meteora.ag/pair/all';
const DLMM_PAIRS_SEARCH_API = 'https://dlmm-api.meteora.ag/pair/search';
const DAMM_POOLS_API = 'https://amm-v2.meteora.ag/pools/search';
const POOL_CACHE_TTL_MS = 120_000;
const DEFAULT_SLIPPAGE_BPS = 100;

// ── Pool cache ────────────────────────────────────────────

interface CachedDlmmPair {
  address: string;
  name: string;
  mint_x: string;
  mint_y: string;
  bin_step: number;
  liquidity: string;
  trade_volume_24h: string;
  fee_rate: number;
  apr: number;
  current_price: number;
}

interface CachedDammPool {
  pool_address: string;
  pool_name: string;
  token_a_mint: string;
  token_b_mint: string;
  pool_tvl: number;
  trading_volume_24h: number;
  fee_rate: number;
  apy: number;
  pool_type: string; // 'stable' | 'constant_product'
}

let dlmmPairCache: CachedDlmmPair[] = [];
let dlmmPairCacheTs = 0;
const dammPoolCache = new Map<string, { data: CachedDammPool[]; ts: number }>();

// ── Dependencies ──────────────────────────────────────────

export interface MeteoraLpDeps {
  registry: TokenRegistryService;
  price: PriceService;
  tx: TransactionService;
  rpcUrl: string;
}

// ── Provider ──────────────────────────────────────────────

export class MeteoraLpProvider implements LpProvider {
  name = 'meteora' as const;
  capabilities: LpProviderCapabilities = {
    pools: true,
    positions: true,
    deposit: true,
    withdraw: true,
    claimFees: true,
    createPool: true,
    farming: true,
    closePosition: true,
  };

  constructor(private ctx: SolContext, private deps: MeteoraLpDeps) {}

  private getConnection() {
    return getV1Connection(this.deps.rpcUrl);
  }

  // ── Helpers ─────────────────────────────────────────────

  private async resolveTokenStrict(symbolOrMint: string): Promise<TokenMetadata> {
    const meta = await this.deps.registry.resolveToken(symbolOrMint);
    if (!meta) throw new Error(`Unknown token: ${symbolOrMint}`);
    return meta;
  }

  private async resolveSymbol(mint: string): Promise<string> {
    try {
      const meta = await this.deps.registry.resolveToken(mint);
      return meta?.symbol ?? mint.slice(0, 8);
    } catch {
      return mint.slice(0, 8);
    }
  }

  /**
   * Extract v1 instructions from a Meteora SDK Transaction or Transaction[].
   * DLMM methods return either a single Transaction or an array of Transactions.
   */
  private extractInstructions(txOrTxs: any): Instruction[] {
    const txs = Array.isArray(txOrTxs) ? txOrTxs : [txOrTxs];
    const v1Ixs: any[] = [];
    for (const tx of txs) {
      if (tx && tx.instructions) {
        v1Ixs.push(...tx.instructions);
      }
    }
    return toV2Instructions(v1Ixs);
  }

  // ── Pool caching (API) ─────────────────────────────────

  private async fetchDlmmPairs(tokenMint?: string): Promise<CachedDlmmPair[]> {
    // If a token filter is provided, use the search endpoint (fast, small response)
    if (tokenMint) {
      return this.fetchDlmmPairsFiltered(tokenMint);
    }

    // No filter: fall back to full list (cached aggressively)
    if (Date.now() - dlmmPairCacheTs < POOL_CACHE_TTL_MS && dlmmPairCache.length > 0) {
      return dlmmPairCache;
    }

    this.ctx.logger.verbose('Meteora DLMM REST API is deprecated, returning empty pool list');
    this.ctx.logger.verbose('Use individual pool addresses with `sol lp deposit <poolId>` for DLMM pools');
    dlmmPairCache = [];
    dlmmPairCacheTs = Date.now();
    return dlmmPairCache;
  }

  private async fetchDlmmPairsFiltered(tokenMint: string): Promise<CachedDlmmPair[]> {
    // REST API is deprecated, return empty
    this.ctx.logger.verbose('Meteora DLMM REST API is deprecated');
    return [];
  }

  private parseDlmmPairs(data: any[]): CachedDlmmPair[] {
    return data.map(p => ({
      address: p.address,
      name: p.name || '',
      mint_x: p.mint_x,
      mint_y: p.mint_y,
      bin_step: p.bin_step ?? 0,
      liquidity: p.liquidity ?? '0',
      trade_volume_24h: p.trade_volume_24h ?? '0',
      fee_rate: p.base_fee_percentage ? parseFloat(p.base_fee_percentage) / 100 : 0,
      apr: p.apr ?? 0,
      current_price: p.current_price ?? 0,
    }));
  }

  private async fetchDammPools(tokenMint?: string): Promise<CachedDammPool[]> {
    // DAMM v2 API requires a token filter for search — no "list all" endpoint
    if (!tokenMint) return [];

    // Cache key includes the token to avoid stale cross-token results
    const cached = dammPoolCache.get(tokenMint);
    if (cached && Date.now() - cached.ts < POOL_CACHE_TTL_MS) {
      return cached.data;
    }

    this.ctx.logger.verbose('Fetching Meteora DAMM v2 pools from API...');
    try {
      const url = `${DAMM_POOLS_API}?token=${tokenMint}&page=0&size=100`;
      const resp = await fetch(url);
      if (!resp.ok) {
        this.ctx.logger.verbose(`Meteora DAMM v2 API error ${resp.status}`);
        return [];
      }

      const result: any = await resp.json();
      const data: any[] = result.data ?? result;
      const pools = data.map(p => ({
        pool_address: p.pool_address,
        pool_name: p.pool_name ?? '',
        token_a_mint: p.pool_token_mints?.[0] ?? '',
        token_b_mint: p.pool_token_mints?.[1] ?? '',
        pool_tvl: parseFloat(p.pool_tvl) || 0,
        trading_volume_24h: p.trading_volume ?? 0,
        fee_rate: parseFloat(p.total_fee_pct) || 0,
        apy: p.apr ?? 0,
        pool_type: p.pool_type ?? 'constant_product',
      }));
      dammPoolCache.set(tokenMint, { data: pools, ts: Date.now() });
      return pools;
    } catch (err) {
      this.ctx.logger.verbose(`DAMM v2 pool fetch failed: ${err}`);
    }
    return [];
  }

  // ── Determine pool type ─────────────────────────────────

  /**
   * Check if a pool address is a DLMM pair by looking it up in the cached pair list.
   * Falls back to attempting on-chain DLMM load if not found in API cache.
   */
  private async isDlmmPool(poolId: string): Promise<boolean> {
    const pairs = await this.fetchDlmmPairs();
    if (pairs.some(p => p.address === poolId)) return true;

    // Try loading on-chain — if it succeeds, it's DLMM
    try {
      await (await getDLMM()).create(this.getConnection(), new PublicKey(poolId));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Lightweight lookup: find poolId, poolType, and mints for a given position
   * without computing full amounts/prices (avoids getPositions overhead).
   */
  private async findPositionPool(
    walletAddress: string,
  ): Promise<{ poolId: string; poolType: 'clmm' | 'amm'; mintA: string; mintB: string; positionId: string }[]> {
    const connection = this.getConnection();
    const userPubkey = new PublicKey(walletAddress);
    const results: { poolId: string; poolType: 'clmm' | 'amm'; mintA: string; mintB: string; positionId: string }[] = [];

    // DLMM — getAllLbPairPositionsByUser returns pair data with mints
    try {
      const DLMMClass = await getDLMM();
      const positionsMap: Map<string, any> = await DLMMClass.getAllLbPairPositionsByUser(connection, userPubkey);
      for (const [pairAddr, pairData] of positionsMap) {
        const mintA = pairData.lbPair.tokenXMint.toBase58();
        const mintB = pairData.lbPair.tokenYMint.toBase58();
        const positions = pairData.lbPairPositionsData ?? [];
        for (const pos of positions) {
          results.push({
            poolId: pairAddr,
            poolType: 'clmm',
            mintA, mintB,
            positionId: pos.publicKey.toBase58(),
          });
        }
      }
    } catch {}

    // DAMM — getPositionsByUser, then fetch pool state for mints
    try {
      const cpAmm = await getCpAmm(connection);
      const dammPositions: any[] = await (cpAmm as any).getPositionsByUser(userPubkey);
      // Group by pool to minimise RPC calls
      const byPool = new Map<string, { posIds: string[]; poolAddr: string }>();
      for (const pos of dammPositions) {
        const posId = pos.position?.toBase58() ?? pos.positionNftAccount?.toBase58() ?? '';
        const poolAddr = pos.positionState?.pool?.toBase58() ?? '';
        if (!posId || !poolAddr) continue;
        if (!byPool.has(poolAddr)) byPool.set(poolAddr, { posIds: [], poolAddr });
        byPool.get(poolAddr)!.posIds.push(posId);
      }
      const poolResults = await Promise.allSettled(
        [...byPool.values()].map(async ({ posIds, poolAddr }) => {
          const poolState: any = await cpAmm.fetchPoolState(new PublicKey(poolAddr));
          const mintA = poolState.tokenAMint.toBase58();
          const mintB = poolState.tokenBMint.toBase58();
          return posIds.map(posId => ({ poolId: poolAddr, poolType: 'amm' as const, mintA, mintB, positionId: posId }));
        }),
      );
      for (const r of poolResults) {
        if (r.status === 'fulfilled') results.push(...r.value);
      }
    } catch {}

    return results;
  }

  // ── LpProvider: getPools ────────────────────────────────

  async getPools(tokenA?: string, tokenB?: string, limit?: number): Promise<LpPoolInfo[]> {
    const pools: LpPoolInfo[] = [];

    // Resolve token filters to mint addresses
    let mintA: string | undefined;
    let mintB: string | undefined;
    if (tokenA) {
      const meta = await this.deps.registry.resolveToken(tokenA);
      mintA = meta?.mint ?? tokenA;
    }
    if (tokenB) {
      const meta = await this.deps.registry.resolveToken(tokenB);
      mintB = meta?.mint ?? tokenB;
    }

    // Fetch DLMM pairs (pass token filter for faster API call)
    try {
      const pairs = await this.fetchDlmmPairs(mintA || mintB);
      const filtered = pairs.filter(p => {
        if (mintA && mintB) {
          return (p.mint_x === mintA && p.mint_y === mintB) ||
                 (p.mint_x === mintB && p.mint_y === mintA);
        }
        if (mintA) return p.mint_x === mintA || p.mint_y === mintA;
        if (mintB) return p.mint_x === mintB || p.mint_y === mintB;
        return true;
      });

      // Resolve symbols in parallel
      const mintSet = new Set<string>();
      for (const p of filtered) {
        mintSet.add(p.mint_x);
        mintSet.add(p.mint_y);
      }
      const symbolMap = new Map<string, string>();
      await Promise.all([...mintSet].map(async mint => {
        symbolMap.set(mint, await this.resolveSymbol(mint));
      }));

      for (const p of filtered) {
        pools.push({
          poolId: p.address,
          protocol: 'meteora',
          poolType: 'clmm',
          tokenA: symbolMap.get(p.mint_x) ?? '',
          tokenB: symbolMap.get(p.mint_y) ?? '',
          mintA: p.mint_x,
          mintB: p.mint_y,
          tvlUsd: parseFloat(p.liquidity) || null,
          volume24hUsd: parseFloat(p.trade_volume_24h) || null,
          feeRate: p.fee_rate,
          apy: p.apr > 0 ? p.apr : null,
          currentPrice: p.current_price,
          binStep: p.bin_step,
        });
      }
    } catch (err) {
      this.ctx.logger.verbose(`DLMM pool fetch failed: ${err}`);
    }

    // Fetch DAMM v2 pools (requires at least one token filter)
    try {
      const dammPools = await this.fetchDammPools(mintA || mintB);
      const filtered = dammPools.filter(p => {
        if (mintA && mintB) {
          return (p.token_a_mint === mintA && p.token_b_mint === mintB) ||
                 (p.token_a_mint === mintB && p.token_b_mint === mintA);
        }
        if (mintA) return p.token_a_mint === mintA || p.token_b_mint === mintA;
        if (mintB) return p.token_a_mint === mintB || p.token_b_mint === mintB;
        return true;
      });

      const mintSet = new Set<string>();
      for (const p of filtered) {
        mintSet.add(p.token_a_mint);
        mintSet.add(p.token_b_mint);
      }
      const symbolMap = new Map<string, string>();
      await Promise.all([...mintSet].map(async mint => {
        if (!symbolMap.has(mint)) {
          symbolMap.set(mint, await this.resolveSymbol(mint));
        }
      }));

      for (const p of filtered) {
        pools.push({
          poolId: p.pool_address,
          protocol: 'meteora',
          poolType: 'amm',
          tokenA: symbolMap.get(p.token_a_mint) ?? '',
          tokenB: symbolMap.get(p.token_b_mint) ?? '',
          mintA: p.token_a_mint,
          mintB: p.token_b_mint,
          tvlUsd: p.pool_tvl || null,
          volume24hUsd: p.trading_volume_24h || null,
          feeRate: p.fee_rate,
          apy: p.apy > 0 ? p.apy / 100 : null,
          currentPrice: 0,
        });
      }
    } catch (err) {
      this.ctx.logger.verbose(`DAMM v2 pool fetch failed: ${err}`);
    }

    // Sort by TVL descending
    pools.sort((a, b) => (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0));

    return limit ? pools.slice(0, limit) : pools;
  }

  // ── LpProvider: getPositions ────────────────────────────

  async getPositions(walletAddress: string): Promise<LpPositionInfo[]> {
    if (!walletAddress) return [];

    this.ctx.logger.verbose(`Fetching Meteora LP positions for ${walletAddress}`);
    const connection = this.getConnection();
    const userPubkey = new PublicKey(walletAddress);
    const positions: LpPositionInfo[] = [];

    // DLMM positions: discover pairs via getAllLbPairPositionsByUser, then load
    // each pair with DLMM.create for accurate price/position data
    try {
      const DLMMClass = await getDLMM();
      const positionsMap: Map<string, any> = await DLMMClass.getAllLbPairPositionsByUser(
        connection, userPubkey,
      );

      const pairAddresses = [...positionsMap.keys()];
      this.ctx.logger.verbose(`DLMM found positions in ${pairAddresses.length} pair(s): ${pairAddresses.join(', ')}`);

      // Load each pair and fetch positions in parallel
      const pairResults = await Promise.allSettled(pairAddresses.map(async pairAddress => {
        const dlmm = await DLMMClass.create(connection, new PublicKey(pairAddress));
        const userPositions = await dlmm.getPositionsByUserAndLbPair(userPubkey);

        if (!userPositions || userPositions.userPositions.length === 0) return [];

        const activeBin = await dlmm.getActiveBin();
        const activeBinId = activeBin.binId;

        const lbPairData = positionsMap.get(pairAddress);
        const mintXAddr = lbPairData.lbPair.tokenXMint.toBase58();
        const mintYAddr = lbPairData.lbPair.tokenYMint.toBase58();

        const [metaX, metaY, priceData] = await Promise.all([
          this.deps.registry.resolveToken(mintXAddr),
          this.deps.registry.resolveToken(mintYAddr),
          this.deps.price.getPrices([mintXAddr, mintYAddr]),
        ]);
        const decimalsA = metaX?.decimals ?? 9;
        const decimalsB = metaY?.decimals ?? 6;
        if (!metaX?.decimals || !metaY?.decimals) {
          this.ctx.logger.verbose(`Using fallback decimals for ${!metaX?.decimals ? mintXAddr : mintYAddr}`);
        }

        const symbolA = metaX?.symbol ?? mintXAddr.slice(0, 8);
        const symbolB = metaY?.symbol ?? mintYAddr.slice(0, 8);

        const priceA = priceData.get(mintXAddr)?.priceUsd ?? 0;
        const priceB = priceData.get(mintYAddr)?.priceUsd ?? 0;

        const pairPositions: LpPositionInfo[] = [];
        for (const pos of userPositions.userPositions) {
          const positionData = pos.positionData;
          const binIds = positionData.positionBinData.map((b: any) => b.binId);
          const minBin = Math.min(...binIds);
          const maxBin = Math.max(...binIds);

          this.ctx.logger.verbose(`DLMM pos bins: activeBinId=${activeBinId} minBin=${minBin} maxBin=${maxBin} numBins=${binIds.length} firstFew=[${binIds.slice(0, 3).join(',')}] lowerBinId=${positionData.lowerBinId} upperBinId=${positionData.upperBinId}`);

          let totalAmountX = new BN(0);
          let totalAmountY = new BN(0);
          for (const bin of positionData.positionBinData) {
            totalAmountX = totalAmountX.add(new BN(bin.positionXAmount || '0'));
            totalAmountY = totalAmountY.add(new BN(bin.positionYAmount || '0'));
          }

          const amountA = tokenAmountToUi(totalAmountX.toString(), decimalsA);
          const amountB = tokenAmountToUi(totalAmountY.toString(), decimalsB);
          const valueUsd = amountA * priceA + amountB * priceB;

          const feeX = positionData.feeX ? tokenAmountToUi(positionData.feeX.toString(), decimalsA) : 0;
          const feeY = positionData.feeY ? tokenAmountToUi(positionData.feeY.toString(), decimalsB) : 0;
          const unclaimedFeesUsd = feeX * priceA + feeY * priceB;

          const binStep = lbPairData.lbPair.binStep;
          const rawLowerPrice = DLMMClass.getPriceOfBinByBinId(minBin, binStep);
          const rawUpperPrice = DLMMClass.getPriceOfBinByBinId(maxBin, binStep);
          const lowerPrice = dlmm.fromPricePerLamport(Number(rawLowerPrice));
          const upperPrice = dlmm.fromPricePerLamport(Number(rawUpperPrice));

          const inRange = activeBinId >= minBin && activeBinId <= maxBin;

          pairPositions.push({
            positionId: pos.publicKey.toBase58(),
            poolId: pairAddress,
            protocol: 'meteora',
            poolType: 'clmm',
            tokenA: symbolA,
            tokenB: symbolB,
            mintA: mintXAddr,
            mintB: mintYAddr,
            amountA,
            amountB,
            valueUsd,
            unclaimedFeesA: feeX,
            unclaimedFeesB: feeY,
            unclaimedFeesUsd,
            lowerPrice: parseFloat(lowerPrice.toString()),
            upperPrice: parseFloat(upperPrice.toString()),
            inRange,
          });
        }
        return pairPositions;
      }));

      for (const r of pairResults) {
        if (r.status === 'fulfilled' && r.value.length > 0) {
          positions.push(...r.value);
        }
      }
    } catch (err: any) {
      this.ctx.logger.verbose(`DLMM getAllLbPairPositionsByUser failed: ${err.message}`);
    }

    // DAMM v2 positions — fetch all user positions directly, then resolve pool data
    try {
      const cpAmm = await getCpAmm(this.getConnection());
      const userDammPositions: any[] = await (cpAmm as any).getPositionsByUser(userPubkey);

      if (userDammPositions && userDammPositions.length > 0) {
        // Group positions by pool address
        const byPool = new Map<string, any[]>();
        for (const pos of userDammPositions) {
          const poolAddr = pos.positionState?.pool?.toBase58() ?? '';
          if (!poolAddr) continue;
          if (!byPool.has(poolAddr)) byPool.set(poolAddr, []);
          byPool.get(poolAddr)!.push(pos);
        }

        // Fetch pool state + metadata for each unique pool in parallel
        const poolEntries = await Promise.allSettled(
          [...byPool.entries()].map(async ([poolAddr, poolPositions]) => {
            const poolPubkey = new PublicKey(poolAddr);
            const poolState: any = await cpAmm.fetchPoolState(poolPubkey);
            const mintAAddr = poolState.tokenAMint.toBase58();
            const mintBAddr = poolState.tokenBMint.toBase58();

            const [metaDA, metaDB, priceData] = await Promise.all([
              this.deps.registry.resolveToken(mintAAddr),
              this.deps.registry.resolveToken(mintBAddr),
              this.deps.price.getPrices([mintAAddr, mintBAddr]),
            ]);

            const symbolA = metaDA?.symbol ?? mintAAddr.slice(0, 8);
            const symbolB = metaDB?.symbol ?? mintBAddr.slice(0, 8);
            const decimalsA = metaDA?.decimals ?? 9;
            const decimalsB = metaDB?.decimals ?? 6;
            if (!metaDA?.decimals || !metaDB?.decimals) {
              this.ctx.logger.verbose(`Using fallback decimals for DAMM position`);
            }
            const priceA = priceData.get(mintAAddr)?.priceUsd ?? 0;
            const priceB = priceData.get(mintBAddr)?.priceUsd ?? 0;

            const posInfos: LpPositionInfo[] = [];
            for (const pos of poolPositions) {
              const state = pos.positionState ?? pos;
              const amountA = tokenAmountToUi(
                (state.tokenAAmount ?? '0').toString(),
                decimalsA,
              );
              const amountB = tokenAmountToUi(
                (state.tokenBAmount ?? '0').toString(),
                decimalsB,
              );
              const valueUsd = amountA * priceA + amountB * priceB;

              const feeA = state.unclaimedFeeA
                ? tokenAmountToUi(state.unclaimedFeeA.toString(), decimalsA) : 0;
              const feeB = state.unclaimedFeeB
                ? tokenAmountToUi(state.unclaimedFeeB.toString(), decimalsB) : 0;
              const unclaimedFeesUsd = feeA * priceA + feeB * priceB;

              posInfos.push({
                positionId: pos.position?.toBase58() ?? pos.positionNftAccount?.toBase58() ?? '',
                poolId: poolAddr,
                protocol: 'meteora',
                poolType: 'amm',
                tokenA: symbolA,
                tokenB: symbolB,
                mintA: mintAAddr,
                mintB: mintBAddr,
                amountA,
                amountB,
                valueUsd,
                unclaimedFeesA: feeA,
                unclaimedFeesB: feeB,
                unclaimedFeesUsd,
              });
            }
            return posInfos;
          }),
        );

        for (const r of poolEntries) {
          if (r.status === 'fulfilled' && r.value.length > 0) {
            positions.push(...r.value);
          }
        }
      }
    } catch (err) {
      this.ctx.logger.verbose(`DAMM v2 position scan failed: ${err}`);
    }

    return positions;
  }

  // ── LpProvider: getDepositQuote ─────────────────────────

  async getDepositQuote(walletName: string, params: LpDepositParams): Promise<LpDepositQuote> {
    const connection = this.getConnection();
    const isDlmm = await this.isDlmmPool(params.poolId);

    if (isDlmm) {
      return this.getDlmmDepositQuote(connection, params);
    } else {
      return this.getDammDepositQuote(connection, params);
    }
  }

  private async getDlmmDepositQuote(
    connection: any,
    params: LpDepositParams,
  ): Promise<LpDepositQuote> {
    const dlmm = await (await getDLMM()).create(connection, new PublicKey(params.poolId));
    const activeBin = await dlmm.getActiveBin();
    const activeBinId = activeBin.binId;
    const lbPair = dlmm.lbPair;

    const mintX = lbPair.tokenXMint.toBase58();
    const mintY = lbPair.tokenYMint.toBase58();
    const symbolA = await this.resolveSymbol(mintX);
    const symbolB = await this.resolveSymbol(mintY);
    const metaA = await this.deps.registry.resolveToken(mintX);
    const metaB = await this.deps.registry.resolveToken(mintY);
    if (metaA?.decimals == null || metaB?.decimals == null) {
      throw new Error(`Cannot resolve decimals for ${metaA?.decimals == null ? mintX : mintY}`);
    }
    const decimalsA = metaA.decimals;
    const decimalsB = metaB.decimals;

    // Determine amounts
    let amountA = params.amountA ?? 0;
    let amountB = params.amountB ?? 0;

    // Single-token deposit: calculate second amount from pool ratio
    if (params.amount && params.token) {
      const tokenMeta = await this.resolveTokenStrict(params.token);
      if (tokenMeta.mint === mintX) {
        amountA = params.amount;
        // Calculate amountB from current price ratio
        const price = parseFloat(dlmm.fromPricePerLamport(Number(activeBin.price)).toString());
        if (price > 0) amountB = amountA * price;
      } else {
        amountB = params.amount;
        const price = parseFloat(dlmm.fromPricePerLamport(Number(activeBin.price)).toString());
        if (price > 0) amountA = amountB / price;
      }
    }

    // Calculate bin range
    let lowerPrice: number | undefined;
    let upperPrice: number | undefined;

    if (params.lowerPrice !== undefined && params.upperPrice !== undefined) {
      lowerPrice = params.lowerPrice;
      upperPrice = params.upperPrice;
    } else if (params.rangePct) {
      const currentPrice = parseFloat(dlmm.fromPricePerLamport(Number(activeBin.price)).toString());
      lowerPrice = currentPrice * (1 - params.rangePct / 100);
      upperPrice = currentPrice * (1 + params.rangePct / 100);
    }

    const prices = await this.deps.price.getPrices([mintX, mintY]);
    const priceA = prices.get(mintX)?.priceUsd ?? 0;
    const priceB = prices.get(mintY)?.priceUsd ?? 0;
    const estimatedValueUsd = amountA * priceA + amountB * priceB;
    const currentPrice = parseFloat(dlmm.fromPricePerLamport(Number(activeBin.price)).toString());

    return {
      poolId: params.poolId,
      protocol: 'meteora',
      tokenA: symbolA,
      tokenB: symbolB,
      amountA,
      amountB,
      estimatedValueUsd,
      priceImpactPct: null,
      lowerPrice,
      upperPrice,
      currentPrice,
    };
  }

  private async getDammDepositQuote(
    connection: any,
    params: LpDepositParams,
  ): Promise<LpDepositQuote> {
    const cpAmm = await getCpAmm(connection);
    const poolPubkey = new PublicKey(params.poolId);
    const poolState: any = await cpAmm.fetchPoolState(poolPubkey);

    const mintA = poolState.tokenAMint.toBase58();
    const mintB = poolState.tokenBMint.toBase58();
    const symbolA = await this.resolveSymbol(mintA);
    const symbolB = await this.resolveSymbol(mintB);

    let amountA = params.amountA ?? 0;
    let amountB = params.amountB ?? 0;

    // For single-token deposit, infer second amount from pool ratio
    if (params.amount && params.token) {
      const tokenMeta = await this.resolveTokenStrict(params.token);
      const reserveA = poolState.tokenAAmount ? Number(poolState.tokenAAmount) : 0;
      const reserveB = poolState.tokenBAmount ? Number(poolState.tokenBAmount) : 0;
      const ratio = reserveA > 0 ? reserveB / reserveA : 1;

      if (tokenMeta.mint === mintA) {
        amountA = params.amount;
        amountB = amountA * ratio;
      } else {
        amountB = params.amount;
        amountA = ratio > 0 ? amountB / ratio : 0;
      }
    }

    const prices = await this.deps.price.getPrices([mintA, mintB]);
    const priceA = prices.get(mintA)?.priceUsd ?? 0;
    const priceB = prices.get(mintB)?.priceUsd ?? 0;
    const estimatedValueUsd = amountA * priceA + amountB * priceB;

    return {
      poolId: params.poolId,
      protocol: 'meteora',
      tokenA: symbolA,
      tokenB: symbolB,
      amountA,
      amountB,
      estimatedValueUsd,
      priceImpactPct: null,
      currentPrice: priceA > 0 && priceB > 0 ? priceA / priceB : 0,
    };
  }

  // ── LpProvider: deposit ─────────────────────────────────

  async deposit(walletName: string, params: LpDepositParams): Promise<LpWriteResult> {
    const signer = await this.ctx.signer.getSigner(walletName);
    const connection = this.getConnection();
    const isDlmm = await this.isDlmmPool(params.poolId);

    if (isDlmm) {
      return this.dlmmDeposit(connection, signer, walletName, params);
    } else {
      return this.dammDeposit(connection, signer, walletName, params);
    }
  }

  private async dlmmDeposit(
    connection: any,
    signer: any,
    walletName: string,
    params: LpDepositParams,
  ): Promise<LpWriteResult> {
    const userPubkey = new PublicKey(signer.address);
    const dlmm = await (await getDLMM()).create(connection, new PublicKey(params.poolId));
    const activeBin = await dlmm.getActiveBin();
    const activeBinId = activeBin.binId;

    const lbPair = dlmm.lbPair;
    const mintX = lbPair.tokenXMint.toBase58();
    const mintY = lbPair.tokenYMint.toBase58();
    const metaA = await this.deps.registry.resolveToken(mintX);
    const metaB = await this.deps.registry.resolveToken(mintY);
    if (metaA?.decimals == null || metaB?.decimals == null) {
      throw new Error(`Cannot resolve decimals for ${metaA?.decimals == null ? mintX : mintY}`);
    }
    const decimalsA = metaA.decimals;
    const decimalsB = metaB.decimals;

    // Resolve amounts
    let amountA = params.amountA ?? 0;
    let amountB = params.amountB ?? 0;
    if (params.amount && params.token) {
      const tokenMeta = await this.resolveTokenStrict(params.token);
      const price = parseFloat(dlmm.fromPricePerLamport(Number(activeBin.price)).toString());
      if (tokenMeta.mint === mintX) {
        amountA = params.amount;
        if (price > 0) amountB = amountA * price;
      } else {
        amountB = params.amount;
        if (price > 0) amountA = amountB / price;
      }
    }

    const totalXAmount = new BN(uiToTokenAmount(amountA, decimalsA).toString());
    const totalYAmount = new BN(uiToTokenAmount(amountB, decimalsB).toString());

    // Calculate bin range
    let minBinId: number;
    let maxBinId: number;

    if (params.lowerPrice !== undefined && params.upperPrice !== undefined) {
      // User-specified prices are human-readable — convert to per-lamport for getBinIdFromPrice
      const lowerPerLamport = parseFloat(dlmm.toPricePerLamport(params.lowerPrice).toString());
      const upperPerLamport = parseFloat(dlmm.toPricePerLamport(params.upperPrice).toString());
      minBinId = dlmm.getBinIdFromPrice(lowerPerLamport, true);
      maxBinId = dlmm.getBinIdFromPrice(upperPerLamport, false);
    } else {
      // activeBin.price is already per-lamport — scale directly
      const rangePct = params.rangePct ?? 10;
      const currentPricePerLamport = Number(activeBin.price);
      const lower = currentPricePerLamport * (1 - rangePct / 100);
      const upper = currentPricePerLamport * (1 + rangePct / 100);
      minBinId = dlmm.getBinIdFromPrice(lower, true);
      maxBinId = dlmm.getBinIdFromPrice(upper, false);
    }

    // Create new position keypair
    const positionKeypair = Keypair.generate();
    const positionPubKey = positionKeypair.publicKey;

    this.ctx.logger.verbose(
      `DLMM deposit: ${amountA} tokenA + ${amountB} tokenB, bins [${minBinId}, ${maxBinId}]`,
    );

    const tx = await dlmm.initializePositionAndAddLiquidityByStrategy({
      positionPubKey,
      user: userPubkey,
      totalXAmount,
      totalYAmount,
      strategy: {
        maxBinId,
        minBinId,
        strategyType: (await getStrategyType()).Spot,
      },
    });

    const depositIxs = this.extractInstructions(tx);

    // SOL wrapping: prepend wrap instructions if either token is native SOL
    const wrapIxs = await buildWrapSolInstructions(signer, [
      { mint: mintX, lamports: uiToTokenAmount(amountA, decimalsA) },
      { mint: mintY, lamports: uiToTokenAmount(amountB, decimalsB) },
    ]);
    const unwrapIxs = await buildUnwrapSolInstructions(signer, [mintX, mintY]);

    const allIxs = [...wrapIxs, ...depositIxs, ...unwrapIxs];

    // Inject position keypair signer — the DLMM SDK marks it as a signer
    // but toV2Instructions only produces role bits, not signer objects.
    // Build an ephemeral v2 signer from the position keypair.
    const v2PositionSigner = await this.createEphemeralSigner(positionKeypair);
    const injected = injectSigners(allIxs, [signer, v2PositionSigner]);

    const prices = await this.deps.price.getPrices([mintX, mintY]);
    const priceA = prices.get(mintX)?.priceUsd;

    const result = await this.deps.tx.buildAndSendTransaction(injected, signer, {
      txType: 'lp-deposit',
      walletName,
      fromMint: mintX,
      fromAmount: uiToTokenAmount(amountA, decimalsA).toString(),
      fromPriceUsd: priceA,
    });

    return {
      signature: result.signature,
      protocol: 'meteora',
      explorerUrl: result.explorerUrl,
      positionId: positionPubKey.toBase58(),
    };
  }

  /**
   * Create a v2 TransactionSigner from a v1 Keypair.
   * Needed to inject ephemeral signers (position accounts) into the v2 pipeline.
   */
  private async createEphemeralSigner(keypair: Keypair): Promise<any> {
    const { createKeyPairFromBytes, createSignerFromKeyPair, address: kitAddress } = await import('@solana/kit');

    // v1 Keypair.secretKey is 64 bytes (32 private + 32 public)
    const cryptoKeyPair = await createKeyPairFromBytes(keypair.secretKey, true);
    return await createSignerFromKeyPair(cryptoKeyPair);
  }

  private async dammDeposit(
    connection: any,
    signer: any,
    walletName: string,
    params: LpDepositParams,
  ): Promise<LpWriteResult> {
    const userPubkey = new PublicKey(signer.address);
    const cpAmm = await getCpAmm(connection);
    const poolPubkey = new PublicKey(params.poolId);
    const poolState: any = await cpAmm.fetchPoolState(poolPubkey);

    const mintA = poolState.tokenAMint.toBase58();
    const mintB = poolState.tokenBMint.toBase58();
    const metaA = await this.deps.registry.resolveToken(mintA);
    const metaB = await this.deps.registry.resolveToken(mintB);
    if (metaA?.decimals == null || metaB?.decimals == null) {
      throw new Error(`Cannot resolve decimals for ${metaA?.decimals == null ? mintA : mintB}`);
    }
    const decimalsA = metaA.decimals;
    const decimalsB = metaB.decimals;

    let amountA = params.amountA ?? 0;
    let amountB = params.amountB ?? 0;
    if (params.amount && params.token) {
      const tokenMeta = await this.resolveTokenStrict(params.token);
      const reserveA = poolState.tokenAAmount ? Number(poolState.tokenAAmount) : 0;
      const reserveB = poolState.tokenBAmount ? Number(poolState.tokenBAmount) : 0;
      const ratio = reserveA > 0 ? reserveB / reserveA : 1;

      if (tokenMeta.mint === mintA) {
        amountA = params.amount;
        amountB = amountA * ratio;
      } else {
        amountB = params.amount;
        amountA = ratio > 0 ? amountB / ratio : 0;
      }
    }

    const tokenAAmountIn = new BN(uiToTokenAmount(amountA, decimalsA).toString());
    const tokenBAmountIn = new BN(uiToTokenAmount(amountB, decimalsB).toString());

    // Create a new position
    const positionKeypair = Keypair.generate();

    this.ctx.logger.verbose(`DAMM v2 deposit: ${amountA} tokenA + ${amountB} tokenB`);

    // Calculate slippage-protected liquidityMin from pool reserves
    const slippageBps = params.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
    let liquidityMin = new BN(0);
    try {
      const totalLiquidity: any = poolState.lpSupply ?? poolState.lpAmount;
      const reserveA: any = poolState.tokenAAmount ?? poolState.vaultAAmount;
      const reserveB: any = poolState.tokenBAmount ?? poolState.vaultBAmount;
      if (totalLiquidity && Number(reserveA) > 0) {
        // Estimate liquidity from the smaller side's share of reserves
        const liquidityFromA = tokenAAmountIn.mul(new BN(String(totalLiquidity))).div(new BN(String(reserveA)));
        const liquidityFromB = Number(reserveB) > 0
          ? tokenBAmountIn.mul(new BN(String(totalLiquidity))).div(new BN(String(reserveB)))
          : liquidityFromA;
        const expectedLiquidity = BN.min(liquidityFromA, liquidityFromB);
        liquidityMin = expectedLiquidity.mul(new BN(10000 - slippageBps)).div(new BN(10000));
      }
    } catch {
      // Fall through with liquidityMin = 0
    }

    const tx = await (cpAmm as any).addLiquidity({
      owner: userPubkey,
      pool: poolPubkey,
      position: positionKeypair.publicKey,
      tokenAAmountIn,
      tokenBAmountIn,
      liquidityMin,
    });

    const depositIxs = this.extractInstructions(tx);

    // SOL wrapping: prepend wrap instructions if either token is native SOL
    const wrapIxs = await buildWrapSolInstructions(signer, [
      { mint: mintA, lamports: uiToTokenAmount(amountA, decimalsA) },
      { mint: mintB, lamports: uiToTokenAmount(amountB, decimalsB) },
    ]);
    const unwrapIxs = await buildUnwrapSolInstructions(signer, [mintA, mintB]);

    const allIxs = [...wrapIxs, ...depositIxs, ...unwrapIxs];

    const v2PositionSigner = await this.createEphemeralSigner(positionKeypair);
    const injected = injectSigners(allIxs, [signer, v2PositionSigner]);

    const prices = await this.deps.price.getPrices([mintA, mintB]);
    const priceA = prices.get(mintA)?.priceUsd;

    const result = await this.deps.tx.buildAndSendTransaction(injected, signer, {
      txType: 'lp-deposit',
      walletName,
      fromMint: mintA,
      fromAmount: uiToTokenAmount(amountA, decimalsA).toString(),
      fromPriceUsd: priceA,
    });

    return {
      signature: result.signature,
      protocol: 'meteora',
      explorerUrl: result.explorerUrl,
      positionId: positionKeypair.publicKey.toBase58(),
    };
  }

  // ── LpProvider: withdraw ────────────────────────────────

  async withdraw(walletName: string, params: LpWithdrawParams): Promise<LpWriteResult> {
    const signer = await this.ctx.signer.getSigner(walletName);
    const connection = this.getConnection();

    // Lightweight lookup — avoids full getPositions() price/amount computation
    const allPos = await this.findPositionPool(signer.address);
    const pos = allPos.find(p => p.positionId === params.positionId);
    if (!pos) throw new Error(`Position ${params.positionId} not found`);

    if (pos.poolType === 'clmm') {
      return this.dlmmWithdraw(connection, signer, walletName, params, pos);
    } else {
      return this.dammWithdraw(connection, signer, walletName, params, pos);
    }
  }

  private async dlmmWithdraw(
    connection: any,
    signer: any,
    walletName: string,
    params: LpWithdrawParams,
    pos: Pick<LpPositionInfo, 'poolId' | 'mintA' | 'mintB'>,
  ): Promise<LpWriteResult> {
    const userPubkey = new PublicKey(signer.address);
    const dlmm = await (await getDLMM()).create(connection, new PublicKey(pos.poolId));

    const userPositions = await dlmm.getPositionsByUserAndLbPair(userPubkey);
    const position = userPositions.userPositions.find(
      (p: any) => p.publicKey.toBase58() === params.positionId,
    );
    if (!position) throw new Error(`DLMM position ${params.positionId} not found on-chain`);

    const binIds = position.positionData.positionBinData.map((b: any) => b.binId);
    const fromBinId = Math.min(...binIds);
    const toBinId = Math.max(...binIds);
    const bps = new BN(Math.round((params.percent / 100) * 10000));
    const shouldClose = params.close ?? params.percent >= 100;

    this.ctx.logger.verbose(
      `DLMM withdraw: ${params.percent}% from position ${params.positionId}${shouldClose ? ' (closing)' : ''}, bins ${fromBinId}..${toBinId}`,
    );

    const txs = await dlmm.removeLiquidity({
      position: position.publicKey,
      user: userPubkey,
      fromBinId,
      toBinId,
      bps,
      shouldClaimAndClose: shouldClose,
    });

    const withdrawIxs = this.extractInstructions(txs);
    if (withdrawIxs.length === 0) {
      throw new Error('DLMM removeLiquidity returned no instructions — position may have no withdrawable liquidity');
    }

    // Unwrap WSOL after withdraw if either token is native SOL
    const unwrapIxs = await buildUnwrapSolInstructions(signer, [pos.mintA, pos.mintB]);
    const allIxs = [...withdrawIxs, ...unwrapIxs];

    const injected = injectSigners(allIxs, [signer]);

    const result = await this.deps.tx.buildAndSendTransaction(injected, signer, {
      txType: shouldClose ? 'lp-close' : 'lp-withdraw',
      walletName,
      toMint: pos.mintA,
    });

    return {
      signature: result.signature,
      protocol: 'meteora',
      explorerUrl: result.explorerUrl,
      positionId: params.positionId,
    };
  }

  private async dammWithdraw(
    connection: any,
    signer: any,
    walletName: string,
    params: LpWithdrawParams,
    pos: Pick<LpPositionInfo, 'poolId' | 'mintA' | 'mintB'>,
  ): Promise<LpWriteResult> {
    const userPubkey = new PublicKey(signer.address);
    const cpAmm = await getCpAmm(connection);
    const poolPubkey = new PublicKey(pos.poolId);
    const positionPubkey = new PublicKey(params.positionId);

    // Fetch position to get liquidity amount
    const positionAccount: any = await (cpAmm as any).fetchPositionState(positionPubkey);
    const totalLiquidity = positionAccount.unlockedLiquidity ?? positionAccount.liquidity ?? new BN(0);
    const withdrawLiquidity = totalLiquidity.mul(new BN(Math.round(params.percent))).div(new BN(100));

    // Calculate slippage-protected minimums from position's current amounts
    const slippageBps = params.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
    const slippageMul = new BN(10000 - slippageBps);
    const rawAmountA = new BN(String(positionAccount.tokenAAmount ?? 0));
    const rawAmountB = new BN(String(positionAccount.tokenBAmount ?? 0));
    const tokenAAmountMin = rawAmountA.mul(new BN(Math.round(params.percent))).div(new BN(100)).mul(slippageMul).div(new BN(10000));
    const tokenBAmountMin = rawAmountB.mul(new BN(Math.round(params.percent))).div(new BN(100)).mul(slippageMul).div(new BN(10000));

    this.ctx.logger.verbose(`DAMM v2 withdraw: ${params.percent}% from position ${params.positionId}`);

    const tx = await (cpAmm as any).removeLiquidity({
      owner: userPubkey,
      pool: poolPubkey,
      position: positionPubkey,
      liquidityAmount: withdrawLiquidity,
      tokenAAmountMin,
      tokenBAmountMin,
    });

    const withdrawIxs = this.extractInstructions(tx);

    // Unwrap WSOL after withdraw if either token is native SOL
    const unwrapIxs = await buildUnwrapSolInstructions(signer, [pos.mintA, pos.mintB]);
    const allIxs = [...withdrawIxs, ...unwrapIxs];

    const injected = injectSigners(allIxs, [signer]);

    const result = await this.deps.tx.buildAndSendTransaction(injected, signer, {
      txType: params.percent >= 100 ? 'lp-close' : 'lp-withdraw',
      walletName,
      toMint: pos.mintA,
    });

    return {
      signature: result.signature,
      protocol: 'meteora',
      explorerUrl: result.explorerUrl,
      positionId: params.positionId,
    };
  }

  // ── LpProvider: claimFees ───────────────────────────────

  async claimFees(walletName: string, positionId: string): Promise<LpWriteResult> {
    const signer = await this.ctx.signer.getSigner(walletName);
    const connection = this.getConnection();

    // Lightweight lookup — avoids full getPositions() price/amount computation
    const allPos = await this.findPositionPool(signer.address);
    const pos = allPos.find(p => p.positionId === positionId);
    if (!pos) throw new Error(`Position ${positionId} not found`);

    if (pos.poolType === 'clmm') {
      return this.dlmmClaimFees(connection, signer, walletName, positionId, pos);
    } else {
      return this.dammClaimFees(connection, signer, walletName, positionId, pos);
    }
  }

  private async dlmmClaimFees(
    connection: any,
    signer: any,
    walletName: string,
    positionId: string,
    pos: Pick<LpPositionInfo, 'poolId' | 'mintA' | 'mintB'>,
  ): Promise<LpWriteResult> {
    const userPubkey = new PublicKey(signer.address);
    const dlmm = await (await getDLMM()).create(connection, new PublicKey(pos.poolId));
    const positionPubkey = new PublicKey(positionId);

    this.ctx.logger.verbose(`DLMM claim fees for position ${positionId}`);

    const tx = await dlmm.claimSwapFee({
      owner: userPubkey,
      position: positionPubkey,
    });

    const claimIxs = this.extractInstructions(tx);
    // Unwrap WSOL after claiming fees if either token is native SOL
    const unwrapIxs = await buildUnwrapSolInstructions(signer, [pos.mintA, pos.mintB]);
    const allIxs = [...claimIxs, ...unwrapIxs];
    const injected = injectSigners(allIxs, [signer]);

    const result = await this.deps.tx.buildAndSendTransaction(injected, signer, {
      txType: 'lp-claim-fees',
      walletName,
    });

    return {
      signature: result.signature,
      protocol: 'meteora',
      explorerUrl: result.explorerUrl,
    };
  }

  private async dammClaimFees(
    connection: any,
    signer: any,
    walletName: string,
    positionId: string,
    pos: Pick<LpPositionInfo, 'poolId' | 'mintA' | 'mintB'>,
  ): Promise<LpWriteResult> {
    const userPubkey = new PublicKey(signer.address);
    const cpAmm = await getCpAmm(connection);
    const poolPubkey = new PublicKey(pos.poolId);
    const positionPubkey = new PublicKey(positionId);

    this.ctx.logger.verbose(`DAMM v2 claim fees for position ${positionId}`);

    const tx = await (cpAmm as any).claimPositionFee({
      owner: userPubkey,
      pool: poolPubkey,
      position: positionPubkey,
    });

    const claimIxs = this.extractInstructions(tx);
    // Unwrap WSOL after claiming fees if either token is native SOL
    const unwrapIxs = await buildUnwrapSolInstructions(signer, [pos.mintA, pos.mintB]);
    const allIxs = [...claimIxs, ...unwrapIxs];
    const injected = injectSigners(allIxs, [signer]);

    const result = await this.deps.tx.buildAndSendTransaction(injected, signer, {
      txType: 'lp-claim-fees',
      walletName,
    });

    return {
      signature: result.signature,
      protocol: 'meteora',
      explorerUrl: result.explorerUrl,
    };
  }

  // ── LpProvider: getConfigs ──────────────────────────────

  async getConfigs(_poolType?: PoolType): Promise<PoolConfig[]> {
    const connection = this.getConnection();
    const DLMM_PROGRAM = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');

    // PresetParameter2 discriminator (first 8 bytes of sha256("account:PresetParameter2"))
    const discriminator = Buffer.from([2, 15, 10, 252, 99, 246, 116, 42]);

    this.ctx.logger.verbose('Fetching Meteora DLMM PresetParameter2 accounts...');

    const accounts = await connection.getProgramAccounts(DLMM_PROGRAM, {
      filters: [{ memcmp: { offset: 0, bytes: discriminator.toString('base64'), encoding: 'base64' } }],
    });

    this.ctx.logger.verbose(`Found ${accounts.length} Meteora preset configs`);

    const configs: PoolConfig[] = [];
    for (const { pubkey, account } of accounts) {
      const data = account.data;
      if (data.length < 31) continue;

      // Layout: 8-byte discriminator, then PresetParameter2 fields
      // binStep: u16 @ offset 8
      // baseFactor: u16 @ offset 10
      // baseFeePowerFactor: u8 @ offset 30
      const binStep = data.readUInt16LE(8);
      const baseFactor = data.readUInt16LE(10);
      const baseFeePowerFactor = data.readUInt8(30);

      // baseFee = baseFactor * binStep * 10 * 10^baseFeePowerFactor / 1e7
      const feeBps = (baseFactor * binStep * 10 * Math.pow(10, baseFeePowerFactor)) / 1e7;

      configs.push({
        protocol: 'meteora',
        poolType: 'clmm',
        feeBps: Math.round(feeBps * 100) / 100,
        binStep,
        configId: pubkey.toBase58(),
      });
    }

    configs.sort((a, b) => (a.binStep ?? 0) - (b.binStep ?? 0) || a.feeBps - b.feeBps);
    return configs;
  }

  // ── LpProvider: createPool ──────────────────────────────

  async createPool(walletName: string, params: CreatePoolParams): Promise<LpWriteResult> {
    const signer = await this.ctx.signer.getSigner(walletName);
    const connection = this.getConnection();
    const userPubkey = new PublicKey(signer.address);

    const metaA = await this.resolveTokenStrict(params.mintA);
    const metaB = await this.resolveTokenStrict(params.mintB);

    const poolType = params.poolType ?? 'clmm';

    if (poolType === 'clmm') {
      return this.createDlmmPool(connection, signer, walletName, userPubkey, params, metaA, metaB);
    } else {
      throw new Error('DAMM v2 pool creation is not yet supported via CLI. Use Meteora app.');
    }
  }

  private async createDlmmPool(
    connection: any,
    signer: any,
    walletName: string,
    userPubkey: PublicKey,
    params: CreatePoolParams,
    metaA: TokenMetadata,
    metaB: TokenMetadata,
  ): Promise<LpWriteResult> {
    const binStep = params.binStep ?? 10;
    const initialPrice = params.initialPrice;

    if (!initialPrice) {
      throw new Error('Initial price is required for DLMM pool creation. Use --initial-price.');
    }

    this.ctx.logger.verbose(
      `Creating DLMM pool: ${metaA.symbol}/${metaB.symbol}, binStep=${binStep}, price=${initialPrice}`,
    );

    // Use createCustomizablePermissionlessLbPair2 for permissionless pool creation
    const dlmmMod = await getDLMM();
    const ActivationType = dlmmMod.ActivationType;
    const activeBinId = new BN(Math.round(Math.log(initialPrice) / Math.log(1 + binStep / 10000)));
    const tx = await (await getDLMM()).createCustomizablePermissionlessLbPair2(
      connection,
      new BN(binStep),
      new PublicKey(metaA.mint),
      new PublicKey(metaB.mint),
      activeBinId,
      new BN(params.feeTier ?? 25),
      ActivationType?.Slot ?? 0,
      false,
      userPubkey,
    );

    const instructions = this.extractInstructions(tx);
    const injected = injectSigners(instructions, [signer]);

    const result = await this.deps.tx.buildAndSendTransaction(injected, signer, {
      txType: 'lp-create-pool',
      walletName,
    });

    return {
      signature: result.signature,
      protocol: 'meteora',
      explorerUrl: result.explorerUrl,
    };
  }

  // ── LpProvider: farming ─────────────────────────────────

  async getFarms(walletAddress: string): Promise<LpFarmInfo[]> {
    // Meteora DLMM has built-in reward emissions on some pools.
    // The farm rewards are part of the position itself — no separate staking needed.
    // Return unclaimed rewards from positions as farm info.
    this.ctx.logger.verbose(`Fetching Meteora farm rewards for ${walletAddress}`);

    const positions = await this.getPositions(walletAddress);
    const farms: LpFarmInfo[] = [];

    for (const pos of positions) {
      if (pos.unclaimedRewards && pos.unclaimedRewards.length > 0) {
        farms.push({
          farmId: `${pos.poolId}-rewards`,
          poolId: pos.poolId,
          protocol: 'meteora',
          rewardTokens: pos.unclaimedRewards.map(r => ({
            token: r.token,
            mint: r.mint,
            apr: 0,
          })),
          stakedAmount: pos.amountA + pos.amountB,
          stakedValueUsd: pos.valueUsd,
          pendingRewards: pos.unclaimedRewards,
        });
      }
    }

    return farms;
  }

  async farmStake(_walletName: string, _positionId: string, _farmId: string): Promise<LpFarmResult> {
    throw new Error('Meteora DLMM does not require separate farm staking — rewards accrue automatically.');
  }

  async farmUnstake(_walletName: string, _positionId: string, _farmId: string): Promise<LpFarmResult> {
    throw new Error('Meteora DLMM does not require separate farm unstaking — rewards accrue automatically.');
  }

  async farmHarvest(walletName: string, farmId: string): Promise<LpFarmResult> {
    // Farm ID format: <poolId>-rewards
    // Harvesting rewards on DLMM is done via claimReward on the DLMM instance
    const poolId = farmId.replace(/-rewards$/, '');
    const signer = await this.ctx.signer.getSigner(walletName);
    const connection = this.getConnection();
    const userPubkey = new PublicKey(signer.address);

    const dlmm = await (await getDLMM()).create(connection, new PublicKey(poolId));
    const userPositions = await dlmm.getPositionsByUserAndLbPair(userPubkey);

    if (!userPositions || userPositions.userPositions.length === 0) {
      throw new Error(`No DLMM positions found for pool ${poolId}`);
    }

    // Claim rewards from first position
    const position = userPositions.userPositions[0];

    this.ctx.logger.verbose(`DLMM claim rewards for pool ${poolId}`);

    const tx = await dlmm.claimAllRewards({
      owner: userPubkey,
      positions: [position.publicKey],
    });

    const instructions = this.extractInstructions(tx);
    const injected = injectSigners(instructions, [signer]);

    const result = await this.deps.tx.buildAndSendTransaction(injected, signer, {
      txType: 'lp-claim-rewards',
      walletName,
    });

    return {
      signature: result.signature,
      protocol: 'meteora',
      explorerUrl: result.explorerUrl,
    };
  }
}
