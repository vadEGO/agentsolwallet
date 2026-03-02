import { Kamino } from '@kamino-finance/kliquidity-sdk';
import { address, type Address, type Instruction } from '@solana/kit';
import { buildWrapSolInstructions, buildUnwrapSolInstructions, buildEnsureAtaInstructions } from '../../utils/wsol.js';
import {
  getKaminoRpc,
  kAddress,
  kSigner,
  toV2Instructions,
} from '../../compat/kamino-compat.js';
import type { SolContext } from '../../types.js';
import type { TokenRegistryService, TokenMetadata } from '../token-registry-service.js';
import type { PriceService } from '../price-service.js';
import type { TransactionService } from '../transaction-service.js';
import type {
  LpProvider,
  LpProviderCapabilities,
  LpPoolInfo,
  LpPositionInfo,
  LpDepositParams,
  LpDepositQuote,
  LpWithdrawParams,
  LpWriteResult,
} from './lp-provider.js';

// ── Constants ────────────────────────────────────────────

const KAMINO_STRATEGIES_API = 'https://api.kamino.finance/strategies?status=LIVE';
const KAMINO_METRICS_API = 'https://api.kamino.finance/strategies/metrics?env=mainnet-beta';
const CACHE_TTL_MS = 120_000;

// ── API response types ───────────────────────────────────

/** Minimal data from /strategies — gives type + status + shareMint */
interface KaminoBaseStrategy {
  address: string;
  type: string;       // NON_PEGGED, PEGGED, STABLE
  shareMint: string;
  status: string;     // LIVE
  tokenAMint: string;
  tokenBMint: string;
}

/** Rich data from /strategies/metrics — gives TVL, APY, fees, prices */
interface KaminoMetricsStrategy {
  strategy: string;   // strategy address
  tokenAMint: string;
  tokenBMint: string;
  tokenA: string;     // symbol
  tokenB: string;     // symbol
  sharePrice: string;
  sharesIssued: string;
  totalValueLocked: string;
  apy: {
    vault: {
      feeApr: string;
      feeApy: string;
      totalApr: string;
      totalApy: string;
      poolPrice: string;
      priceLower: string;
      priceUpper: string;
      rewardsApr: string[];
      rewardsApy: string[];
      strategyOutOfRange: boolean;
    };
    totalApy: string;
  };
  kaminoApy: {
    vault: {
      apr7d: string;
      apy7d: string;
      apr24h: string;
      apy24h: string;
      apr30d: string;
      apy30d: string;
    };
    totalApy: string;
  };
  vaultBalances: {
    tokenA: { total: string; totalUsd: string };
    tokenB: { total: string; totalUsd: string };
  };
}

/** Merged strategy data for internal use */
interface KaminoApiStrategy {
  address: string;
  strategyType: string;
  tokenAMint: string;
  tokenBMint: string;
  tokenASymbol: string;
  tokenBSymbol: string;
  sharesMint: string;
  tvl: number;
  apy: number;
  feeApr: number;
  currentPrice: number;
  lowerPrice: number;
  upperPrice: number;
  outOfRange: boolean;
  /** Total shares issued (UI units from metrics API) */
  sharesIssued: number;
  /** Total token A in vault (UI units from metrics API) */
  vaultBalanceA: number;
  /** Total token B in vault (UI units from metrics API) */
  vaultBalanceB: number;
}

// ── Caching ──────────────────────────────────────────────

let apiCache: KaminoApiStrategy[] = [];
let apiCacheTs = 0;

// ── Dependencies ─────────────────────────────────────────

export interface KaminoLpDeps {
  registry: TokenRegistryService;
  price: PriceService;
  tx: TransactionService;
  rpcUrl: string;
}

// ── Helpers ──────────────────────────────────────────────

/** Lazily load Decimal constructor — cached after first import. */
let _decimalCls: any = null;
async function getDecimalCls(): Promise<any> {
  if (_decimalCls) return _decimalCls;
  const mod = (await import('decimal.js')) as any;
  _decimalCls = mod.default ?? mod.Decimal ?? mod;
  return _decimalCls;
}

// ── Provider ─────────────────────────────────────────────

export class KaminoLpProvider implements LpProvider {
  name = 'kamino' as const;

  capabilities: LpProviderCapabilities = {
    pools: true,
    positions: true,
    deposit: true,
    withdraw: true,
    claimFees: false,
    createPool: false,
    farming: false,
    closePosition: false,
  };

  private ctx: SolContext;
  private deps: KaminoLpDeps;
  private kaminoCache: Kamino | null = null;

  constructor(ctx: SolContext, deps: KaminoLpDeps) {
    this.ctx = ctx;
    this.deps = deps;
  }

  // ── SDK initialization ──────────────────────────────────

  private getKamino(): Kamino {
    if (!this.kaminoCache) {
      this.kaminoCache = new Kamino(
        'mainnet-beta',
        getKaminoRpc(this.ctx.rpc),
      );
    }
    return this.kaminoCache;
  }

  /** Fetch Kamino's main address lookup tables for transaction compression. */
  private async getLookupTableAddresses(): Promise<Address[]> {
    try {
      const kamino = this.getKamino();
      const pks = await kamino.getMainLookupTablePks();
      return pks.map((pk: any) => address(String(pk)));
    } catch {
      return [];
    }
  }

  // ── Helpers ─────────────────────────────────────────────

  private async resolveTokenStrict(symbolOrMint: string): Promise<TokenMetadata> {
    const meta = await this.deps.registry.resolveToken(symbolOrMint);
    if (!meta) throw new Error(`Unknown token: ${symbolOrMint}`);
    return meta;
  }

  private async fetchStrategiesApi(): Promise<KaminoApiStrategy[]> {
    if (Date.now() - apiCacheTs < CACHE_TTL_MS && apiCache.length > 0) {
      return apiCache;
    }

    this.ctx.logger.verbose('Fetching Kamino strategies from API...');

    // Fetch both endpoints in parallel: base (type/shareMint) + metrics (TVL/APY)
    const [baseResp, metricsResp] = await Promise.all([
      fetch(KAMINO_STRATEGIES_API),
      fetch(KAMINO_METRICS_API),
    ]);

    if (!baseResp.ok) throw new Error(`Kamino strategies API error ${baseResp.status}`);

    const baseData: KaminoBaseStrategy[] = await baseResp.json();

    // Build shareMint lookup from base endpoint
    const shareMintMap = new Map<string, string>();
    const typeMap = new Map<string, string>();
    for (const s of baseData) {
      shareMintMap.set(s.address, s.shareMint);
      typeMap.set(s.address, s.type);
    }

    // Parse metrics if available
    let metricsMap = new Map<string, KaminoMetricsStrategy>();
    if (metricsResp.ok) {
      try {
        const metricsData: KaminoMetricsStrategy[] = await metricsResp.json();
        for (const m of metricsData) {
          metricsMap.set(m.strategy, m);
        }
      } catch {
        this.ctx.logger.verbose('Kamino metrics API parse failed, using base data only');
      }
    }

    // Merge into unified format
    const merged: KaminoApiStrategy[] = baseData.map(base => {
      const metrics = metricsMap.get(base.address);
      const apy = metrics?.kaminoApy?.vault;
      const vaultApy = metrics?.apy?.vault;

      return {
        address: base.address,
        strategyType: base.type,
        tokenAMint: base.tokenAMint,
        tokenBMint: base.tokenBMint,
        tokenASymbol: metrics?.tokenA ?? '',
        tokenBSymbol: metrics?.tokenB ?? '',
        sharesMint: base.shareMint,
        tvl: metrics ? parseFloat(metrics.totalValueLocked) || 0 : 0,
        apy: apy ? parseFloat(apy.apy7d) || parseFloat(apy.apy24h) || 0 : 0,
        feeApr: vaultApy ? parseFloat(vaultApy.feeApr) || 0 : 0,
        currentPrice: vaultApy ? parseFloat(vaultApy.poolPrice) || 0 : 0,
        lowerPrice: vaultApy ? parseFloat(vaultApy.priceLower) || 0 : 0,
        upperPrice: vaultApy ? parseFloat(vaultApy.priceUpper) || 0 : 0,
        outOfRange: vaultApy?.strategyOutOfRange ?? false,
        sharesIssued: metrics ? parseFloat(metrics.sharesIssued) || 0 : 0,
        vaultBalanceA: metrics?.vaultBalances ? parseFloat(metrics.vaultBalances.tokenA.total) || 0 : 0,
        vaultBalanceB: metrics?.vaultBalances ? parseFloat(metrics.vaultBalances.tokenB.total) || 0 : 0,
      };
    });

    apiCache = merged;
    apiCacheTs = Date.now();
    return merged;
  }

  /**
   * Resolve token symbols for a pair of mints.
   * Returns [symbolA, symbolB, metaA, metaB].
   */
  private async resolveTokenPair(
    mintA: string,
    mintB: string,
  ): Promise<[string, string, TokenMetadata | undefined, TokenMetadata | undefined]> {
    const [metaA, metaB] = await Promise.all([
      this.deps.registry.resolveToken(mintA),
      this.deps.registry.resolveToken(mintB),
    ]);
    return [
      metaA?.symbol ?? mintA.slice(0, 6),
      metaB?.symbol ?? mintB.slice(0, 6),
      metaA,
      metaB,
    ];
  }

  // ── LpProvider: getPools ──────────────────────────────────

  async getPools(tokenA?: string, tokenB?: string, limit?: number): Promise<LpPoolInfo[]> {
    try {
      const strategies = await this.fetchStrategiesApi();

      // Resolve filter mints
      let mintFilterA: string | null = null;
      let mintFilterB: string | null = null;

      if (tokenA) {
        const meta = await this.deps.registry.resolveToken(tokenA);
        mintFilterA = meta?.mint ?? tokenA;
      }
      if (tokenB) {
        const meta = await this.deps.registry.resolveToken(tokenB);
        mintFilterB = meta?.mint ?? tokenB;
      }

      let filtered = strategies;
      if (mintFilterA || mintFilterB) {
        filtered = strategies.filter(s => {
          const mints = [s.tokenAMint, s.tokenBMint];
          if (mintFilterA && mintFilterB) {
            return mints.includes(mintFilterA!) && mints.includes(mintFilterB!);
          }
          if (mintFilterA) return mints.includes(mintFilterA!);
          if (mintFilterB) return mints.includes(mintFilterB!);
          return true;
        });
      }

      // Resolve symbols for all unique mints
      const mintSet = new Set<string>();
      for (const s of filtered) {
        mintSet.add(s.tokenAMint);
        mintSet.add(s.tokenBMint);
      }

      const symbolMap = new Map<string, TokenMetadata>();
      await Promise.all([...mintSet].map(async mint => {
        const meta = await this.deps.registry.resolveToken(mint);
        if (meta) symbolMap.set(mint, meta);
      }));

      const pools: LpPoolInfo[] = filtered.map(s => {
        const metaA = symbolMap.get(s.tokenAMint);
        const metaB = symbolMap.get(s.tokenBMint);

        return {
          poolId: s.address,
          protocol: 'kamino',
          poolType: 'clmm' as const,
          tokenA: s.tokenASymbol || metaA?.symbol || s.tokenAMint.slice(0, 6),
          tokenB: s.tokenBSymbol || metaB?.symbol || s.tokenBMint.slice(0, 6),
          mintA: s.tokenAMint,
          mintB: s.tokenBMint,
          tvlUsd: s.tvl || null,
          volume24hUsd: null,    // Kamino API doesn't provide volume
          feeRate: s.feeApr,     // fee APR as proxy for fee rate
          apy: s.apy || null,
          currentPrice: s.currentPrice,
        };
      });

      return limit ? pools.slice(0, limit) : pools;
    } catch (err: any) {
      this.ctx.logger.verbose(`Kamino LP getPools failed: ${err.message}`);
      return [];
    }
  }

  // ── LpProvider: getPositions ──────────────────────────────

  async getPositions(walletAddress: string): Promise<LpPositionInfo[]> {
    if (!walletAddress) return [];

    try {
      this.ctx.logger.verbose(`Fetching Kamino LP positions for ${walletAddress}`);

      const strategies = await this.fetchStrategiesApi();

      // Get all token accounts for the wallet to find kToken holdings
      const allTokenAccounts = await this.ctx.rpc.getTokenAccountsByOwner(
        address(walletAddress),
        { programId: address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') },
        { encoding: 'jsonParsed' },
      ).send();

      // Build a map of mint -> balance from token accounts
      const balancesByMint = new Map<string, { balance: string; decimals: number }>();
      for (const account of allTokenAccounts.value) {
        const parsed = (account.account.data as any)?.parsed?.info;
        if (!parsed) continue;
        const mint = parsed.mint as string;
        const amount: string = parsed.tokenAmount?.amount ?? '0';
        if (amount !== '0') {
          balancesByMint.set(mint, {
            balance: amount,
            decimals: parsed.tokenAmount?.decimals ?? 0,
          });
        }
      }

      if (balancesByMint.size === 0) return [];

      // Build a map of sharesMint -> strategy for quick lookup
      const strategyByShareMint = new Map<string, KaminoApiStrategy>();
      for (const s of strategies) {
        if (s.sharesMint) {
          strategyByShareMint.set(s.sharesMint, s);
        }
      }

      // Find strategies where user holds kTokens
      const matchedStrategies: { strategy: KaminoApiStrategy; shareBalance: string; shareDecimals: number }[] = [];
      for (const [mint, info] of balancesByMint) {
        const strat = strategyByShareMint.get(mint);
        if (strat) {
          matchedStrategies.push({
            strategy: strat,
            shareBalance: info.balance,
            shareDecimals: info.decimals,
          });
        }
      }

      if (matchedStrategies.length === 0) return [];

      // Collect all mints we need prices for
      const priceMints = new Set<string>();
      for (const { strategy: strat } of matchedStrategies) {
        priceMints.add(strat.tokenAMint);
        priceMints.add(strat.tokenBMint);
      }

      const prices = await this.deps.price.getPrices([...priceMints]);

      // Compute proportional token amounts from API data (no RPC calls needed)
      const positions: LpPositionInfo[] = [];

      for (const { strategy: strat, shareBalance, shareDecimals } of matchedStrategies) {
        if (!strat.sharesIssued) continue;

        const userSharesUi = parseFloat(shareBalance) / Math.pow(10, shareDecimals);
        const shareRatio = userSharesUi / strat.sharesIssued;

        const userTokenA = strat.vaultBalanceA * shareRatio;
        const userTokenB = strat.vaultBalanceB * shareRatio;

        const priceA = prices.get(strat.tokenAMint)?.priceUsd ?? 0;
        const priceB = prices.get(strat.tokenBMint)?.priceUsd ?? 0;
        const valueUsd = userTokenA * priceA + userTokenB * priceB;

        const symbolA = strat.tokenASymbol || strat.tokenAMint.slice(0, 6);
        const symbolB = strat.tokenBSymbol || strat.tokenBMint.slice(0, 6);

        positions.push({
          positionId: strat.address,
          poolId: strat.address,
          protocol: 'kamino',
          poolType: 'clmm',
          tokenA: symbolA,
          tokenB: symbolB,
          mintA: strat.tokenAMint,
          mintB: strat.tokenBMint,
          amountA: userTokenA,
          amountB: userTokenB,
          valueUsd,
          unclaimedFeesA: 0,
          unclaimedFeesB: 0,
          unclaimedFeesUsd: 0,
          lowerPrice: strat.lowerPrice,
          upperPrice: strat.upperPrice,
          inRange: !strat.outOfRange,
        });
      }

      return positions;
    } catch (err: any) {
      this.ctx.logger.verbose(`Kamino LP getPositions failed: ${err.message}`);
      return [];
    }
  }

  // ── LpProvider: getDepositQuote ───────────────────────────

  async getDepositQuote(walletName: string, params: LpDepositParams): Promise<LpDepositQuote> {
    const kamino = this.getKamino();
    const strategyAddress = params.poolId;

    const strategy = await kamino.getStrategyByAddress(kAddress(strategyAddress));
    if (!strategy) throw new Error(`Kamino strategy not found: ${strategyAddress}`);

    const mintA = String(strategy.tokenAMint);
    const mintB = String(strategy.tokenBMint);

    const [symbolA, symbolB] = await this.resolveTokenPair(mintA, mintB);

    // Get share data for current price and range
    const shareData = await kamino.getStrategyShareData(kAddress(strategyAddress));
    const currentPrice: number = (shareData.balance.prices as any).poolPrice.toNumber();
    const lowerPrice: number = (shareData.balance.prices as any).lowerPrice.toNumber();
    const upperPrice: number = (shareData.balance.prices as any).upperPrice.toNumber();

    // Determine deposit amounts
    let amountA = 0;
    let amountB = 0;

    if (params.amountA != null && params.amountB != null) {
      amountA = params.amountA;
      amountB = params.amountB;
    } else if (params.amount != null && params.token) {
      // Single-token deposit -- estimate the other side based on current ratio
      const tokenStr = params.token.toLowerCase();
      const isTokenA =
        tokenStr === symbolA.toLowerCase() ||
        tokenStr === mintA;

      const tokenAAmounts: any = shareData.balance.tokenAAmounts;
      const tokenBAmounts: any = shareData.balance.tokenBAmounts;

      if (isTokenA) {
        amountA = params.amount;
        if (!tokenAAmounts.isZero()) {
          amountB = tokenBAmounts.div(tokenAAmounts).mul(amountA).toNumber();
        }
      } else {
        amountB = params.amount;
        if (!tokenBAmounts.isZero()) {
          amountA = tokenAAmounts.div(tokenBAmounts).mul(amountB).toNumber();
        }
      }
    } else if (params.amountA != null) {
      amountA = params.amountA;
    } else if (params.amountB != null) {
      amountB = params.amountB;
    } else {
      throw new Error('Deposit amount required. Provide amount + token, or amountA/amountB.');
    }

    // Get USD value
    const prices = await this.deps.price.getPrices([mintA, mintB]);
    const priceA = prices.get(mintA)?.priceUsd ?? 0;
    const priceB = prices.get(mintB)?.priceUsd ?? 0;

    return {
      poolId: strategyAddress,
      protocol: 'kamino',
      tokenA: symbolA,
      tokenB: symbolB,
      amountA,
      amountB,
      estimatedValueUsd: amountA * priceA + amountB * priceB,
      priceImpactPct: null,
      lowerPrice,
      upperPrice,
      currentPrice,
    };
  }

  // ── LpProvider: deposit ───────────────────────────────────

  async deposit(walletName: string, params: LpDepositParams): Promise<LpWriteResult> {
    const kamino = this.getKamino();
    const signer = await this.ctx.signer.getSigner(walletName);
    const strategyAddress = params.poolId;
    const DecimalCls = await getDecimalCls();

    const strategy = await kamino.getStrategyByAddress(kAddress(strategyAddress));
    if (!strategy) throw new Error(`Kamino strategy not found: ${strategyAddress}`);

    const mintA = String(strategy.tokenAMint);
    const mintB = String(strategy.tokenBMint);

    const [symbolA, symbolB] = await this.resolveTokenPair(mintA, mintB);
    const slippageBps = new DecimalCls(params.slippageBps ?? 100);

    let instructions: Instruction[];

    if (params.amountA != null && params.amountB != null) {
      // Dual-token deposit
      const amountA = new DecimalCls(params.amountA);
      const amountB = new DecimalCls(params.amountB);

      if (amountA.isZero() && amountB.isZero()) {
        throw new Error(
          'Deposit amount required. Provide --amount with --token for single-sided, ' +
          'or amountA / amountB for dual-sided.',
        );
      }

      this.ctx.logger.verbose(
        `Kamino deposit: ${amountA} ${symbolA} + ${amountB} ${symbolB} ` +
        `into strategy ${strategyAddress}`,
      );

      // Build ATA creation instructions for tokenA, tokenB, and shares
      const ataIxs = await buildEnsureAtaInstructions(
        address(signer.address),
        [mintA, mintB, String(strategy.sharesMint)],
      );

      // If either token is native SOL, wrap it: transfer lamports → ATA then syncNative
      const wrapIxs = await buildWrapSolInstructions(signer, [
        { mint: mintA, lamports: BigInt(amountA.mul(1e9).floor().toFixed(0)) },
        { mint: mintB, lamports: BigInt(amountB.mul(1e9).floor().toFixed(0)) },
      ]);

      const depositIx = await kamino.deposit(
        kAddress(strategyAddress),
        amountA,
        amountB,
        kSigner(signer),
      );

      // After deposit, close WSOL ATA to reclaim rent + unwrap remaining SOL
      const unwrapIxs = await buildUnwrapSolInstructions(signer, [mintA, mintB]);

      instructions = [
        ...ataIxs,
        ...wrapIxs,
        ...toV2Instructions([depositIx] as any[]),
        ...unwrapIxs,
      ];
    } else if (params.amount != null && params.token) {
      // Single-token deposit
      const tokenStr = params.token.toLowerCase();
      const isTokenA =
        tokenStr === symbolA.toLowerCase() ||
        tokenStr === mintA;

      const amountDecimal = new DecimalCls(params.amount);
      const depositMint = isTokenA ? mintA : mintB;
      const depositDecimals = isTokenA
        ? ((await this.deps.registry.resolveToken(mintA))?.decimals ?? 9)
        : ((await this.deps.registry.resolveToken(mintB))?.decimals ?? 6);

      this.ctx.logger.verbose(
        `Single-sided Kamino deposit: ${params.amount} ${params.token} ` +
        `into strategy ${strategyAddress}`,
      );

      // Wrap SOL if the deposit token is native SOL
      const wrapIxs = await buildWrapSolInstructions(signer, [
        { mint: depositMint, lamports: BigInt(amountDecimal.mul(Math.pow(10, depositDecimals)).floor().toFixed(0)) },
      ]);

      let result;
      if (isTokenA) {
        result = await kamino.singleSidedDepositTokenA(
          kAddress(strategyAddress),
          amountDecimal,
          kSigner(signer),
          slippageBps,
        );
      } else {
        result = await kamino.singleSidedDepositTokenB(
          kAddress(strategyAddress),
          amountDecimal,
          kSigner(signer),
          slippageBps,
        );
      }

      const unwrapIxs = await buildUnwrapSolInstructions(signer, [mintA, mintB]);
      instructions = [...wrapIxs, ...toV2Instructions(result.instructions as any[]), ...unwrapIxs];
    } else {
      throw new Error(
        'Deposit amount required. Provide amount + token for single-sided, ' +
        'or amountA / amountB for dual-sided.',
      );
    }

    // Get prices and lookup tables in parallel
    const [prices, lookupTables] = await Promise.all([
      this.deps.price.getPrices([mintA, mintB]),
      this.getLookupTableAddresses(),
    ]);
    const priceA = prices.get(mintA)?.priceUsd;

    const sendResult = await this.deps.tx.buildAndSendTransaction(
      instructions,
      signer,
      {
        txType: 'lp_deposit',
        walletName,
        fromMint: mintA,
        fromPriceUsd: priceA,
        addressLookupTableAddresses: lookupTables,
      },
    );

    return {
      signature: sendResult.signature,
      protocol: 'kamino',
      explorerUrl: sendResult.explorerUrl,
      positionId: strategyAddress,
    };
  }

  // ── LpProvider: withdraw ──────────────────────────────────

  async withdraw(walletName: string, params: LpWithdrawParams): Promise<LpWriteResult> {
    const kamino = this.getKamino();
    const signer = await this.ctx.signer.getSigner(walletName);
    const strategyAddress = params.positionId;

    const strategy = await kamino.getStrategyByAddress(kAddress(strategyAddress));
    if (!strategy) throw new Error(`Kamino strategy not found: ${strategyAddress}`);

    const mintA = String(strategy.tokenAMint);
    const mintB = String(strategy.tokenBMint);

    // Ensure ATAs exist (e.g. WSOL ATA may have been closed after deposit)
    const ataIxs = await buildEnsureAtaInstructions(
      address(signer.address),
      [mintA, mintB, String(strategy.sharesMint)],
    );

    let allIxs: Instruction[];

    if (params.percent >= 100 || params.close) {
      // Withdraw all shares
      this.ctx.logger.verbose(`Withdrawing all shares from Kamino strategy ${strategyAddress}`);

      const result = await kamino.withdrawAllShares(
        kAddress(strategyAddress),
        kSigner(signer),
      );

      if (!result) {
        throw new Error('No shares to withdraw from this Kamino strategy');
      }

      const ixs: any[] = [
        ...result.prerequisiteIxs,
        result.withdrawIx,
      ];
      if (result.closeSharesAtaIx) {
        ixs.push(result.closeSharesAtaIx);
      }
      allIxs = [...ataIxs, ...toV2Instructions(ixs)];
    } else {
      // Partial withdraw by percentage
      this.ctx.logger.verbose(
        `Withdrawing ${params.percent}% from Kamino strategy ${strategyAddress}`,
      );

      // Get user's share balance
      const sharesMint = String(strategy.sharesMint);
      const shareBalance: any = await this.getUserShareBalance(
        signer.address,
        sharesMint,
        Number(strategy.sharesMintDecimals),
      );

      if (shareBalance.isZero()) {
        throw new Error('No shares to withdraw from this Kamino strategy');
      }

      const sharesToWithdraw = shareBalance.mul(params.percent).div(100);

      this.ctx.logger.verbose(
        `Withdrawing ${sharesToWithdraw.toFixed()} of ${shareBalance.toFixed()} shares`,
      );

      const result = await kamino.withdrawShares(
        kAddress(strategyAddress),
        sharesToWithdraw,
        kSigner(signer),
      );

      const ixs: any[] = [
        ...result.prerequisiteIxs,
        result.withdrawIx,
      ];
      if (result.closeSharesAtaIx) {
        ixs.push(result.closeSharesAtaIx);
      }
      allIxs = [...ataIxs, ...toV2Instructions(ixs)];
    }

    // Unwrap WSOL after withdraw if either token is native SOL
    const unwrapIxs = await buildUnwrapSolInstructions(signer, [mintA, mintB]);
    allIxs = [...allIxs, ...unwrapIxs];

    // Get prices and lookup tables in parallel
    const [prices, lookupTables] = await Promise.all([
      this.deps.price.getPrices([mintA, mintB]),
      this.getLookupTableAddresses(),
    ]);
    const priceA = prices.get(mintA)?.priceUsd;

    const sendResult = await this.deps.tx.buildAndSendTransaction(
      allIxs,
      signer,
      {
        txType: 'lp_withdraw',
        walletName,
        toMint: mintA,
        toPriceUsd: priceA,
        addressLookupTableAddresses: lookupTables,
      },
    );

    return {
      signature: sendResult.signature,
      protocol: 'kamino',
      explorerUrl: sendResult.explorerUrl,
      positionId: strategyAddress,
    };
  }

  // ── LpProvider: claimFees ─────────────────────────────────

  async claimFees(_walletName: string, _positionId: string): Promise<LpWriteResult> {
    throw new Error(
      'Kamino strategies auto-compound fees. No manual claim needed.',
    );
  }

  // ── Private helpers ───────────────────────────────────────

  /**
   * Get user's kToken (share) balance for a given strategy's sharesMint.
   * Returns a Decimal in UI units (divided by 10^decimals).
   */
  private async getUserShareBalance(
    walletAddress: string,
    sharesMint: string,
    sharesMintDecimals: number,
  ): Promise<any> {
    const DecimalCls = await getDecimalCls();

    try {
      const accounts = await this.ctx.rpc.getTokenAccountsByOwner(
        address(walletAddress),
        { mint: address(sharesMint) },
        { encoding: 'jsonParsed' },
      ).send();

      let totalBalance = new DecimalCls(0);
      for (const account of accounts.value) {
        const parsed = (account.account.data as any)?.parsed?.info;
        if (!parsed) continue;
        const amount = parsed.tokenAmount?.amount ?? '0';
        totalBalance = totalBalance.add(
          new DecimalCls(amount).div(new DecimalCls(10).pow(sharesMintDecimals)),
        );
      }

      return totalBalance;
    } catch {
      return new DecimalCls(0);
    }
  }

  /**
   * Build idempotent ATA creation instructions for deposit.
   * Kamino's deposit instruction expects ATAs to already exist.
   */
}
