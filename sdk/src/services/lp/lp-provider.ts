// ── Pool types ──────────────────────────────────────────

export type PoolType = 'amm' | 'clmm';

// ── Pool configuration (for `lp configs`) ────────────────

export interface PoolConfig {
  protocol: string;
  poolType: PoolType;
  feeBps: number;
  tickSpacing?: number;
  binStep?: number;
  createFeeSol?: number;
  configId?: string;
}

export interface LpPoolInfo {
  poolId: string;
  protocol: string;
  poolType: PoolType;
  tokenA: string;
  tokenB: string;
  mintA: string;
  mintB: string;
  tvlUsd: number | null;
  volume24hUsd: number | null;
  feeRate: number;
  apy: number | null;
  currentPrice: number;
  tickSpacing?: number;
  binStep?: number;
}

// ── Position types ──────────────────────────────────────

export interface LpPositionInfo {
  positionId: string;
  poolId: string;
  protocol: string;
  poolType: PoolType;
  tokenA: string;
  tokenB: string;
  mintA: string;
  mintB: string;
  amountA: number;
  amountB: number;
  valueUsd: number;
  unclaimedFeesA: number;
  unclaimedFeesB: number;
  unclaimedFeesUsd: number;
  unclaimedRewards?: { token: string; mint: string; amount: number; valueUsd: number }[];
  lowerPrice?: number;
  upperPrice?: number;
  inRange?: boolean;
  pnl?: LpPnlData;
}

export interface LpPnlData {
  depositValueUsd: number;
  holdValueUsd: number;
  ilUsd: number;
  ilPct: number;
  feesEarnedUsd: number;
  netPnlUsd: number;
  netPnlPct: number;
  feeToIlRatio: number | null;
  depositDate: string;
}

// ── Deposit types ───────────────────────────────────────

export interface LpDepositParams {
  poolId: string;
  positionId?: string;
  amountA?: number;
  amountB?: number;
  amount?: number;
  token?: string;
  lowerPrice?: number;
  upperPrice?: number;
  rangePct?: number;
  slippageBps?: number;
}

export interface LpDepositQuote {
  poolId: string;
  protocol: string;
  tokenA: string;
  tokenB: string;
  amountA: number;
  amountB: number;
  estimatedValueUsd: number;
  priceImpactPct: number | null;
  lowerPrice?: number;
  upperPrice?: number;
  currentPrice: number;
}

// ── Withdraw types ──────────────────────────────────────

export interface LpWithdrawParams {
  positionId: string;
  percent: number;
  close?: boolean;
  slippageBps?: number;
}

// ── Farm types ──────────────────────────────────────────

export interface LpFarmInfo {
  farmId: string;
  poolId: string;
  protocol: string;
  rewardTokens: { token: string; mint: string; apr: number }[];
  stakedAmount: number;
  stakedValueUsd: number;
  pendingRewards: { token: string; mint: string; amount: number; valueUsd: number }[];
}

export interface LpFarmResult {
  signature: string;
  protocol: string;
  explorerUrl: string;
}

// ── Write result ────────────────────────────────────────

export interface LpWriteResult {
  signature: string;
  protocol: string;
  explorerUrl: string;
  positionId?: string;
}

// ── Pool creation ───────────────────────────────────────

export interface CreatePoolParams {
  mintA: string;
  mintB: string;
  amountA: number;
  amountB: number;
  feeTier?: number;
  initialPrice?: number;
  poolType?: PoolType;
  tickSpacing?: number;
  binStep?: number;
}

// ── Provider interface ──────────────────────────────────

export interface LpProviderCapabilities {
  pools: boolean;
  positions: boolean;
  deposit: boolean;
  withdraw: boolean;
  claimFees: boolean;
  createPool: boolean;
  farming: boolean;
  closePosition: boolean;
}

export interface LpProvider {
  name: string;
  capabilities: LpProviderCapabilities;

  getPools(tokenA?: string, tokenB?: string, limit?: number): Promise<LpPoolInfo[]>;
  getPositions(walletAddress: string): Promise<LpPositionInfo[]>;
  getDepositQuote(walletName: string, params: LpDepositParams): Promise<LpDepositQuote>;
  deposit(walletName: string, params: LpDepositParams): Promise<LpWriteResult>;
  withdraw(walletName: string, params: LpWithdrawParams): Promise<LpWriteResult>;
  claimFees(walletName: string, positionId: string): Promise<LpWriteResult>;
  createPool?(walletName: string, params: CreatePoolParams): Promise<LpWriteResult>;

  getConfigs?(poolType?: PoolType): Promise<PoolConfig[]>;

  getFarms?(walletAddress: string): Promise<LpFarmInfo[]>;
  farmStake?(walletName: string, positionId: string, farmId: string): Promise<LpFarmResult>;
  farmUnstake?(walletName: string, positionId: string, farmId: string): Promise<LpFarmResult>;
  farmHarvest?(walletName: string, farmId: string): Promise<LpFarmResult>;
}

export const LP_PROTOCOL_NAMES = ['orca', 'raydium', 'meteora', 'kamino'] as const;
export type LpProtocolName = (typeof LP_PROTOCOL_NAMES)[number];

// ── Impermanent Loss calculation ────────────────────────

export interface ILResult {
  depositValueUsd: number;
  holdValueUsd: number;
  positionValueUsd: number;
  ilUsd: number;
  ilPct: number;
  feesEarnedUsd: number;
  netPnlUsd: number;
  netPnlPct: number;
  feeToIlRatio: number | null;
}

export function calculateIL(params: {
  depositAmountA: number;
  depositAmountB: number;
  depositPriceA: number;
  depositPriceB: number;
  currentAmountA: number;
  currentAmountB: number;
  currentPriceA: number;
  currentPriceB: number;
  unclaimedFeesUsd: number;
  feesClaimed: number;
  farmRewardsUsd: number;
}): ILResult {
  const depositValue =
    params.depositAmountA * params.depositPriceA +
    params.depositAmountB * params.depositPriceB;

  const holdValue =
    params.depositAmountA * params.currentPriceA +
    params.depositAmountB * params.currentPriceB;

  const positionValue =
    params.currentAmountA * params.currentPriceA +
    params.currentAmountB * params.currentPriceB;

  const ilUsd = holdValue - positionValue;
  const ilPct = holdValue > 0 ? (ilUsd / holdValue) * 100 : 0;

  const totalFeesAndRewards =
    params.unclaimedFeesUsd + params.feesClaimed + params.farmRewardsUsd;

  const netPnlUsd = positionValue + totalFeesAndRewards - depositValue;

  return {
    depositValueUsd: depositValue,
    holdValueUsd: holdValue,
    positionValueUsd: positionValue,
    ilUsd,
    ilPct,
    feesEarnedUsd: totalFeesAndRewards,
    netPnlUsd,
    netPnlPct: depositValue > 0 ? (netPnlUsd / depositValue) * 100 : 0,
    feeToIlRatio: ilUsd > 0 ? totalFeesAndRewards / ilUsd : null,
  };
}
