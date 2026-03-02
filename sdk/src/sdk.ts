import type { SolContext, SolSdkOptions } from './types.js';
import { NoopLogger, NoopTransactionLogger, InMemoryCache, InMemoryConfig } from './defaults.js';
import { createTransactionService, type TransactionService } from './services/transaction-service.js';
import { createPriceService, type PriceService } from './services/price-service.js';
import { createTokenRegistryService, type TokenRegistryService } from './services/token-registry-service.js';
import { createTokenService, type TokenService } from './services/token-service.js';
import { createTokenListsService, type TokenListsService } from './services/token-lists-service.js';
import { createSwapService, type SwapService } from './services/swap-service.js';
import { createStakeService, type StakeService } from './services/stake-service.js';
import { createLendService, type LendService } from './services/lend-service.js';
import { createEarnService, type EarnService } from './services/earn-service.js';
import { createLpService, type LpService } from './services/lp-service.js';
import { createOrderService, type OrderService } from './services/order-service.js';
import { createPredictService, type PredictService } from './services/predict-service.js';
import { createPortfolioService, type PortfolioService } from './services/portfolio-service.js';
import { createX402Service, type X402Service } from './services/x402-service.js';
import { createOnrampService, type OnrampService } from './services/onramp-service.js';

export interface SolSdk {
  price: PriceService;
  token: TokenService;
  registry: TokenRegistryService;
  lists: TokenListsService;
  swap: SwapService;
  stake: StakeService;
  lend: LendService;
  earn: EarnService;
  lp: LpService;
  order: OrderService;
  predict: PredictService;
  portfolio: PortfolioService;
  x402: X402Service;
  onramp: OnrampService;
  tx: TransactionService;
  /** The context used by this SDK instance. Useful for creating custom services. */
  ctx: SolContext;
}

export function createSolSdk(opts: SolSdkOptions): SolSdk {
  const ctx: SolContext = {
    rpc: opts.rpc,
    rpcUrl: opts.rpcUrl,
    logger: opts.logger ?? new NoopLogger(),
    config: opts.config ?? new InMemoryConfig({}),
    cache: opts.cache ?? new InMemoryCache(),
    txLogger: opts.txLogger ?? new NoopTransactionLogger(),
    signer: opts.signer,
    analyticsInstruction: opts.analyticsInstruction,
  };

  // Foundation
  const tx = createTransactionService(ctx);

  // Read services
  const price = createPriceService(ctx);
  const registry = createTokenRegistryService(ctx);
  const token = createTokenService(ctx, registry);
  const lists = createTokenListsService(ctx);

  // Write services
  const swap = createSwapService(ctx, { price, registry, tx });
  const stake = createStakeService(ctx, tx);
  const lend = createLendService(ctx);
  const earn = createEarnService(ctx, { price });
  const lp = createLpService(ctx, { price });
  const order = createOrderService(ctx, { registry, price });
  const predict = createPredictService(ctx);

  // Aggregation
  const portfolio = createPortfolioService(ctx, { price, token, stake, lend, order, predict, earn, lp });

  // Utility services
  const x402 = createX402Service(ctx);
  const onramp = createOnrampService(ctx);

  return { price, token, registry, lists, swap, stake, lend, earn, lp, order, predict, portfolio, x402, onramp, tx, ctx };
}

/**
 * Register all built-in providers (lend, earn, predict).
 * Uses dynamic imports so optional peer deps (klend-sdk, drift, marginfi) are
 * gracefully skipped when not installed.
 */
export async function registerDefaultProviders(sdk: SolSdk): Promise<void> {
  const { ctx, lend, earn, lp, predict, tx, registry, price, token } = sdk;
  const rpcUrl = ctx.rpcUrl;

  // ── Lend providers ─────────────────────────────────────

  // Kamino (requires @kamino-finance/klend-sdk)
  try {
    const { KaminoProvider } = await import('./services/lend/kamino-provider.js');
    lend.registerProvider(new KaminoProvider(ctx, { registry, price, tx, token }));
  } catch (e: any) {
    ctx.logger.verbose(`Kamino lend provider skipped: ${e.message}`);
  }

  // MarginFi (requires @mrgnlabs/marginfi-client-v2)
  if (rpcUrl) {
    try {
      const { MarginfiProvider } = await import('./services/lend/marginfi-provider.js');
      lend.registerProvider(new MarginfiProvider(ctx, { registry, price, tx, rpcUrl }));
    } catch (e: any) {
      ctx.logger.verbose(`MarginFi lend provider skipped: ${e.message}`);
    }
  }

  // Drift (requires @drift-labs/sdk)
  if (rpcUrl) {
    try {
      const { DriftProvider } = await import('./services/lend/drift-provider.js');
      lend.registerProvider(new DriftProvider(ctx, { registry, price, tx, rpcUrl }));
    } catch (e: any) {
      ctx.logger.verbose(`Drift lend provider skipped: ${e.message}`);
    }
  }

  // Jupiter Lend (REST API only, no heavy deps)
  try {
    const { JupiterLendProvider } = await import('./services/lend/jupiter-lend-provider.js');
    lend.registerProvider(new JupiterLendProvider(ctx, { registry, price, tx }));
  } catch (e: any) {
    ctx.logger.verbose(`Jupiter lend provider skipped: ${e.message}`);
  }

  // Loopscale (REST API only, no heavy deps)
  try {
    const { LoopscaleProvider } = await import('./services/lend/loopscale-provider.js');
    lend.registerProvider(new LoopscaleProvider(ctx, { registry, price, tx, token }));
  } catch (e: any) {
    ctx.logger.verbose(`Loopscale lend provider skipped: ${e.message}`);
  }

  // ── Earn providers ─────────────────────────────────────

  // Kamino Earn (requires @kamino-finance/klend-sdk)
  try {
    const { KaminoEarnProvider } = await import('./services/earn/kamino-earn-provider.js');
    earn.registerProvider(new KaminoEarnProvider(ctx, { registry, price, tx }));
  } catch (e: any) {
    ctx.logger.verbose(`Kamino earn provider skipped: ${e.message}`);
  }

  // Loopscale Earn (REST API only, no heavy deps)
  try {
    const { LoopscaleEarnProvider } = await import('./services/earn/loopscale-earn-provider.js');
    earn.registerProvider(new LoopscaleEarnProvider(ctx, { registry, price, tx }));
  } catch (e: any) {
    ctx.logger.verbose(`Loopscale earn provider skipped: ${e.message}`);
  }

  // ── LP providers ─────────────────────────────────────

  // Orca (requires @orca-so/whirlpools)
  try {
    const { OrcaLpProvider } = await import('./services/lp/orca-provider.js');
    lp.registerProvider(new OrcaLpProvider(ctx, { registry, price, tx }));
  } catch (e: any) {
    ctx.logger.verbose(`Orca LP provider skipped: ${e.message}`);
  }

  // Raydium (requires @raydium-io/raydium-sdk-v2)
  if (rpcUrl) {
    try {
      const { RaydiumLpProvider } = await import('./services/lp/raydium-provider.js');
      lp.registerProvider(new RaydiumLpProvider(ctx, { registry, price, tx, rpcUrl }));
    } catch (e: any) {
      ctx.logger.verbose(`Raydium LP provider skipped: ${e.message}`);
    }
  }

  // Meteora (requires @meteora-ag/dlmm + @meteora-ag/cp-amm-sdk)
  if (rpcUrl) {
    try {
      const { MeteoraLpProvider } = await import('./services/lp/meteora-provider.js');
      lp.registerProvider(new MeteoraLpProvider(ctx, { registry, price, tx, rpcUrl }));
    } catch (e: any) {
      ctx.logger.verbose(`Meteora LP provider skipped: ${e.message}`);
    }
  }

  // Kamino LP (requires @kamino-finance/kliquidity-sdk)
  if (rpcUrl) {
    try {
      const { KaminoLpProvider } = await import('./services/lp/kamino-lp-provider.js');
      lp.registerProvider(new KaminoLpProvider(ctx, { registry, price, tx, rpcUrl }));
    } catch (e: any) {
      ctx.logger.verbose(`Kamino LP provider skipped: ${e.message}`);
    }
  }

  // ── Predict providers ──────────────────────────────────

  try {
    const { JupiterPredictProvider } = await import('./services/predict/jupiter-predict-provider.js');
    predict.registerProvider(new JupiterPredictProvider(ctx, { tx }));
  } catch (e: any) {
    ctx.logger.verbose(`Jupiter predict provider skipped: ${e.message}`);
  }
}
