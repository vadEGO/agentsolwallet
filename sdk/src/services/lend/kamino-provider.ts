import { type Instruction } from '@solana/kit';
import {
  KaminoMarket,
  KaminoAction,
  VanillaObligation,
  U64_MAX,
  type KaminoReserve,
  type KaminoObligation,
} from '@kamino-finance/klend-sdk';
import {
  KLEND_PROGRAM_ID,
  KAMINO_MAIN_MARKET,
  RECENT_SLOT_DURATION_MS,
  getKaminoRpc,
  kAddress,
  kSigner,
  toV2Instructions,
  getCurrentSlot,
} from '../../compat/kamino-compat.js';
import { uiToTokenAmount } from '../../utils/solana.js';
import type { SolContext } from '../../types.js';
import type { TokenRegistryService, TokenMetadata } from '../token-registry-service.js';
import type { PriceService } from '../price-service.js';
import type { TransactionService } from '../transaction-service.js';
import type { TokenService } from '../token-service.js';
import type { LendProvider, LendWriteResult, LendingRate, LendingPosition } from './lend-provider.js';

// ── Dependency bundle ───────────────────────────────────────

export interface KaminoDeps {
  registry: TokenRegistryService;
  price: PriceService;
  tx: TransactionService;
  token: TokenService;
}

// ── Provider ────────────────────────────────────────────────

export class KaminoProvider implements LendProvider {
  name = 'kamino' as const;
  capabilities = { deposit: true, withdraw: true, borrow: true, repay: true };

  private ctx: SolContext;
  private deps: KaminoDeps;

  // Market caching
  private cachedMarket: KaminoMarket | null = null;
  private marketLoadedAt = 0;
  private readonly MARKET_TTL_MS = 60_000;

  constructor(ctx: SolContext, deps: KaminoDeps) {
    this.ctx = ctx;
    this.deps = deps;
  }

  // ── Market caching ──────────────────────────────────────

  private async loadMarket(): Promise<KaminoMarket> {
    const now = Date.now();
    if (this.cachedMarket && (now - this.marketLoadedAt) < this.MARKET_TTL_MS) {
      return this.cachedMarket;
    }

    this.ctx.logger.verbose('Loading Kamino lending market...');
    const market = await KaminoMarket.load(
      getKaminoRpc(this.ctx.rpc),
      kAddress(KAMINO_MAIN_MARKET),
      RECENT_SLOT_DURATION_MS,
      kAddress(KLEND_PROGRAM_ID),
      true, // load reserves
    );
    if (!market) throw new Error('Failed to load Kamino lending market');

    this.cachedMarket = market;
    this.marketLoadedAt = now;
    return market;
  }

  private invalidateMarketCache(): void {
    this.cachedMarket = null;
    this.marketLoadedAt = 0;
  }

  // ── Helpers ─────────────────────────────────────────────

  private async resolveTokenStrict(symbolOrMint: string): Promise<TokenMetadata> {
    const meta = await this.deps.registry.resolveToken(symbolOrMint);
    if (!meta) throw new Error(`Unknown token: ${symbolOrMint}`);
    return meta;
  }

  private obligationHealthFactor(obligation: KaminoObligation): number | undefined {
    const stats = obligation.refreshedStats;
    const borrowValue = stats.userTotalBorrowBorrowFactorAdjusted.toNumber();
    const liquidationLimit = stats.borrowLiquidationLimit.toNumber();
    if (borrowValue <= 0) return undefined;
    return liquidationLimit / borrowValue;
  }

  private async getWalletBalance(walletAddress: string, mint: string): Promise<number> {
    const balances = await this.deps.token.getTokenBalances(walletAddress);
    const token = balances.find(b => b.mint === mint);
    return token?.uiBalance ?? 0;
  }

  private async getUserObligation(market: KaminoMarket, walletAddress: string): Promise<KaminoObligation | null> {
    return market.getObligationByWallet(
      kAddress(walletAddress),
      new VanillaObligation(kAddress(KLEND_PROGRAM_ID)),
    );
  }

  // ── LendProvider interface ──────────────────────────────

  async getRates(tokens?: string[]): Promise<LendingRate[]> {
    const market = await this.loadMarket();
    const slot = await getCurrentSlot(this.ctx.rpc);

    let reserves: KaminoReserve[];

    if (tokens && tokens.length > 0) {
      this.ctx.logger.verbose(`Fetching Kamino lending rates for ${tokens.join(', ')}`);
      reserves = [];
      for (const token of tokens) {
        const meta = await this.resolveTokenStrict(token);
        const reserve = market.getReserveByMint(kAddress(meta.mint)) as KaminoReserve | undefined;
        if (reserve) reserves.push(reserve);
      }
    } else {
      this.ctx.logger.verbose('Fetching all Kamino lending rates');
      reserves = market.getReserves();
    }

    return reserves.map(reserve => {
      const mintFactor = Math.pow(10, reserve.getMintDecimals());
      return {
        protocol: 'kamino',
        token: reserve.getTokenSymbol(),
        mint: String(reserve.getLiquidityMint()),
        depositApy: reserve.totalSupplyAPY(slot),
        borrowApy: reserve.totalBorrowAPY(slot),
        totalDeposited: reserve.getTotalSupply().toNumber() / mintFactor,
        totalBorrowed: reserve.getBorrowedAmount().toNumber() / mintFactor,
        utilizationPct: reserve.calculateUtilizationRatio() * 100,
      };
    });
  }

  async getPositions(walletAddress: string): Promise<LendingPosition[]> {
    this.ctx.logger.verbose(`Fetching Kamino lending positions for ${walletAddress}`);

    const market = await this.loadMarket();
    const obligations: KaminoObligation[] = await market.getAllUserObligations(kAddress(walletAddress));
    if (obligations.length === 0) return [];

    const slot = await getCurrentSlot(this.ctx.rpc);
    const positions: LendingPosition[] = [];

    for (const obligation of obligations) {
      const healthFactor = this.obligationHealthFactor(obligation);

      // Deposits
      for (const [reserveAddr, deposit] of obligation.deposits) {
        const reserve = market.getReserveByAddress(reserveAddr) as KaminoReserve | undefined;
        if (!reserve) continue;

        const mintFactor = Math.pow(10, reserve.getMintDecimals());
        const amount = deposit.amount.toNumber() / mintFactor;
        if (amount <= 0) continue;

        positions.push({
          protocol: 'kamino',
          token: reserve.getTokenSymbol(),
          mint: String(reserve.getLiquidityMint()),
          type: 'deposit',
          amount,
          valueUsd: deposit.marketValueRefreshed.toNumber(),
          apy: reserve.totalSupplyAPY(slot),
        });
      }

      // Borrows
      for (const [reserveAddr, borrow] of obligation.borrows) {
        const reserve = market.getReserveByAddress(reserveAddr) as KaminoReserve | undefined;
        if (!reserve) continue;

        const mintFactor = Math.pow(10, reserve.getMintDecimals());
        const amount = borrow.amount.toNumber() / mintFactor;
        if (amount <= 0) continue;

        positions.push({
          protocol: 'kamino',
          token: reserve.getTokenSymbol(),
          mint: String(reserve.getLiquidityMint()),
          type: 'borrow',
          amount,
          valueUsd: borrow.marketValueRefreshed.toNumber(),
          apy: reserve.totalBorrowAPY(slot),
          healthFactor,
        });
      }
    }

    return positions;
  }

  async deposit(walletName: string, token: string, amount: number): Promise<LendWriteResult> {
    const meta = await this.resolveTokenStrict(token);
    const signer = await this.ctx.signer.getSigner(walletName);
    const market = await this.loadMarket();

    const reserve = market.getReserveByMint(kAddress(meta.mint));
    if (!reserve) throw new Error(`No Kamino reserve for ${meta.symbol}`);

    const rawAmount = uiToTokenAmount(amount, meta.decimals).toString();

    const action = await KaminoAction.buildDepositTxns(
      market,
      rawAmount,
      kAddress(meta.mint),
      kSigner(signer),
      new VanillaObligation(kAddress(KLEND_PROGRAM_ID)),
      true,
      undefined,
      300_000,
      true,
    );

    const instructions = toV2Instructions(KaminoAction.actionToIxs(action));

    const prices = await this.deps.price.getPrices([meta.mint]);
    const price = prices.get(meta.mint)?.priceUsd;

    const result = await this.deps.tx.buildAndSendTransaction(instructions, signer, {
      txType: 'lend-deposit',
      walletName,
      fromMint: meta.mint,
      fromAmount: rawAmount,
      fromPriceUsd: price,
    });

    this.invalidateMarketCache();

    return {
      signature: result.signature,
      protocol: 'kamino',
      explorerUrl: result.explorerUrl,
    };
  }

  async withdraw(walletName: string, token: string, amount: number): Promise<LendWriteResult> {
    const meta = await this.resolveTokenStrict(token);
    const signer = await this.ctx.signer.getSigner(walletName);
    const market = await this.loadMarket();

    const reserve = market.getReserveByMint(kAddress(meta.mint));
    if (!reserve) throw new Error(`No Kamino reserve for ${meta.symbol}`);

    let rawAmount: string;
    if (!isFinite(amount)) {
      rawAmount = U64_MAX;
      this.ctx.logger.verbose('Using U64_MAX for full withdrawal');
    } else {
      const obligation = await this.getUserObligation(market, signer.address);
      if (obligation) {
        const depositPos = obligation.getDepositByMint(kAddress(meta.mint));
        if (depositPos) {
          const depositUi = depositPos.amount.toNumber() / Math.pow(10, meta.decimals);
          if (amount >= depositUi) {
            rawAmount = U64_MAX;
            this.ctx.logger.verbose(`Withdraw amount ${amount} >= deposit ${depositUi.toFixed(meta.decimals)}, using U64_MAX for clean full withdrawal`);
          } else {
            rawAmount = uiToTokenAmount(amount, meta.decimals).toString();
          }
        } else {
          rawAmount = uiToTokenAmount(amount, meta.decimals).toString();
        }
      } else {
        rawAmount = uiToTokenAmount(amount, meta.decimals).toString();
      }
    }

    const action = await KaminoAction.buildWithdrawTxns(
      market,
      rawAmount,
      kAddress(meta.mint),
      kSigner(signer),
      new VanillaObligation(kAddress(KLEND_PROGRAM_ID)),
      true,
      undefined,
      300_000,
      true,
    );

    const instructions = toV2Instructions(KaminoAction.actionToIxs(action));

    const prices = await this.deps.price.getPrices([meta.mint]);
    const price = prices.get(meta.mint)?.priceUsd;

    const result = await this.deps.tx.buildAndSendTransaction(instructions, signer, {
      txType: 'lend-withdraw',
      walletName,
      toMint: meta.mint,
      toAmount: rawAmount,
      toPriceUsd: price,
    });

    this.invalidateMarketCache();

    return {
      signature: result.signature,
      protocol: 'kamino',
      explorerUrl: result.explorerUrl,
    };
  }

  async borrow(walletName: string, token: string, amount: number, collateral: string): Promise<LendWriteResult> {
    const borrowMeta = await this.resolveTokenStrict(token);
    const collateralMeta = await this.resolveTokenStrict(collateral);
    const signer = await this.ctx.signer.getSigner(walletName);
    const market = await this.loadMarket();

    const borrowReserve = market.getReserveByMint(kAddress(borrowMeta.mint));
    if (!borrowReserve) throw new Error(`No Kamino reserve for ${borrowMeta.symbol}`);

    const collateralReserve = market.getReserveByMint(kAddress(collateralMeta.mint));
    if (!collateralReserve) throw new Error(`No Kamino reserve for ${collateralMeta.symbol}`);

    const rawAmount = uiToTokenAmount(amount, borrowMeta.decimals).toString();

    const action = await KaminoAction.buildBorrowTxns(
      market,
      rawAmount,
      kAddress(borrowMeta.mint),
      kSigner(signer),
      new VanillaObligation(kAddress(KLEND_PROGRAM_ID)),
      true,
      undefined,
      300_000,
      true,
    );

    const instructions = toV2Instructions(KaminoAction.actionToIxs(action));

    const prices = await this.deps.price.getPrices([borrowMeta.mint]);
    const borrowPrice = prices.get(borrowMeta.mint)?.priceUsd;

    const result = await this.deps.tx.buildAndSendTransaction(instructions, signer, {
      txType: 'lend-borrow',
      walletName,
      toMint: borrowMeta.mint,
      toAmount: rawAmount,
      toPriceUsd: borrowPrice,
    });

    this.invalidateMarketCache();

    // Fetch updated health factor (best-effort)
    let healthFactor: number | undefined;
    try {
      const updated = await this.loadMarket();
      const obligation = await updated.getObligationByWallet(
        kAddress(signer.address),
        new VanillaObligation(kAddress(KLEND_PROGRAM_ID)),
      );
      if (obligation) healthFactor = this.obligationHealthFactor(obligation);
    } catch { /* non-critical */ }

    return {
      signature: result.signature,
      protocol: 'kamino',
      explorerUrl: result.explorerUrl,
      healthFactor,
    };
  }

  async repay(walletName: string, token: string, amount: number): Promise<LendWriteResult> {
    const meta = await this.resolveTokenStrict(token);
    const signer = await this.ctx.signer.getSigner(walletName);
    const market = await this.loadMarket();

    const reserve = market.getReserveByMint(kAddress(meta.mint));
    if (!reserve) throw new Error(`No Kamino reserve for ${meta.symbol}`);

    const obligation = await this.getUserObligation(market, signer.address);
    const borrowPos = obligation?.getBorrowByMint(kAddress(meta.mint));
    const debtUi = borrowPos
      ? borrowPos.amount.toNumber() / Math.pow(10, meta.decimals)
      : 0;

    let rawAmount: string;
    const wantFullRepay = !isFinite(amount) || (debtUi > 0 && amount >= debtUi);

    if (wantFullRepay && debtUi > 0) {
      const walletBalance = await this.getWalletBalance(signer.address, meta.mint);
      if (walletBalance >= debtUi * 1.002) {
        rawAmount = U64_MAX;
        this.ctx.logger.verbose(`Wallet balance ${walletBalance} covers debt ${debtUi}, using U64_MAX for full repay`);
      } else {
        const shortfall = Math.max(debtUi * 1.002 - walletBalance, 0.000001);
        throw new Error(
          `Insufficient ${meta.symbol} to fully repay. Debt: ~${debtUi.toFixed(meta.decimals)} ${meta.symbol}, ` +
          `balance: ${walletBalance} ${meta.symbol}. ` +
          `Get ~${shortfall.toFixed(meta.decimals)} more, then: sol lend repay max ${token}`
        );
      }
    } else {
      rawAmount = uiToTokenAmount(amount, meta.decimals).toString();
    }

    const slot = await getCurrentSlot(this.ctx.rpc);

    const action = await KaminoAction.buildRepayTxns(
      market,
      rawAmount,
      kAddress(meta.mint),
      kSigner(signer),
      new VanillaObligation(kAddress(KLEND_PROGRAM_ID)),
      true,
      undefined,
      slot,
      undefined,
      300_000,
      true,
    );

    const instructions = toV2Instructions(KaminoAction.actionToIxs(action));

    const prices = await this.deps.price.getPrices([meta.mint]);
    const price = prices.get(meta.mint)?.priceUsd;

    const result = await this.deps.tx.buildAndSendTransaction(instructions, signer, {
      txType: 'lend-repay',
      walletName,
      fromMint: meta.mint,
      fromAmount: rawAmount,
      fromPriceUsd: price,
    });

    this.invalidateMarketCache();

    // Fetch remaining debt (best-effort)
    let remainingDebt: number | undefined;
    try {
      const updated = await this.loadMarket();
      const obl = await updated.getObligationByWallet(
        kAddress(signer.address),
        new VanillaObligation(kAddress(KLEND_PROGRAM_ID)),
      );
      if (obl) {
        const pos = obl.getBorrowByMint(kAddress(meta.mint));
        remainingDebt = pos ? pos.amount.toNumber() / Math.pow(10, meta.decimals) : 0;
      }
    } catch { /* non-critical */ }

    return {
      signature: result.signature,
      protocol: 'kamino',
      explorerUrl: result.explorerUrl,
      remainingDebt,
    };
  }
}
