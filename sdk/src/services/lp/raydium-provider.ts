import { Raydium, TickUtils, PoolUtils, SqrtPriceMath } from '@raydium-io/raydium-sdk-v2';
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import _DecimalDefault from 'decimal.js';

// decimal.js default import in ESM gives the Decimal constructor
const DecimalJS = _DecimalDefault as any;
import { type Instruction } from '@solana/kit';
import { getV1Connection, DummyWallet, toV2Instructions } from '../../compat/raydium-compat.js';
import { injectSigners, type TransactionService } from '../transaction-service.js';
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
  PoolType,
  PoolConfig,
} from './lp-provider.js';

// ── Constants ──────────────────────────────────────────────

const RAYDIUM_API_BASE = 'https://api-v3.raydium.io';
const RAYDIUM_CLMM_PROGRAM_ID = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
const SDK_CACHE_TTL_MS = 120_000;

// ── Dependency bundle ──────────────────────────────────────

export interface RaydiumLpDeps {
  registry: TokenRegistryService;
  price: PriceService;
  tx: TransactionService;
  rpcUrl: string;
}

// ── API response types ─────────────────────────────────────

interface RaydiumApiPoolItem {
  id: string;
  type: string;
  mintA: { address: string; symbol: string; decimals: number };
  mintB: { address: string; symbol: string; decimals: number };
  tvl: number;
  day?: { volume: number; apr: number; feeApr: number };
  week?: { volume: number; apr: number; feeApr: number };
  feeRate: number;
  price: number;
  config?: { tickSpacing?: number };
  lpMint?: { address: string };
  lpAmount?: number;
}

interface RaydiumApiPoolListResponse {
  success: boolean;
  data: {
    count: number;
    data: RaydiumApiPoolItem[];
    hasNextPage: boolean;
  };
}

interface RaydiumApiPoolInfoResponse {
  success: boolean;
  data: RaydiumApiPoolItem[];
}

interface RaydiumApiPositionLine {
  nftMint: string;
  poolId: string;
  liquidity: string;
  tokenA: { mint: string; symbol: string; amount: string; decimals: number };
  tokenB: { mint: string; symbol: string; amount: string; decimals: number };
  tickLower: number;
  tickUpper: number;
  priceLower: number;
  priceUpper: number;
  tokenFeeA: string;
  tokenFeeB: string;
  rewardInfos?: { mint: string; symbol: string; amount: string }[];
}

interface RaydiumApiFarmItem {
  id: string;
  poolId: string;
  lpMint: string;
  rewardInfos: { mint: { address: string; symbol: string }; apr: number }[];
  stakedLpAmount?: number;
  tvl?: number;
}

// ── Provider ───────────────────────────────────────────────

export class RaydiumLpProvider implements LpProvider {
  name = 'raydium' as const;

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

  private raydiumCache: { sdk: any; loadedAt: number; walletAddress?: string } | null = null;

  constructor(private ctx: SolContext, private deps: RaydiumLpDeps) {}

  // ── SDK initialization ─────────────────────────────────

  private async getRaydium(walletAddress?: string): Promise<any> {
    const now = Date.now();
    if (
      this.raydiumCache &&
      (now - this.raydiumCache.loadedAt) < SDK_CACHE_TTL_MS &&
      this.raydiumCache.walletAddress === walletAddress
    ) {
      return this.raydiumCache.sdk;
    }

    this.ctx.logger.verbose('Loading Raydium SDK...');
    const owner = walletAddress
      ? new DummyWallet(walletAddress).publicKey
      : PublicKey.default;

    const raydium = await Raydium.load({
      connection: getV1Connection(this.deps.rpcUrl),
      owner,
      cluster: 'mainnet',
      disableLoadToken: true,
    });

    this.raydiumCache = { sdk: raydium, loadedAt: now, walletAddress };
    return raydium;
  }

  private invalidateCache(): void {
    this.raydiumCache = null;
  }

  /**
   * Convert a v1 Keypair to a v2 TransactionSigner.
   * Needed for ephemeral signers (e.g. NFT mint keypair from openPositionFromBase).
   */
  private async createEphemeralSigner(keypair: any): Promise<any> {
    const { createKeyPairFromBytes, createSignerFromKeyPair } = await import('@solana/kit');
    // v1 Keypair.secretKey is 64 bytes (32 private + 32 public)
    const cryptoKeyPair = await createKeyPairFromBytes(keypair.secretKey, true);
    return await createSignerFromKeyPair(cryptoKeyPair);
  }

  // ── Helpers ────────────────────────────────────────────

  private async resolveTokenStrict(symbolOrMint: string): Promise<TokenMetadata> {
    const meta = await this.deps.registry.resolveToken(symbolOrMint);
    if (!meta) throw new Error(`Unknown token: ${symbolOrMint}`);
    return meta;
  }

  private mapPoolType(apiType: string): PoolType {
    if (apiType === 'Concentrated' || apiType === 'clmm') return 'clmm';
    return 'amm';
  }

  private mapApiPoolToInfo(pool: RaydiumApiPoolItem): LpPoolInfo {
    return {
      poolId: pool.id,
      protocol: 'raydium',
      poolType: this.mapPoolType(pool.type),
      tokenA: pool.mintA.symbol,
      tokenB: pool.mintB.symbol,
      mintA: pool.mintA.address,
      mintB: pool.mintB.address,
      tvlUsd: pool.tvl ?? null,
      volume24hUsd: pool.day?.volume ?? null,
      feeRate: pool.feeRate,
      apy: pool.day?.apr != null ? pool.day.apr / 100 : null,
      currentPrice: pool.price,
      tickSpacing: pool.config?.tickSpacing,
    };
  }

  // ── Read operations ──────────────────────────────────────

  async getPools(tokenA?: string, tokenB?: string, limit: number = 20): Promise<LpPoolInfo[]> {
    try {
      this.ctx.logger.verbose(`Fetching Raydium pools (tokenA=${tokenA}, tokenB=${tokenB}, limit=${limit})`);

      // If specific tokens requested, try to filter by mint
      let mintA: string | undefined;
      let mintB: string | undefined;

      if (tokenA) {
        const meta = await this.deps.registry.resolveToken(tokenA);
        if (meta) mintA = meta.mint;
      }
      if (tokenB) {
        const meta = await this.deps.registry.resolveToken(tokenB);
        if (meta) mintB = meta.mint;
      }

      // Use Raydium API for pool discovery
      if (mintA && mintB) {
        // Search for specific pair via pool info endpoint
        return await this.fetchPoolsByMints(mintA, mintB, limit);
      }

      // General pool listing
      const params = new URLSearchParams({
        poolType: 'all',
        poolSortField: 'liquidity',
        sortType: 'desc',
        pageSize: String(Math.min(limit, 100)),
        page: '1',
      });

      const url = `${RAYDIUM_API_BASE}/pools/info/list?${params}`;
      this.ctx.logger.verbose(`Fetching pool list: ${url}`);

      const res = await fetch(url);
      if (!res.ok) throw new Error(`Raydium API error: ${res.status}`);

      const json = (await res.json()) as RaydiumApiPoolListResponse;
      if (!json.success || !json.data?.data) return [];

      let pools = json.data.data.map(p => this.mapApiPoolToInfo(p));

      // Client-side filter if only one token specified
      if (mintA && !mintB) {
        pools = pools.filter(p => p.mintA === mintA || p.mintB === mintA);
      }

      return pools.slice(0, limit);
    } catch (err: any) {
      this.ctx.logger.verbose(`Failed to fetch Raydium pools: ${err.message}`);
      return [];
    }
  }

  private async fetchPoolsByMints(mintA: string, mintB: string, limit: number): Promise<LpPoolInfo[]> {
    const params = new URLSearchParams({
      mint1: mintA,
      mint2: mintB,
      poolType: 'all',
      poolSortField: 'default',
      sortType: 'desc',
      pageSize: String(Math.min(limit, 500)),
      page: '1',
    });

    const url = `${RAYDIUM_API_BASE}/pools/info/mint?${params}`;
    this.ctx.logger.verbose(`Fetching Raydium pools by mints: ${url}`);

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Raydium API error: ${res.status}`);

    const json = (await res.json()) as RaydiumApiPoolListResponse;
    if (!json.success || !json.data?.data) return [];

    return json.data.data.map(p => this.mapApiPoolToInfo(p)).slice(0, limit);
  }

  async getPositions(walletAddress: string): Promise<LpPositionInfo[]> {
    try {
      this.ctx.logger.verbose(`Fetching Raydium LP positions for ${walletAddress}`);

      const positions: LpPositionInfo[] = [];

      // Fetch CLMM positions and CPMM positions in parallel
      const [clmmPositions, cpmmPositions] = await Promise.allSettled([
        this.getClmmPositions(walletAddress),
        this.getCpmmPositions(walletAddress),
      ]);

      if (clmmPositions.status === 'fulfilled') {
        positions.push(...clmmPositions.value);
      } else {
        this.ctx.logger.verbose(`Failed to fetch CLMM positions: ${clmmPositions.reason}`);
      }

      if (cpmmPositions.status === 'fulfilled') {
        positions.push(...cpmmPositions.value);
      } else {
        this.ctx.logger.verbose(`Failed to fetch CPMM positions: ${cpmmPositions.reason}`);
      }

      return positions;
    } catch (err: any) {
      this.ctx.logger.verbose(`Failed to fetch Raydium positions: ${err.message}`);
      return [];
    }
  }

  private async getClmmPositions(walletAddress: string): Promise<LpPositionInfo[]> {
    const raydium = await this.getRaydium(walletAddress);

    // Fetch CLMM positions via SDK
    const positionData = await raydium.clmm.getOwnerPositionInfo({
      programId: RAYDIUM_CLMM_PROGRAM_ID,
    });

    if (!positionData || positionData.length === 0) return [];

    const poolIds: string[] = [...new Set<string>(positionData.map((p: any) => String(p.poolId.toBase58())))];

    // Hoist shared data: pool API info, epoch info, and all prices in parallel
    const connection = getV1Connection(this.deps.rpcUrl);
    const [poolInfoMap, epochInfo] = await Promise.all([
      this.fetchPoolInfoBatch(poolIds),
      connection.getEpochInfo(),
    ]);

    // Collect all mints for batch price lookup
    const allMints = new Set<string>();
    for (const pool of poolInfoMap.values()) {
      allMints.add(pool.mintA.address);
      allMints.add(pool.mintB.address);
    }
    // Also collect reward mints
    for (const pos of positionData) {
      if (pos.rewardInfos) {
        for (const r of pos.rewardInfos) {
          const mint = r.mint?.toBase58?.() ?? r.mint;
          if (mint && mint !== PublicKey.default.toBase58()) allMints.add(mint);
        }
      }
    }
    const allPrices = await this.deps.price.getPrices([...allMints]);

    // Fetch RPC pool info for each unique pool in parallel
    const rpcPoolInfoMap = new Map<string, any>();
    const rpcResults = await Promise.allSettled(
      poolIds.map(async id => {
        const info = await raydium.clmm.getPoolInfoFromRpc(id);
        rpcPoolInfoMap.set(id, info);
      }),
    );
    for (const r of rpcResults) {
      if (r.status === 'rejected') {
        this.ctx.logger.verbose(`Failed to fetch CLMM pool RPC info: ${r.reason?.message ?? r.reason}`);
      }
    }

    // Process positions in parallel
    const results = await Promise.allSettled(positionData.map(async (pos: any) => {
      const poolId = pos.poolId.toBase58();
      const pool = poolInfoMap.get(poolId);
      if (!pool) return null;

      const poolRpcInfo = rpcPoolInfoMap.get(poolId);
      if (!poolRpcInfo) return null;

      let amountA = 0;
      let amountB = 0;
      try {
        const amounts: any = await PoolUtils.getAmountsFromLiquidity({
          poolInfo: poolRpcInfo.poolInfo,
          tickLower: pos.tickLower,
          tickUpper: pos.tickUpper,
          liquidity: pos.liquidity,
          slippage: 0,
          add: false,
          epochInfo,
        });
        amountA = Number(amounts.amountA?.amount ?? amounts.amountA ?? 0) / Math.pow(10, pool.mintA.decimals);
        amountB = Number(amounts.amountB?.amount ?? amounts.amountB ?? 0) / Math.pow(10, pool.mintB.decimals);
      } catch (e: any) {
        this.ctx.logger.verbose(`Failed to calculate position amounts: ${e.message}`);
      }

      const priceA = allPrices.get(pool.mintA.address)?.priceUsd ?? 0;
      const priceB = allPrices.get(pool.mintB.address)?.priceUsd ?? 0;

      const valueUsd = amountA * priceA + amountB * priceB;

      const feeA = Number(pos.tokenFeesOwedA ?? 0) / Math.pow(10, pool.mintA.decimals);
      const feeB = Number(pos.tokenFeesOwedB ?? 0) / Math.pow(10, pool.mintB.decimals);
      const unclaimedFeesUsd = feeA * priceA + feeB * priceB;

      const priceLower = TickUtils.getTickPrice({
        poolInfo: poolRpcInfo.poolInfo,
        tick: pos.tickLower,
        baseIn: true,
      })?.price?.toNumber?.();
      const priceUpper = TickUtils.getTickPrice({
        poolInfo: poolRpcInfo.poolInfo,
        tick: pos.tickUpper,
        baseIn: true,
      })?.price?.toNumber?.();
      const currentPrice = pool.price;

      const inRange = priceLower != null && priceUpper != null
        ? currentPrice >= priceLower && currentPrice <= priceUpper
        : undefined;

      // Collect pending rewards
      const unclaimedRewards: { token: string; mint: string; amount: number; valueUsd: number }[] = [];
      if (pos.rewardInfos) {
        for (const reward of pos.rewardInfos) {
          const rewardMint = reward.mint?.toBase58?.() ?? reward.mint;
          if (!rewardMint || rewardMint === PublicKey.default.toBase58()) continue;
          const rewardAmount = Number(reward.amountOwed ?? 0) / Math.pow(10, reward.decimals ?? 9);
          if (rewardAmount <= 0) continue;
          const rewardPrice = allPrices.get(rewardMint)?.priceUsd ?? 0;
          const rewardMeta = await this.deps.registry.resolveToken(rewardMint);
          unclaimedRewards.push({
            token: rewardMeta?.symbol ?? rewardMint.slice(0, 8),
            mint: rewardMint,
            amount: rewardAmount,
            valueUsd: rewardAmount * rewardPrice,
          });
        }
      }

      return {
        positionId: pos.nftMint?.toBase58?.() ?? poolId,
        poolId,
        protocol: 'raydium' as const,
        poolType: 'clmm' as const,
        tokenA: pool.mintA.symbol,
        tokenB: pool.mintB.symbol,
        mintA: pool.mintA.address,
        mintB: pool.mintB.address,
        amountA,
        amountB,
        valueUsd,
        unclaimedFeesA: feeA,
        unclaimedFeesB: feeB,
        unclaimedFeesUsd,
        unclaimedRewards: unclaimedRewards.length > 0 ? unclaimedRewards : undefined,
        lowerPrice: priceLower,
        upperPrice: priceUpper,
        inRange,
      } satisfies LpPositionInfo;
    }));

    const positions: LpPositionInfo[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) positions.push(r.value);
    }
    return positions;
  }

  private async getCpmmPositions(walletAddress: string): Promise<LpPositionInfo[]> {
    // CPMM positions are tracked via LP token balances.
    // Fetch the user's token accounts and check against known CPMM pool LP mints.
    // This is a best-effort approach since there's no dedicated position API for CPMM.

    const raydium = await this.getRaydium(walletAddress);
    const positions: LpPositionInfo[] = [];

    try {
      // Get user's LP token balances from on-chain
      const connection = getV1Connection(this.deps.rpcUrl);
      const owner = new PublicKey(walletAddress);
      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(owner, {
        programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
      });

      if (tokenAccounts.value.length === 0) return [];

      // Filter for LP tokens with non-zero balance
      const lpCandidates: { mint: string; balance: number; decimals: number }[] = [];
      for (const account of tokenAccounts.value) {
        const info = account.account.data.parsed.info;
        const balance = Number(info.tokenAmount.uiAmount);
        if (balance <= 0) continue;
        lpCandidates.push({
          mint: info.mint,
          balance,
          decimals: info.tokenAmount.decimals,
        });
      }

      if (lpCandidates.length === 0) return [];

      // Check if any of these tokens are Raydium LP tokens by querying the API
      // Batch in groups to avoid URL length issues
      const batchSize = 10;
      for (let i = 0; i < lpCandidates.length; i += batchSize) {
        const batch = lpCandidates.slice(i, i + batchSize);
        const mintList = batch.map(c => c.mint).join(',');

        try {
          const url = `${RAYDIUM_API_BASE}/pools/info/lps?lps=${mintList}`;
          const res = await fetch(url);
          if (!res.ok) continue;

          const json = (await res.json()) as { success: boolean; data: Record<string, RaydiumApiPoolItem> };
          if (!json.success || !json.data) continue;

          for (const [lpMint, pool] of Object.entries(json.data)) {
            const candidate = batch.find(c => c.mint === lpMint);
            if (!candidate || !pool) continue;

            // Calculate proportional share of the pool
            const totalLpSupply = pool.lpAmount ?? 1;
            const share = totalLpSupply > 0 ? candidate.balance / totalLpSupply : 0;

            const prices = await this.deps.price.getPrices([pool.mintA.address, pool.mintB.address]);
            const priceA = prices.get(pool.mintA.address)?.priceUsd ?? 0;
            const priceB = prices.get(pool.mintB.address)?.priceUsd ?? 0;

            const poolTvl = pool.tvl ?? 0;
            const valueUsd = poolTvl * share;

            // Estimate token amounts from share of TVL
            const amountA = priceA > 0 ? (valueUsd / 2) / priceA : 0;
            const amountB = priceB > 0 ? (valueUsd / 2) / priceB : 0;

            positions.push({
              positionId: lpMint,
              poolId: pool.id,
              protocol: 'raydium',
              poolType: 'amm',
              tokenA: pool.mintA.symbol,
              tokenB: pool.mintB.symbol,
              mintA: pool.mintA.address,
              mintB: pool.mintB.address,
              amountA,
              amountB,
              valueUsd,
              unclaimedFeesA: 0,
              unclaimedFeesB: 0,
              unclaimedFeesUsd: 0,
            });
          }
        } catch (err: any) {
          this.ctx.logger.verbose(`Failed to check LP mints batch: ${err.message}`);
        }
      }
    } catch (err: any) {
      this.ctx.logger.verbose(`Failed to fetch CPMM positions: ${err.message}`);
    }

    return positions;
  }

  private async fetchPoolInfoBatch(poolIds: string[]): Promise<Map<string, RaydiumApiPoolItem>> {
    const map = new Map<string, RaydiumApiPoolItem>();
    if (poolIds.length === 0) return map;

    try {
      const ids = poolIds.join(',');
      const url = `${RAYDIUM_API_BASE}/pools/info/ids?ids=${ids}`;
      const res = await fetch(url);
      if (!res.ok) return map;

      const json = (await res.json()) as RaydiumApiPoolInfoResponse;
      if (!json.success || !json.data) return map;

      for (const pool of json.data) {
        map.set(pool.id, pool);
      }
    } catch (err: any) {
      this.ctx.logger.verbose(`Failed to fetch pool info batch: ${err.message}`);
    }

    return map;
  }

  /**
   * Enrich RPC-based pool info with reward data from the API.
   * The RPC info has rewardInfos (raw on-chain data) but not rewardDefaultInfos
   * (SDK-formatted reward data needed by decreaseLiquidity/closePosition).
   */
  private async enrichPoolInfoWithRewards(raydium: any, poolId: string, rpcPoolInfo: any): Promise<void> {
    if (rpcPoolInfo.rewardDefaultInfos && rpcPoolInfo.rewardDefaultInfos.length > 0) return;

    try {
      const apiData = await raydium.api.fetchPoolById({ ids: poolId });
      if (apiData?.[0]?.rewardDefaultInfos) {
        rpcPoolInfo.rewardDefaultInfos = apiData[0].rewardDefaultInfos;
      }
      if (apiData?.[0]?.rewardDefaultPoolInfos) {
        rpcPoolInfo.rewardDefaultPoolInfos = apiData[0].rewardDefaultPoolInfos;
      }
    } catch (e: any) {
      this.ctx.logger.verbose(`Failed to enrich pool with reward data: ${e.message}`);
    }
  }

  // ── Deposit ──────────────────────────────────────────────

  async getDepositQuote(walletName: string, params: LpDepositParams): Promise<LpDepositQuote> {
    const { poolId } = params;
    let { amountA, amountB, lowerPrice, upperPrice } = params;

    // Fetch pool info
    const poolInfoMap = await this.fetchPoolInfoBatch([poolId]);
    const pool = poolInfoMap.get(poolId);
    if (!pool) throw new Error(`Pool not found: ${poolId}`);

    const poolType = this.mapPoolType(pool.type);

    // Resolve single-token (amount/token) to amountA/amountB
    if (amountA == null && amountB == null && params.amount != null) {
      const tokenLower = (params.token ?? '').toLowerCase();
      const symbolB = (pool.mintB.symbol ?? '').toLowerCase();
      const isTokenB = tokenLower === symbolB || params.token === pool.mintB.address;
      if (isTokenB) {
        amountB = params.amount;
      } else {
        amountA = params.amount;
      }
    }

    // Resolve rangePct to lowerPrice/upperPrice
    if (lowerPrice == null && upperPrice == null && params.rangePct != null) {
      const currentPrice = pool.price;
      if (currentPrice && currentPrice > 0) {
        const pct = params.rangePct / 100;
        lowerPrice = currentPrice * (1 - pct);
        upperPrice = currentPrice * (1 + pct);
      }
    }

    const prices = await this.deps.price.getPrices([pool.mintA.address, pool.mintB.address]);
    const priceA = prices.get(pool.mintA.address)?.priceUsd ?? 0;
    const priceB = prices.get(pool.mintB.address)?.priceUsd ?? 0;

    const finalAmountA = amountA ?? 0;
    const finalAmountB = amountB ?? 0;
    const estimatedValueUsd = finalAmountA * priceA + finalAmountB * priceB;

    return {
      poolId,
      protocol: 'raydium',
      tokenA: pool.mintA.symbol,
      tokenB: pool.mintB.symbol,
      amountA: finalAmountA,
      amountB: finalAmountB,
      estimatedValueUsd,
      priceImpactPct: null,
      lowerPrice: poolType === 'clmm' ? lowerPrice : undefined,
      upperPrice: poolType === 'clmm' ? upperPrice : undefined,
      currentPrice: pool.price,
    };
  }

  async deposit(walletName: string, params: LpDepositParams): Promise<LpWriteResult> {
    const { poolId, slippageBps } = params;
    let { amountA, amountB, lowerPrice, upperPrice } = params;

    const signer = await this.ctx.signer.getSigner(walletName);
    const raydium = await this.getRaydium(signer.address);

    // Fetch pool info
    const poolInfoMap = await this.fetchPoolInfoBatch([poolId]);
    const pool = poolInfoMap.get(poolId);
    if (!pool) throw new Error(`Pool not found: ${poolId}`);

    const poolType = this.mapPoolType(pool.type);
    const slippage = (slippageBps ?? 50) / 10_000;

    // Resolve single-token (amount/token) to amountA/amountB
    if (amountA == null && amountB == null && params.amount != null) {
      const tokenLower = (params.token ?? '').toLowerCase();
      const symbolB = (pool.mintB.symbol ?? '').toLowerCase();
      const isTokenB = tokenLower === symbolB || params.token === pool.mintB.address;
      if (isTokenB) {
        amountB = params.amount;
      } else {
        // Default to token A (matches 'sol' → WSOL, etc.)
        amountA = params.amount;
      }
    }

    // Resolve rangePct to lowerPrice/upperPrice using pool's current price
    if (lowerPrice == null && upperPrice == null && params.rangePct != null) {
      const currentPrice = pool.price;
      if (!currentPrice || currentPrice <= 0) {
        throw new Error('Cannot resolve rangePct: pool has no valid current price');
      }
      const pct = params.rangePct / 100;
      lowerPrice = currentPrice * (1 - pct);
      upperPrice = currentPrice * (1 + pct);
    }

    let v1Instructions: any[] = [];
    const extraSigners: any[] = [];

    if (poolType === 'clmm') {
      // CLMM deposit — open position with range
      if (lowerPrice == null || upperPrice == null) {
        throw new Error('CLMM deposits require lowerPrice and upperPrice range parameters (use --range or --lower-price/--upper-price)');
      }

      const poolInfo = await raydium.clmm.getPoolInfoFromRpc(poolId);

      // Convert prices to ticks using SDK utilities
      const tickLower = TickUtils.getPriceAndTick({
        poolInfo: poolInfo.poolInfo,
        price: new DecimalJS(lowerPrice),
        baseIn: true,
      }).tick;
      const tickUpper = TickUtils.getPriceAndTick({
        poolInfo: poolInfo.poolInfo,
        price: new DecimalJS(upperPrice),
        baseIn: true,
      }).tick;

      // Determine which side the user is supplying
      const useBaseA = amountA != null && amountA > 0;
      const baseMint = useBaseA ? 'MintA' : 'MintB';
      const baseDecs = useBaseA ? pool.mintA.decimals : pool.mintB.decimals;
      const baseAmt = useBaseA ? amountA! : (amountB ?? 0);
      const baseAmountBN = new BN(Math.floor(baseAmt * Math.pow(10, baseDecs)));

      // Calculate the other side amount using SDK utilities
      const connection = getV1Connection(this.deps.rpcUrl);
      const epochInfo = await connection.getEpochInfo();
      const liquidityResult: any = PoolUtils.getLiquidityAmountOutFromAmountIn({
        poolInfo: poolInfo.poolInfo,
        inputA: useBaseA,
        tickLower,
        tickUpper,
        amount: baseAmountBN,
        slippage,
        add: true,
        epochInfo,
        amountHasFee: true,
      });
      // The result may be a promise
      const resolved = liquidityResult.then ? await liquidityResult : liquidityResult;
      const otherMax = useBaseA ? resolved.amountSlippageB : resolved.amountSlippageA;
      // amountSlippage values may be BN directly or objects with .amount
      const otherMaxBN = otherMax?.amount ?? otherMax;

      const result = await raydium.clmm.openPositionFromBase({
        poolInfo: poolInfo.poolInfo,
        poolKeys: poolInfo.poolKeys,
        ownerInfo: { useSOLBalance: true },
        tickLower,
        tickUpper,
        base: baseMint,
        baseAmount: baseAmountBN,
        otherAmountMax: new BN(otherMaxBN.toString()),
        txVersion: 'LEGACY' as any,
      } as any);

      // SDK returns { transaction, signers, execute } for LEGACY
      const tx = (result as any).transaction;
      if (tx?.instructions) {
        v1Instructions.push(...tx.instructions);
      }

      // Convert SDK ephemeral signers (v1 Keypair) to v2 TransactionSigners
      const sdkSigners: any[] = (result as any).signers ?? [];
      for (const kp of sdkSigners) {
        if (kp.secretKey) {
          const v2Signer = await this.createEphemeralSigner(kp);
          extraSigners.push(v2Signer);
        }
      }
    } else {
      // CPMM deposit
      const poolInfo = await raydium.cpmm.getPoolInfoFromRpc(poolId);
      const inputAmount = amountA
        ? BigInt(Math.floor(amountA * Math.pow(10, pool.mintA.decimals)))
        : BigInt(Math.floor((amountB ?? 0) * Math.pow(10, pool.mintB.decimals)));

      const cpmmResult = await raydium.cpmm.addLiquidity({
        poolInfo: poolInfo.poolInfo,
        poolKeys: poolInfo.poolKeys,
        inputAmount,
        baseIn: !!amountA,
        slippage,
        txVersion: 'LEGACY' as any,
      });
      const cpmmTx = (cpmmResult as any).transaction;
      if (cpmmTx?.instructions) v1Instructions.push(...cpmmTx.instructions);
    }

    if (v1Instructions.length === 0) {
      throw new Error('No deposit instructions generated');
    }

    const instructions = toV2Instructions(v1Instructions);

    const prices = await this.deps.price.getPrices([pool.mintA.address, pool.mintB.address]);
    const priceA = prices.get(pool.mintA.address)?.priceUsd;

    const result = await this.deps.tx.buildAndSendTransaction(
      injectSigners(instructions, [signer, ...extraSigners]),
      signer,
      {
        txType: 'lp_deposit',
        walletName,
        fromMint: pool.mintA.address,
        fromAmount: amountA?.toString(),
        fromPriceUsd: priceA,
      },
    );

    this.invalidateCache();

    return {
      signature: result.signature,
      protocol: 'raydium',
      explorerUrl: result.explorerUrl,
    };
  }

  // ── Withdraw ─────────────────────────────────────────────

  async withdraw(walletName: string, params: LpWithdrawParams): Promise<LpWriteResult> {
    const { positionId, percent, close, slippageBps } = params;

    const signer = await this.ctx.signer.getSigner(walletName);
    const raydium = await this.getRaydium(signer.address);
    const slippage = (slippageBps ?? 50) / 10_000;

    // Determine if this is a CLMM position (NFT) or CPMM position (LP token)
    // Try CLMM first — position NFT mint
    let v1Instructions: any[] = [];
    let poolMintA: string | undefined;
    let withdrawSuccess = false;

    try {
      // Try CLMM close/decrease position
      const positionData = await raydium.clmm.getOwnerPositionInfo({ programId: RAYDIUM_CLMM_PROGRAM_ID });
      const position = positionData?.find(
        (p: any) => p.nftMint?.toBase58?.() === positionId,
      );

      if (position) {
        const poolId = position.poolId.toBase58();
        const poolInfo = await raydium.clmm.getPoolInfoFromRpc(poolId);
        await this.enrichPoolInfoWithRewards(raydium, poolId, poolInfo.poolInfo);
        const poolInfoMap = await this.fetchPoolInfoBatch([poolId]);
        const pool = poolInfoMap.get(poolId);
        poolMintA = pool?.mintA.address;

        const liquidity = new BN(position.liquidity.toString());
        const withdrawLiquidity = (close || percent >= 100)
          ? liquidity
          : liquidity.mul(new BN(percent)).div(new BN(100));

        // Calculate slippage-protected minimums from expected amounts
        const connection = getV1Connection(this.deps.rpcUrl);
        const epochInfo = await connection.getEpochInfo();
        let amountMinA = new BN(0);
        let amountMinB = new BN(0);
        try {
          const expectedAmounts: any = await PoolUtils.getAmountsFromLiquidity({
            poolInfo: poolInfo.poolInfo,
            tickLower: position.tickLower,
            tickUpper: position.tickUpper,
            liquidity: withdrawLiquidity,
            slippage: 0,
            add: false,
            epochInfo,
          });
          const rawA = new BN(String(expectedAmounts.amountA?.amount ?? expectedAmounts.amountA ?? 0));
          const rawB = new BN(String(expectedAmounts.amountB?.amount ?? expectedAmounts.amountB ?? 0));
          const slippageMul = new BN(10000 - Math.round(slippage * 10000));
          amountMinA = rawA.mul(slippageMul).div(new BN(10000));
          amountMinB = rawB.mul(slippageMul).div(new BN(10000));
        } catch (e: any) {
          this.ctx.logger.verbose(`Could not compute withdraw minimums, using zero slippage protection: ${e.message}`);
        }

        // Step 1: Remove liquidity (required before close)
        const decreaseResult = await raydium.clmm.decreaseLiquidity({
          poolInfo: poolInfo.poolInfo,
          poolKeys: poolInfo.poolKeys,
          ownerPosition: position,
          ownerInfo: { useSOLBalance: true },
          liquidity: withdrawLiquidity,
          amountMinA,
          amountMinB,
          txVersion: 'LEGACY' as any,
        });
        const decreaseTx = (decreaseResult as any).transaction;
        if (decreaseTx?.instructions) v1Instructions.push(...decreaseTx.instructions);

        // Step 2: Close position if full withdraw
        if (close || percent >= 100) {
          // Update position to reflect 0 liquidity after decrease
          const updatedPosition = { ...position, liquidity: new BN(0), tokenFeesOwedA: new BN(0), tokenFeesOwedB: new BN(0) };
          const closeResult = await raydium.clmm.closePosition({
            poolInfo: poolInfo.poolInfo,
            poolKeys: poolInfo.poolKeys,
            ownerPosition: updatedPosition,
            ownerInfo: { useSOLBalance: true },
            txVersion: 'LEGACY' as any,
          });
          const closeTx = (closeResult as any).transaction;
          if (closeTx?.instructions) v1Instructions.push(...closeTx.instructions);
        }

        withdrawSuccess = true;
      }
    } catch (err: any) {
      this.ctx.logger.verbose(`CLMM withdraw attempt failed: ${err.message}`);
    }

    // If not CLMM, try CPMM
    if (!withdrawSuccess) {
      try {
        // For CPMM, positionId is the LP mint
        // Look up the pool by LP mint
        const url = `${RAYDIUM_API_BASE}/pools/info/lps?lps=${positionId}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Pool lookup failed: ${res.status}`);

        const json = (await res.json()) as { success: boolean; data: Record<string, RaydiumApiPoolItem> };
        if (!json.success || !json.data?.[positionId]) {
          throw new Error(`No pool found for LP mint: ${positionId}`);
        }

        const pool = json.data[positionId];
        poolMintA = pool.mintA.address;

        const poolInfo = await raydium.cpmm.getPoolInfoFromRpc(pool.id);

        // Get user's LP balance
        const connection = getV1Connection(this.deps.rpcUrl);
        const lpAccounts = await connection.getParsedTokenAccountsByOwner(
          new PublicKey(signer.address),
          { mint: new PublicKey(positionId) },
        );

        if (lpAccounts.value.length === 0) {
          throw new Error('No LP tokens found for this position');
        }

        const lpBalance = Number(lpAccounts.value[0].account.data.parsed.info.tokenAmount.amount);
        const withdrawAmount = BigInt(Math.floor(lpBalance * percent / 100));

        const cpmmResult = await raydium.cpmm.withdrawLiquidity({
          poolInfo: poolInfo.poolInfo,
          poolKeys: poolInfo.poolKeys,
          lpAmount: withdrawAmount,
          slippage,
          txVersion: 'LEGACY' as any,
        });
        // SDK returns { transaction } for LEGACY
        const cpmmTx = (cpmmResult as any).transaction ?? (cpmmResult as any).transactions?.[0]?.transaction;
        if (cpmmTx?.instructions) v1Instructions.push(...cpmmTx.instructions);

        withdrawSuccess = true;
      } catch (err: any) {
        throw new Error(`Failed to withdraw from Raydium position ${positionId}: ${err.message}`);
      }
    }

    if (v1Instructions.length === 0) {
      throw new Error('No withdraw instructions generated');
    }

    const instructions = toV2Instructions(v1Instructions);

    const result = await this.deps.tx.buildAndSendTransaction(
      injectSigners(instructions, [signer]),
      signer,
      {
        txType: 'lp_withdraw',
        walletName,
        toMint: poolMintA,
      },
    );

    this.invalidateCache();

    return {
      signature: result.signature,
      protocol: 'raydium',
      explorerUrl: result.explorerUrl,
    };
  }

  // ── Claim fees ───────────────────────────────────────────

  async claimFees(walletName: string, positionId: string): Promise<LpWriteResult> {
    const signer = await this.ctx.signer.getSigner(walletName);
    const raydium = await this.getRaydium(signer.address);

    // CLMM fee claiming — find the position by NFT mint
    const positionData = await raydium.clmm.getOwnerPositionInfo({ programId: RAYDIUM_CLMM_PROGRAM_ID });
    const position = positionData?.find(
      (p: any) => p.nftMint?.toBase58?.() === positionId,
    );

    if (!position) {
      throw new Error(`Position not found: ${positionId}. Fee claiming is only supported for CLMM positions.`);
    }

    const poolId = position.poolId.toBase58();
    const poolInfo = await raydium.clmm.getPoolInfoFromRpc(poolId);
    await this.enrichPoolInfoWithRewards(raydium, poolId, poolInfo.poolInfo);

    // Decrease liquidity by 0 to claim fees + rewards
    const claimResult = await raydium.clmm.decreaseLiquidity({
      poolInfo: poolInfo.poolInfo,
      poolKeys: poolInfo.poolKeys,
      ownerPosition: position,
      ownerInfo: { useSOLBalance: true },
      liquidity: new BN(0),
      amountMinA: new BN(0),
      amountMinB: new BN(0),
      txVersion: 'LEGACY' as any,
    });

    let v1Instructions: any[] = [];
    const claimTx = (claimResult as any).transaction;
    if (claimTx?.instructions) v1Instructions.push(...claimTx.instructions);

    if (v1Instructions.length === 0) {
      throw new Error('No claim instructions generated');
    }

    const instructions = toV2Instructions(v1Instructions);

    const poolInfoMap = await this.fetchPoolInfoBatch([poolId]);
    const pool = poolInfoMap.get(poolId);

    const result = await this.deps.tx.buildAndSendTransaction(
      injectSigners(instructions, [signer]),
      signer,
      {
        txType: 'lp_claim',
        walletName,
        toMint: pool?.mintA.address,
      },
    );

    this.invalidateCache();

    return {
      signature: result.signature,
      protocol: 'raydium',
      explorerUrl: result.explorerUrl,
    };
  }

  // ── Configs ──────────────────────────────────────────────

  async getConfigs(poolType?: PoolType): Promise<PoolConfig[]> {
    const raydium = await this.getRaydium();
    const configs: PoolConfig[] = [];

    if (!poolType || poolType === 'clmm') {
      const clmmConfigs = await raydium.api.getClmmConfigs();
      for (const c of clmmConfigs) {
        configs.push({
          protocol: 'raydium',
          poolType: 'clmm',
          feeBps: c.tradeFeeRate / 100,  // tradeFeeRate is in hundredths of bps
          tickSpacing: c.tickSpacing,
          configId: c.id,
        });
      }
    }

    if (!poolType || poolType === 'amm') {
      const cpmmConfigs = await raydium.api.getCpmmConfigs();
      for (const c of cpmmConfigs) {
        configs.push({
          protocol: 'raydium',
          poolType: 'amm',
          feeBps: c.tradeFeeRate / 100,
          createFeeSol: c.createPoolFee / 1e9,
          configId: c.id,
        });
      }
    }

    configs.sort((a, b) => a.feeBps - b.feeBps || (a.tickSpacing ?? 0) - (b.tickSpacing ?? 0));
    return configs;
  }

  // ── Create pool ──────────────────────────────────────────

  async createPool(walletName: string, params: CreatePoolParams): Promise<LpWriteResult> {
    const { mintA, mintB, amountA, amountB, initialPrice, poolType, tickSpacing } = params;

    const signer = await this.ctx.signer.getSigner(walletName);
    const raydium = await this.getRaydium(signer.address);

    const metaA = await this.resolveTokenStrict(mintA);
    const metaB = await this.resolveTokenStrict(mintB);

    let v1Instructions: any[] = [];
    let poolAddress: string | undefined;

    // Fetch AMM configs to find the right fee tier
    const configs = await raydium.api.getClmmConfigs();

    if (poolType === 'clmm') {
      // CLMM pool creation
      if (!initialPrice) throw new Error('CLMM pool creation requires initialPrice');

      // Match fee tier from params, or default to 100 (1bps)
      const targetFee = params.feeTier != null ? params.feeTier * 100 : 100;
      const ammConfig = configs.find((c: any) => c.tradeFeeRate === targetFee)
        ?? configs.find((c: any) => c.tradeFeeRate === 100)
        ?? configs[0];

      this.ctx.logger.verbose(
        `Raydium createPool CLMM: price=${initialPrice} fee=${ammConfig.tradeFeeRate} tickSpacing=${ammConfig.tickSpacing}`,
      );

      const result = await raydium.clmm.createPool({
        programId: new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK'),
        mint1: { address: mintA, decimals: metaA.decimals, programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
        mint2: { address: mintB, decimals: metaB.decimals, programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
        ammConfig: {
          id: new PublicKey(ammConfig.id),
          index: ammConfig.index,
          tickSpacing: ammConfig.tickSpacing,
        },
        initialPrice: new DecimalJS(initialPrice),
        startTime: BigInt(Math.floor(Date.now() / 1000)),
        txVersion: 'LEGACY' as any,
      } as any);

      if (result.transaction?.instructions) {
        v1Instructions.push(...result.transaction.instructions);
      }
      poolAddress = result.extInfo?.address ? result.extInfo.address.toBase58?.() ?? String(result.extInfo.address) : undefined;
    } else {
      // CPMM pool creation
      this.ctx.logger.verbose(`Raydium createPool CPMM: amountA=${amountA} amountB=${amountB}`);

      const result = await raydium.cpmm.createPool({
        programId: new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C'),
        poolFeeAccount: new PublicKey('G11FKBRaAkHAKuLCgLM6K6NUc9rTjPAznRCjZifrTQe2'),
        mint1: { address: mintA, decimals: metaA.decimals, programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
        mint2: { address: mintB, decimals: metaB.decimals, programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
        mintAAmount: BigInt(Math.floor(amountA * Math.pow(10, metaA.decimals))),
        mintBAmount: BigInt(Math.floor(amountB * Math.pow(10, metaB.decimals))),
        startTime: BigInt(Math.floor(Date.now() / 1000)),
        txVersion: 'LEGACY' as any,
      } as any);

      if (result.transaction?.instructions) {
        v1Instructions.push(...result.transaction.instructions);
      }
      poolAddress = result.extInfo?.address ? result.extInfo.address.toBase58?.() ?? String(result.extInfo.address) : undefined;
    }

    if (v1Instructions.length === 0) {
      throw new Error('No pool creation instructions generated');
    }

    const instructions = toV2Instructions(v1Instructions);

    const result = await this.deps.tx.buildAndSendTransaction(
      injectSigners(instructions, [signer]),
      signer,
      {
        txType: 'lp_create_pool',
        walletName,
        fromMint: mintA,
      },
    );

    this.invalidateCache();

    return {
      signature: result.signature,
      protocol: 'raydium',
      explorerUrl: result.explorerUrl,
      positionId: poolAddress,
    };
  }

  // ── Farming ──────────────────────────────────────────────

  async getFarms(walletAddress: string): Promise<LpFarmInfo[]> {
    try {
      this.ctx.logger.verbose(`Fetching Raydium farms for ${walletAddress}`);

      // Fetch farm list from API
      const url = `${RAYDIUM_API_BASE}/farms/info/list?pageSize=50&page=1`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Raydium farm API error: ${res.status}`);

      const json = (await res.json()) as { success: boolean; data: { data: RaydiumApiFarmItem[] } };
      if (!json.success || !json.data?.data) return [];

      const farms: LpFarmInfo[] = [];

      // Check user's staked positions in each farm
      const raydium = await this.getRaydium(walletAddress);

      for (const farm of json.data.data) {
        const rewardTokens = farm.rewardInfos.map(r => ({
          token: r.mint.symbol,
          mint: r.mint.address,
          apr: r.apr,
        }));

        // Check if user has staked LP tokens
        let stakedAmount = 0;
        let stakedValueUsd = 0;
        const pendingRewards: { token: string; mint: string; amount: number; valueUsd: number }[] = [];

        try {
          const farmPositions = await raydium.farm.getCreatorStakerInfo({
            farmId: farm.id,
          });

          if (farmPositions) {
            stakedAmount = Number(farmPositions.deposited ?? 0);
            // Estimate value from TVL and proportion
            if (farm.tvl && farm.stakedLpAmount && farm.stakedLpAmount > 0) {
              stakedValueUsd = (stakedAmount / farm.stakedLpAmount) * farm.tvl;
            }

            // Pending rewards
            if (farmPositions.pendingRewards) {
              for (let i = 0; i < farmPositions.pendingRewards.length; i++) {
                const pending = Number(farmPositions.pendingRewards[i] ?? 0);
                if (pending <= 0) continue;
                const rewardInfo = farm.rewardInfos[i];
                if (!rewardInfo) continue;
                const rewardPrice = (await this.deps.price.getPrice(rewardInfo.mint.address))?.priceUsd ?? 0;
                pendingRewards.push({
                  token: rewardInfo.mint.symbol,
                  mint: rewardInfo.mint.address,
                  amount: pending,
                  valueUsd: pending * rewardPrice,
                });
              }
            }
          }
        } catch {
          // User has no position in this farm — skip
          continue;
        }

        if (stakedAmount <= 0) continue;

        farms.push({
          farmId: farm.id,
          poolId: farm.poolId,
          protocol: 'raydium',
          rewardTokens,
          stakedAmount,
          stakedValueUsd,
          pendingRewards,
        });
      }

      return farms;
    } catch (err: any) {
      this.ctx.logger.verbose(`Failed to fetch Raydium farms: ${err.message}`);
      return [];
    }
  }

  async farmStake(walletName: string, positionId: string, farmId: string): Promise<LpFarmResult> {
    const signer = await this.ctx.signer.getSigner(walletName);
    const raydium = await this.getRaydium(signer.address);

    const farmInfo = await raydium.farm.getFarmInfoFromRpc({ farmId });
    if (!farmInfo) throw new Error(`Farm not found: ${farmId}`);

    // Get user's LP token balance
    const connection = getV1Connection(this.deps.rpcUrl);
    const lpMint = farmInfo.lpMint?.toBase58?.() ?? positionId;
    const lpAccounts = await connection.getParsedTokenAccountsByOwner(
      new PublicKey(signer.address),
      { mint: new PublicKey(lpMint) },
    );

    if (lpAccounts.value.length === 0) {
      throw new Error('No LP tokens found to stake');
    }

    const lpBalance = BigInt(lpAccounts.value[0].account.data.parsed.info.tokenAmount.amount);
    if (lpBalance <= BigInt(0)) {
      throw new Error('LP token balance is zero');
    }

    const { transactions } = await raydium.farm.deposit({
      farmInfo,
      amount: lpBalance,
      txVersion: 'LEGACY' as any,
    });

    let v1Instructions: any[] = [];
    for (const tx of transactions) {
      if (tx.transaction?.instructions) {
        v1Instructions.push(...tx.transaction.instructions);
      }
    }

    if (v1Instructions.length === 0) {
      throw new Error('No farm stake instructions generated');
    }

    const instructions = toV2Instructions(v1Instructions);

    const result = await this.deps.tx.buildAndSendTransaction(
      injectSigners(instructions, [signer]),
      signer,
      {
        txType: 'lp_farm_stake',
        walletName,
      },
    );

    this.invalidateCache();

    return {
      signature: result.signature,
      protocol: 'raydium',
      explorerUrl: result.explorerUrl,
    };
  }

  async farmUnstake(walletName: string, positionId: string, farmId: string): Promise<LpFarmResult> {
    const signer = await this.ctx.signer.getSigner(walletName);
    const raydium = await this.getRaydium(signer.address);

    const farmInfo = await raydium.farm.getFarmInfoFromRpc({ farmId });
    if (!farmInfo) throw new Error(`Farm not found: ${farmId}`);

    // Get user's staked amount
    const farmPositions = await raydium.farm.getCreatorStakerInfo({ farmId });
    if (!farmPositions || Number(farmPositions.deposited ?? 0) <= 0) {
      throw new Error('No staked LP tokens found in this farm');
    }

    const amount = BigInt(farmPositions.deposited.toString());

    const { transactions } = await raydium.farm.withdraw({
      farmInfo,
      amount,
      txVersion: 'LEGACY' as any,
    });

    let v1Instructions: any[] = [];
    for (const tx of transactions) {
      if (tx.transaction?.instructions) {
        v1Instructions.push(...tx.transaction.instructions);
      }
    }

    if (v1Instructions.length === 0) {
      throw new Error('No farm unstake instructions generated');
    }

    const instructions = toV2Instructions(v1Instructions);

    const result = await this.deps.tx.buildAndSendTransaction(
      injectSigners(instructions, [signer]),
      signer,
      {
        txType: 'lp_farm_unstake',
        walletName,
      },
    );

    this.invalidateCache();

    return {
      signature: result.signature,
      protocol: 'raydium',
      explorerUrl: result.explorerUrl,
    };
  }

  async farmHarvest(walletName: string, farmId: string): Promise<LpFarmResult> {
    const signer = await this.ctx.signer.getSigner(walletName);
    const raydium = await this.getRaydium(signer.address);

    const farmInfo = await raydium.farm.getFarmInfoFromRpc({ farmId });
    if (!farmInfo) throw new Error(`Farm not found: ${farmId}`);

    // Withdraw 0 to harvest rewards without unstaking
    const { transactions } = await raydium.farm.withdraw({
      farmInfo,
      amount: BigInt(0),
      txVersion: 'LEGACY' as any,
    });

    let v1Instructions: any[] = [];
    for (const tx of transactions) {
      if (tx.transaction?.instructions) {
        v1Instructions.push(...tx.transaction.instructions);
      }
    }

    if (v1Instructions.length === 0) {
      throw new Error('No farm harvest instructions generated');
    }

    const instructions = toV2Instructions(v1Instructions);

    const result = await this.deps.tx.buildAndSendTransaction(
      injectSigners(instructions, [signer]),
      signer,
      {
        txType: 'lp_farm_harvest',
        walletName,
      },
    );

    this.invalidateCache();

    return {
      signature: result.signature,
      protocol: 'raydium',
      explorerUrl: result.explorerUrl,
    };
  }
}
