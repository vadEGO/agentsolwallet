// ── SDK entry ────────────────────────────────────────────────
export { createSolSdk, registerDefaultProviders } from './sdk.js';
export type { SolSdk } from './sdk.js';

// ── Context & DI interfaces ─────────────────────────────────
export type {
  SolContext, SolSdkOptions, Logger, ConfigProvider, CacheProvider,
  TransactionLogger, SignerProvider, SendResult, TxLogEntry,
  PriceCacheEntry, TokenCacheEntry, TokenUpsert, TokenListCacheRow,
  SnapshotRow, SnapshotEntryRow,
} from './types.js';

// ── Default implementations ──────────────────────────────────
export { InMemoryCache, InMemoryConfig, NoopLogger, NoopTransactionLogger } from './defaults.js';

// ── Transaction service ──────────────────────────────────────
export { ErrorClass, classifyError, injectSigners } from './services/transaction-service.js';
export type { TransactionService, BuildAndSendOpts, SendEncodedOpts } from './services/transaction-service.js';

// ── Price service ────────────────────────────────────────────
export type { PriceService, PriceResult } from './services/price-service.js';

// ── Token registry service ───────────────────────────────────
export type { TokenRegistryService, TokenMetadata } from './services/token-registry-service.js';

// ── Token service ────────────────────────────────────────────
export type { TokenService, TokenBalance, TokenAccountInfo } from './services/token-service.js';

// ── Token lists service ──────────────────────────────────────
export type { TokenListsService, TokenListEntry, CategoryInfo } from './services/token-lists-service.js';

// ── Swap service ─────────────────────────────────────────────
export type { SwapService, SwapQuote, SwapResult } from './services/swap-service.js';
export type { SwapRouter, SwapQuoteRequest, SwapQuoteResult } from './services/swap/swap-router.js';

// ── Stake service ────────────────────────────────────────────
export { AGENTSOLWALLET_VOTE } from './services/stake-service.js';
export type { StakeService, StakeAccountInfo, CreateStakeResult, WithdrawStakeResult, ClaimMevResult } from './services/stake-service.js';

// ── Lend service ─────────────────────────────────────────────
export type { LendService } from './services/lend-service.js';
export { PROTOCOL_NAMES } from './services/lend/lend-provider.js';
export type { LendProvider, LendingRate, LendingPosition, LendWriteResult } from './services/lend/lend-provider.js';

// ── Earn service ─────────────────────────────────────────────
export type { EarnService, VaultsResult } from './services/earn-service.js';
export { EARN_PROTOCOL_NAMES } from './services/earn/earn-provider.js';
export type { EarnProvider, EarnVault, EarnPosition, EarnWriteResult } from './services/earn/earn-provider.js';

// ── LP service ──────────────────────────────────────────
export type { LpService, PoolsResult, PoolConfig } from './services/lp-service.js';
export { LP_PROTOCOL_NAMES } from './services/lp/lp-provider.js';
export { calculateIL } from './services/lp/lp-provider.js';
export type {
  LpProvider, LpPoolInfo, LpPositionInfo, LpDepositParams, LpDepositQuote,
  LpWithdrawParams, LpWriteResult, LpFarmInfo, LpFarmResult,
  CreatePoolParams, LpProviderCapabilities, LpPnlData, PoolType, ILResult,
} from './services/lp/lp-provider.js';

// ── Order service ────────────────────────────────────────────
export { parseInterval } from './services/order-service.js';
export type {
  OrderService, DcaOrder, DcaCreateResult, LimitOrder, LimitCreateResult,
  OpenOrderPosition,
} from './services/order-service.js';

// ── Predict service ──────────────────────────────────────────
export type { PredictService } from './services/predict-service.js';
export type {
  PredictProvider, PredictionEvent, PredictionMarket, PredictionOrderbook,
  PredictionPosition, PredictionHistoryEntry, PredictionOrderResult,
  PredictionCloseResult, PredictionClaimResult,
} from './services/predict/predict-provider.js';
export { PREDICT_CATEGORIES, PROVIDER_NAMES } from './services/predict/predict-provider.js';

// ── Portfolio service ────────────────────────────────────────
export type {
  PortfolioService, PortfolioReport, PortfolioPosition,
  AllocationEntry, CompareResult, CompareEntry,
} from './services/portfolio-service.js';

// ── X402 service ─────────────────────────────────────────────
export type { X402Service, X402FetchOptions, X402FetchResult, PaymentRequirements } from './services/x402-service.js';

// ── Onramp service ───────────────────────────────────────────
export type { OnrampService, OnrampProvider } from './services/onramp-service.js';

// ── Compat layers (v1↔v2 SDK bridges) ────────────────────
export {
  getKaminoRpc, kAddress, kSigner, getCurrentSlot,
  toV2Instructions as kaminoToV2Instructions,
  KLEND_PROGRAM_ID, KAMINO_MAIN_MARKET, RECENT_SLOT_DURATION_MS,
} from './compat/kamino-compat.js';
export {
  getV1Connection as getMarginFiV1Connection, DummyWallet as MarginFiDummyWallet,
  toV2Instructions as marginFiToV2Instructions,
} from './compat/marginfi-compat.js';
export {
  getV1Connection as getDriftV1Connection, DummyWallet as DriftDummyWallet,
  toV2Instructions as driftToV2Instructions,
} from './compat/drift-compat.js';

// ── Pure utilities ───────────────────────────────────────────
export {
  isValidAddress, lamportsToSol, solToLamports, uiToTokenAmount,
  tokenAmountToUi, shortenAddress, explorerUrl, SOL_MINT, SOL_DECIMALS,
} from './utils/solana.js';
export { WELL_KNOWN_TOKENS, getWellKnownBySymbol, getWellKnownByMint } from './utils/token-list.js';
export { fmtPrice, timed } from './utils/format.js';
export { withRetry, RateLimiter, isRetryableHttpError } from './utils/retry.js';
export { createNoopInstruction } from './utils/noop.js';
