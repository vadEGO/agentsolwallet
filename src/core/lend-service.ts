import { address, type IInstruction } from '@solana/kit';
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
} from './kamino-compat.js';
import { loadSigner } from './wallet-manager.js';
import { resolveToken, type TokenMetadata } from './token-registry.js';
import { getPrices } from './price-service.js';
import { buildAndSendTransaction } from './transaction.js';
import { verbose } from '../output/formatter.js';
import { uiToTokenAmount, SOL_MINT } from '../utils/solana.js';
import { getTokenBalances } from './token-service.js';

// ── Types ─────────────────────────────────────────────────

export interface LendingRate {
  protocol: string;
  token: string;
  mint: string;
  depositApy: number;
  borrowApy: number;
  totalDeposited: number;
  totalBorrowed: number;
  utilizationPct: number;
}

export interface LendingPosition {
  protocol: string;
  token: string;
  mint: string;
  type: 'deposit' | 'borrow';
  amount: number;
  valueUsd: number;
  apy: number;
  healthFactor?: number;
}

// ── Market caching ────────────────────────────────────────

let cachedMarket: KaminoMarket | null = null;
let marketLoadedAt = 0;
const MARKET_TTL_MS = 60_000;

async function loadMarket(): Promise<KaminoMarket> {
  const now = Date.now();
  if (cachedMarket && (now - marketLoadedAt) < MARKET_TTL_MS) {
    return cachedMarket;
  }

  verbose('Loading Kamino lending market...');
  const market = await KaminoMarket.load(
    getKaminoRpc(),
    kAddress(KAMINO_MAIN_MARKET),
    RECENT_SLOT_DURATION_MS,
    kAddress(KLEND_PROGRAM_ID),
    true, // load reserves
  );
  if (!market) throw new Error('Failed to load Kamino lending market');

  cachedMarket = market;
  marketLoadedAt = now;
  return market;
}

function invalidateMarketCache(): void {
  cachedMarket = null;
  marketLoadedAt = 0;
}

// ── Helpers ───────────────────────────────────────────────

async function resolveTokenStrict(symbolOrMint: string): Promise<TokenMetadata> {
  const meta = await resolveToken(symbolOrMint);
  if (!meta) throw new Error(`Unknown token: ${symbolOrMint}`);
  return meta;
}

function obligationHealthFactor(obligation: KaminoObligation): number | undefined {
  const stats = obligation.refreshedStats;
  const borrowValue = stats.userTotalBorrowBorrowFactorAdjusted.toNumber();
  const liquidationLimit = stats.borrowLiquidationLimit.toNumber();
  if (borrowValue <= 0) return undefined;
  return liquidationLimit / borrowValue;
}

async function getWalletBalance(walletAddress: string, mint: string): Promise<number> {
  const balances = await getTokenBalances(walletAddress);
  const token = balances.find(b => b.mint === mint);
  return token?.uiBalance ?? 0;
}

async function getUserObligation(market: KaminoMarket, walletAddress: string): Promise<KaminoObligation | null> {
  return market.getObligationByWallet(
    kAddress(walletAddress),
    new VanillaObligation(kAddress(KLEND_PROGRAM_ID)),
  );
}

// ── Read operations ───────────────────────────────────────

export async function getRates(tokens?: string[]): Promise<LendingRate[]> {
  const market = await loadMarket();
  const slot = await getCurrentSlot();

  let reserves: KaminoReserve[];

  if (tokens && tokens.length > 0) {
    verbose(`Fetching Kamino lending rates for ${tokens.join(', ')}`);
    reserves = [];
    for (const token of tokens) {
      const meta = await resolveTokenStrict(token);
      const reserve = market.getReserveByMint(kAddress(meta.mint)) as KaminoReserve | undefined;
      if (reserve) reserves.push(reserve);
    }
  } else {
    verbose('Fetching all Kamino lending rates');
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

export async function getPositions(walletAddress: string): Promise<LendingPosition[]> {
  verbose(`Fetching Kamino lending positions for ${walletAddress}`);

  const market = await loadMarket();
  const obligations: KaminoObligation[] = await market.getAllUserObligations(kAddress(walletAddress));
  if (obligations.length === 0) return [];

  const slot = await getCurrentSlot();
  const positions: LendingPosition[] = [];

  for (const obligation of obligations) {
    const healthFactor = obligationHealthFactor(obligation);

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

// ── Write operations ──────────────────────────────────────

export async function deposit(
  walletName: string,
  token: string,
  amount: number,
): Promise<{ signature: string; protocol: string; explorerUrl: string }> {
  const meta = await resolveTokenStrict(token);
  const signer = await loadSigner(walletName);
  const market = await loadMarket();

  const reserve = market.getReserveByMint(kAddress(meta.mint));
  if (!reserve) throw new Error(`No Kamino reserve for ${meta.symbol}`);

  const rawAmount = uiToTokenAmount(amount, meta.decimals).toString();

  const action = await KaminoAction.buildDepositTxns(
    market,
    rawAmount,
    kAddress(meta.mint),
    kSigner(signer),
    new VanillaObligation(kAddress(KLEND_PROGRAM_ID)),
    true,       // useV2Ixs
    undefined,  // scopeRefreshConfig
    300_000,    // extraComputeBudget
    true,       // includeAtaIxs
  );

  const instructions = toV2Instructions(KaminoAction.actionToIxs(action));

  const prices = await getPrices([meta.mint]);
  const price = prices.get(meta.mint)?.priceUsd;

  const result = await buildAndSendTransaction(instructions, signer, {
    txType: 'lend-deposit',
    walletName,
    fromMint: meta.mint,
    fromAmount: rawAmount,
    fromPriceUsd: price,
  });

  invalidateMarketCache();

  return {
    signature: result.signature,
    protocol: 'kamino',
    explorerUrl: result.explorerUrl,
  };
}

export async function withdraw(
  walletName: string,
  token: string,
  amount: number, // Infinity = withdraw all
): Promise<{ signature: string; explorerUrl: string }> {
  const meta = await resolveTokenStrict(token);
  const signer = await loadSigner(walletName);
  const market = await loadMarket();

  const reserve = market.getReserveByMint(kAddress(meta.mint));
  if (!reserve) throw new Error(`No Kamino reserve for ${meta.symbol}`);

  // Detect "withdraw all": use U64_MAX so the on-chain program withdraws exact deposit
  let rawAmount: string;
  if (!isFinite(amount)) {
    rawAmount = U64_MAX;
    verbose('Using U64_MAX for full withdrawal');
  } else {
    // Check if amount covers full deposit — if so, use U64_MAX for clean withdrawal
    const obligation = await getUserObligation(market, signer.address);
    if (obligation) {
      const depositPos = obligation.getDepositByMint(kAddress(meta.mint));
      if (depositPos) {
        const depositUi = depositPos.amount.toNumber() / Math.pow(10, meta.decimals);
        if (amount >= depositUi) {
          rawAmount = U64_MAX;
          verbose(`Withdraw amount ${amount} >= deposit ${depositUi.toFixed(meta.decimals)}, using U64_MAX for clean full withdrawal`);
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

  const prices = await getPrices([meta.mint]);
  const price = prices.get(meta.mint)?.priceUsd;

  const result = await buildAndSendTransaction(instructions, signer, {
    txType: 'lend-withdraw',
    walletName,
    toMint: meta.mint,
    toAmount: rawAmount,
    toPriceUsd: price,
  });

  invalidateMarketCache();

  return {
    signature: result.signature,
    explorerUrl: result.explorerUrl,
  };
}

export async function borrow(
  walletName: string,
  token: string,
  amount: number,
  collateralToken: string,
): Promise<{ signature: string; explorerUrl: string; healthFactor?: number }> {
  const borrowMeta = await resolveTokenStrict(token);
  const collateralMeta = await resolveTokenStrict(collateralToken);
  const signer = await loadSigner(walletName);
  const market = await loadMarket();

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

  const prices = await getPrices([borrowMeta.mint]);
  const borrowPrice = prices.get(borrowMeta.mint)?.priceUsd;

  const result = await buildAndSendTransaction(instructions, signer, {
    txType: 'lend-borrow',
    walletName,
    toMint: borrowMeta.mint,
    toAmount: rawAmount,
    toPriceUsd: borrowPrice,
  });

  invalidateMarketCache();

  // Fetch updated health factor (best-effort)
  let healthFactor: number | undefined;
  try {
    const updated = await loadMarket();
    const obligation = await updated.getObligationByWallet(
      kAddress(signer.address),
      new VanillaObligation(kAddress(KLEND_PROGRAM_ID)),
    );
    if (obligation) healthFactor = obligationHealthFactor(obligation);
  } catch { /* non-critical */ }

  return {
    signature: result.signature,
    explorerUrl: result.explorerUrl,
    healthFactor,
  };
}

export async function repay(
  walletName: string,
  token: string,
  amount: number, // Infinity = repay all
): Promise<{ signature: string; explorerUrl: string; remainingDebt?: number }> {
  const meta = await resolveTokenStrict(token);
  const signer = await loadSigner(walletName);
  const market = await loadMarket();

  const reserve = market.getReserveByMint(kAddress(meta.mint));
  if (!reserve) throw new Error(`No Kamino reserve for ${meta.symbol}`);

  // Determine repay amount:
  // - "repay max" (Infinity): full repay using U64_MAX sentinel
  // - exact amount >= debt: use U64_MAX for clean close (avoids dust)
  // - exact amount < debt: partial repay (must leave non-dust remainder)
  //
  // On-chain constraints:
  // - U64_MAX tells the program to repay exact debt + interest, but requires
  //   the wallet to hold enough tokens to cover it
  // - Partial repay that leaves near-zero debt triggers NetValueRemainingTooSmall
  const obligation = await getUserObligation(market, signer.address);
  const borrowPos = obligation?.getBorrowByMint(kAddress(meta.mint));
  const debtUi = borrowPos
    ? borrowPos.amount.toNumber() / Math.pow(10, meta.decimals)
    : 0;

  let rawAmount: string;
  const wantFullRepay = !isFinite(amount) || (debtUi > 0 && amount >= debtUi);

  if (wantFullRepay && debtUi > 0) {
    // Check wallet can cover debt + interest margin
    const walletBalance = await getWalletBalance(signer.address, meta.mint);
    if (walletBalance >= debtUi * 1.002) {
      rawAmount = U64_MAX;
      verbose(`Wallet balance ${walletBalance} covers debt ${debtUi}, using U64_MAX for full repay`);
    } else {
      // Not enough to cover debt + interest — give actionable error
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

  const slot = await getCurrentSlot();

  const action = await KaminoAction.buildRepayTxns(
    market,
    rawAmount,
    kAddress(meta.mint),
    kSigner(signer),
    new VanillaObligation(kAddress(KLEND_PROGRAM_ID)),
    true,
    undefined,
    slot,
    undefined, // payer (defaults to owner)
    300_000,
    true,
  );

  const instructions = toV2Instructions(KaminoAction.actionToIxs(action));

  const prices = await getPrices([meta.mint]);
  const price = prices.get(meta.mint)?.priceUsd;

  const result = await buildAndSendTransaction(instructions, signer, {
    txType: 'lend-repay',
    walletName,
    fromMint: meta.mint,
    fromAmount: rawAmount,
    fromPriceUsd: price,
  });

  invalidateMarketCache();

  // Fetch remaining debt (best-effort)
  let remainingDebt: number | undefined;
  try {
    const updated = await loadMarket();
    const obligation = await updated.getObligationByWallet(
      kAddress(signer.address),
      new VanillaObligation(kAddress(KLEND_PROGRAM_ID)),
    );
    if (obligation) {
      const borrowPos = obligation.getBorrowByMint(kAddress(meta.mint));
      if (borrowPos) {
        remainingDebt = borrowPos.amount.toNumber() / Math.pow(10, meta.decimals);
      } else {
        remainingDebt = 0;
      }
    }
  } catch { /* non-critical */ }

  return {
    signature: result.signature,
    explorerUrl: result.explorerUrl,
    remainingDebt,
  };
}
