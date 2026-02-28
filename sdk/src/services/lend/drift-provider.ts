import {
  DriftClient,
  BulkAccountLoader,
  initialize,
  calculateBorrowRate,
  calculateDepositRate,
  calculateUtilization,
  convertToNumber,
  SPOT_MARKET_RATE_PRECISION,
  SPOT_MARKET_UTILIZATION_PRECISION,
  type SpotMarketAccount,
} from '@drift-labs/sdk';
import { Keypair, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { getV1Connection, DummyWallet, toV2Instructions } from '../../compat/drift-compat.js';
import { uiToTokenAmount } from '../../utils/solana.js';
import type { SolContext } from '../../types.js';
import type { TokenRegistryService, TokenMetadata } from '../token-registry-service.js';
import type { PriceService } from '../price-service.js';
import type { TransactionService } from '../transaction-service.js';
import type { LendProvider, LendWriteResult, LendingRate, LendingPosition } from './lend-provider.js';

// ── Dependencies ────────────────────────────────────────

interface DriftDeps {
  registry: TokenRegistryService;
  price: PriceService;
  tx: TransactionService;
  rpcUrl: string;
}

// ── Helpers ─────────────────────────────────────────────

function getTokenAmountUi(amount: BN, decimals: number): number {
  return convertToNumber(amount, new BN(10 ** decimals));
}

function marketName(market: SpotMarketAccount): string {
  return String.fromCharCode(...(market as any).name.filter((c: number) => c !== 0)).trim();
}

// ── Provider ────────────────────────────────────────────

export class DriftProvider implements LendProvider {
  name = 'drift' as const;
  capabilities = { deposit: true, withdraw: true, borrow: true, repay: true };

  private cachedClient: DriftClient | null = null;
  private clientLoadedAt = 0;
  private readonly CLIENT_TTL_MS = 60_000;

  constructor(private ctx: SolContext, private deps: DriftDeps) {}

  // ── Client caching ──────────────────────────────────

  private async loadDriftClient(walletAddress?: string): Promise<DriftClient> {
    const now = Date.now();
    if (this.cachedClient && (now - this.clientLoadedAt) < this.CLIENT_TTL_MS && !walletAddress) {
      return this.cachedClient;
    }

    // Unsubscribe old client
    if (this.cachedClient && walletAddress) {
      try { await this.cachedClient.unsubscribe(); } catch { /* ok */ }
    }

    this.ctx.logger.verbose('Loading Drift client...');
    const connection = getV1Connection(this.deps.rpcUrl);

    // DummyWallet for account derivation — signing done via our v2 pipeline
    const wallet = walletAddress
      ? new DummyWallet(walletAddress)
      : new DummyWallet(Keypair.generate().publicKey.toBase58());

    initialize({ env: 'mainnet-beta' as any });

    const accountLoader = new BulkAccountLoader(connection as any, 'confirmed', 30_000);

    const client = new DriftClient({
      connection: connection as any,
      wallet: wallet as any,
      env: 'mainnet-beta',
      accountSubscription: {
        type: 'polling',
        accountLoader,
      },
    });

    await client.subscribe();

    // Unref the polling timer so it doesn't prevent process exit
    if (accountLoader.intervalId) {
      (accountLoader.intervalId as any).unref?.();
    }

    if (!walletAddress) {
      this.cachedClient = client;
      this.clientLoadedAt = now;
    }

    return client;
  }

  // ── Helpers ─────────────────────────────────────────

  private async resolveTokenStrict(symbolOrMint: string): Promise<TokenMetadata> {
    const meta = await this.deps.registry.resolveToken(symbolOrMint);
    if (!meta) throw new Error(`Unknown token: ${symbolOrMint}`);
    return meta;
  }

  private findSpotMarketByMint(client: DriftClient, mint: string): SpotMarketAccount | undefined {
    const markets = client.getSpotMarketAccounts();
    return markets.find(m => m.mint.toBase58() === mint);
  }

  // ── LendProvider implementation ─────────────────────

  async getRates(tokens?: string[]): Promise<LendingRate[]> {
    const client = await this.loadDriftClient();
    const markets = client.getSpotMarketAccounts();
    const rates: LendingRate[] = [];

    for (const market of markets) {
      const symbol = marketName(market);
      if (!symbol) continue;

      if (tokens && tokens.length > 0) {
        const match = tokens.some(t =>
          t.toUpperCase() === symbol.toUpperCase() ||
          t === market.mint.toBase58()
        );
        if (!match) continue;
      }

      const borrowRate = calculateBorrowRate(market);
      const depositRate = calculateDepositRate(market);
      const utilization = calculateUtilization(market);

      // Get token amounts using cumulative interest
      const depositPrecision = new BN(10).pow(new BN(19 - market.decimals));
      const totalDeposited = market.depositBalance.mul(market.cumulativeDepositInterest).div(depositPrecision);
      const totalBorrowed = market.borrowBalance.mul(market.cumulativeBorrowInterest).div(depositPrecision);

      rates.push({
        protocol: 'drift',
        token: symbol,
        mint: market.mint.toBase58(),
        depositApy: convertToNumber(depositRate, SPOT_MARKET_RATE_PRECISION),
        borrowApy: convertToNumber(borrowRate, SPOT_MARKET_RATE_PRECISION),
        totalDeposited: getTokenAmountUi(totalDeposited, market.decimals),
        totalBorrowed: getTokenAmountUi(totalBorrowed, market.decimals),
        utilizationPct: convertToNumber(utilization, SPOT_MARKET_UTILIZATION_PRECISION) * 100,
      });
    }

    return rates;
  }

  async getPositions(walletAddress: string): Promise<LendingPosition[]> {
    this.ctx.logger.verbose(`Fetching Drift positions for ${walletAddress}`);
    const client = await this.loadDriftClient(walletAddress);

    const user = client.getUser();
    // Check if this wallet has a Drift account
    try {
      if (!(await user.exists())) return [];
    } catch {
      return [];
    }

    const spots = user.getActiveSpotPositions();
    if (spots.length === 0) return [];

    const positions: LendingPosition[] = [];
    let healthFactor: number | undefined;

    try {
      const health = user.getHealth();
      // Drift health: 0-100 (100 = safe). Convert to ratio where > 1 is safe.
      healthFactor = health > 0 ? health / 50 : undefined; // approximate: 100 -> 2.0
    } catch { /* ok */ }

    for (const pos of spots) {
      const market = client.getSpotMarketAccount(pos.marketIndex);
      if (!market) continue;

      const amount = user.getTokenAmount(pos.marketIndex);
      const symbol = marketName(market);
      const absAmount = getTokenAmountUi(amount.abs(), market.decimals);
      if (absAmount <= 0) continue;

      const isDeposit = amount.gt(new BN(0));

      // Get USD value via oracle
      let valueUsd = 0;
      try {
        const oracleData = client.getOracleDataForSpotMarket(pos.marketIndex);
        const price = convertToNumber(oracleData.price, new BN(10 ** 6));
        valueUsd = absAmount * price;
      } catch { /* ok */ }

      const interestRate = isDeposit
        ? calculateDepositRate(market)
        : calculateBorrowRate(market);

      positions.push({
        protocol: 'drift',
        token: symbol,
        mint: market.mint.toBase58(),
        type: isDeposit ? 'deposit' : 'borrow',
        amount: absAmount,
        valueUsd,
        apy: convertToNumber(interestRate, SPOT_MARKET_RATE_PRECISION),
        healthFactor: isDeposit ? undefined : healthFactor,
      });
    }

    return positions;
  }

  async deposit(walletName: string, token: string, amount: number): Promise<LendWriteResult> {
    const meta = await this.resolveTokenStrict(token);
    const signer = await this.ctx.signer.getSigner(walletName);
    const client = await this.loadDriftClient(signer.address);

    const market = this.findSpotMarketByMint(client, meta.mint);
    if (!market) throw new Error(`No Drift spot market for ${meta.symbol}`);

    const rawAmount = client.convertToSpotPrecision(market.marketIndex, amount);

    // Check if user account exists — getUser() throws if no subscription
    let userExists = false;
    try {
      const user = client.getUser();
      userExists = await user.exists();
    } catch { /* no user — first time */ }

    if (!userExists) {
      this.ctx.logger.verbose('No Drift account — including init instructions');
      const { ixs: initAndDepositIxs } = await client.createInitializeUserAccountAndDepositCollateralIxs(
        rawAmount,
        await client.getAssociatedTokenAccount(market.marketIndex),
        market.marketIndex,
        0,         // subAccountId
        undefined, // name
        undefined, // fromSubAccountId
        undefined, // referrerInfo
        undefined, // donateAmount
        undefined, // customMaxMarginRatio
        (market as any).poolId, // match user pool to market pool
      );
      const v2Ixs = toV2Instructions(initAndDepositIxs);
      const prices = await this.deps.price.getPrices([meta.mint]);
      const price = prices.get(meta.mint)?.priceUsd;
      const rawAmountStr = uiToTokenAmount(amount, meta.decimals).toString();
      const result = await this.deps.tx.buildAndSendTransaction(v2Ixs, signer, {
        txType: 'lend-deposit',
        walletName,
        fromMint: meta.mint,
        fromAmount: rawAmountStr,
        fromPriceUsd: price,
      });
      return {
        signature: result.signature,
        protocol: 'drift',
        explorerUrl: result.explorerUrl,
      };
    }

    const ata = await client.getAssociatedTokenAccount(market.marketIndex);
    const ix = await client.getDepositInstruction(rawAmount, market.marketIndex, ata);
    const instructions = toV2Instructions([ix]);

    const prices = await this.deps.price.getPrices([meta.mint]);
    const price = prices.get(meta.mint)?.priceUsd;
    const rawAmountStr = uiToTokenAmount(amount, meta.decimals).toString();

    const result = await this.deps.tx.buildAndSendTransaction(instructions, signer, {
      txType: 'lend-deposit',
      walletName,
      fromMint: meta.mint,
      fromAmount: rawAmountStr,
      fromPriceUsd: price,
    });

    return {
      signature: result.signature,
      protocol: 'drift',
      explorerUrl: result.explorerUrl,
    };
  }

  async withdraw(walletName: string, token: string, amount: number): Promise<LendWriteResult> {
    const meta = await this.resolveTokenStrict(token);
    const signer = await this.ctx.signer.getSigner(walletName);
    const client = await this.loadDriftClient(signer.address);

    const market = this.findSpotMarketByMint(client, meta.mint);
    if (!market) throw new Error(`No Drift spot market for ${meta.symbol}`);

    const withdrawAll = !isFinite(amount);
    let rawAmount: BN;

    if (withdrawAll) {
      // Withdraw entire deposit
      const tokenAmount = client.getUser().getTokenAmount(market.marketIndex);
      rawAmount = tokenAmount.abs();
    } else {
      rawAmount = client.convertToSpotPrecision(market.marketIndex, amount);
    }

    const ata = await client.getAssociatedTokenAccount(market.marketIndex);
    const ix = await client.getWithdrawIx(rawAmount, market.marketIndex, ata, true);
    const instructions = toV2Instructions([ix]);

    const prices = await this.deps.price.getPrices([meta.mint]);
    const price = prices.get(meta.mint)?.priceUsd;
    const rawAmountStr = uiToTokenAmount(isFinite(amount) ? amount : 0, meta.decimals).toString();

    const result = await this.deps.tx.buildAndSendTransaction(instructions, signer, {
      txType: 'lend-withdraw',
      walletName,
      toMint: meta.mint,
      toAmount: rawAmountStr,
      toPriceUsd: price,
    });

    return {
      signature: result.signature,
      protocol: 'drift',
      explorerUrl: result.explorerUrl,
    };
  }

  async borrow(walletName: string, token: string, amount: number, _collateral: string): Promise<LendWriteResult> {
    const meta = await this.resolveTokenStrict(token);
    const signer = await this.ctx.signer.getSigner(walletName);
    const client = await this.loadDriftClient(signer.address);

    const market = this.findSpotMarketByMint(client, meta.mint);
    if (!market) throw new Error(`No Drift spot market for ${meta.symbol}`);

    const rawAmount = client.convertToSpotPrecision(market.marketIndex, amount);
    const ata = await client.getAssociatedTokenAccount(market.marketIndex);

    // Withdraw without reduceOnly=true allows borrowing
    const ix = await client.getWithdrawIx(rawAmount, market.marketIndex, ata, false);
    const instructions = toV2Instructions([ix]);

    const prices = await this.deps.price.getPrices([meta.mint]);
    const price = prices.get(meta.mint)?.priceUsd;
    const rawAmountStr = uiToTokenAmount(amount, meta.decimals).toString();

    const result = await this.deps.tx.buildAndSendTransaction(instructions, signer, {
      txType: 'lend-borrow',
      walletName,
      toMint: meta.mint,
      toAmount: rawAmountStr,
      toPriceUsd: price,
    });

    // Fetch health (best-effort)
    let healthFactor: number | undefined;
    try {
      const user = client.getUser();
      const health = user.getHealth();
      healthFactor = health > 0 ? health / 50 : undefined;
    } catch { /* ok */ }

    return {
      signature: result.signature,
      protocol: 'drift',
      explorerUrl: result.explorerUrl,
      healthFactor,
    };
  }

  async repay(walletName: string, token: string, amount: number): Promise<LendWriteResult> {
    const meta = await this.resolveTokenStrict(token);
    const signer = await this.ctx.signer.getSigner(walletName);
    const client = await this.loadDriftClient(signer.address);

    const market = this.findSpotMarketByMint(client, meta.mint);
    if (!market) throw new Error(`No Drift spot market for ${meta.symbol}`);

    const repayAll = !isFinite(amount);
    let rawAmount: BN;

    if (repayAll) {
      const tokenAmount = client.getUser().getTokenAmount(market.marketIndex);
      rawAmount = tokenAmount.abs();
    } else {
      rawAmount = client.convertToSpotPrecision(market.marketIndex, amount);
    }

    const ata = await client.getAssociatedTokenAccount(market.marketIndex);
    const ix = await client.getDepositInstruction(rawAmount, market.marketIndex, ata, undefined, true);
    const instructions = toV2Instructions([ix]);

    const prices = await this.deps.price.getPrices([meta.mint]);
    const price = prices.get(meta.mint)?.priceUsd;
    const rawAmountStr = uiToTokenAmount(isFinite(amount) ? amount : 0, meta.decimals).toString();

    const result = await this.deps.tx.buildAndSendTransaction(instructions, signer, {
      txType: 'lend-repay',
      walletName,
      fromMint: meta.mint,
      fromAmount: rawAmountStr,
      fromPriceUsd: price,
    });

    // Remaining debt
    let remainingDebt: number | undefined;
    try {
      const user = client.getUser();
      const tokenAmount = user.getTokenAmount(market.marketIndex);
      if (tokenAmount.lt(new BN(0))) {
        remainingDebt = getTokenAmountUi(tokenAmount.abs(), market.decimals);
      } else {
        remainingDebt = 0;
      }
    } catch { /* ok */ }

    return {
      signature: result.signature,
      protocol: 'drift',
      explorerUrl: result.explorerUrl,
      remainingDebt,
    };
  }
}
