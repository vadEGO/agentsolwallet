import type { SolContext, SnapshotRow, SnapshotEntryRow } from '../types.js';
import { SOL_MINT } from '../utils/solana.js';
import type { PriceService } from './price-service.js';
import type { TokenService, TokenBalance } from './token-service.js';
import type { StakeService, StakeAccountInfo } from './stake-service.js';
import type { LendService } from './lend-service.js';
import type { LendingPosition } from './lend/lend-provider.js';
import type { OrderService, OpenOrderPosition } from './order-service.js';
import type { PredictService } from './predict-service.js';
import type { PredictionPosition } from './predict/predict-provider.js';
import type { EarnService } from './earn-service.js';
import type { EarnPosition } from './earn/earn-provider.js';

// ── Types ─────────────────────────────────────────────────

export interface PortfolioPosition {
  type: 'token' | 'stake' | 'lend' | 'lp' | 'order' | 'predict' | 'earn';
  protocol?: string;
  wallet: string;
  mint: string;
  symbol: string;
  amount: number;
  valueUsd: number | null;
  extra?: Record<string, unknown>;
}

export interface AllocationEntry {
  symbol: string;
  pct: number;
  valueUsd: number;
}

export interface PortfolioReport {
  wallets: { name: string; address: string }[];
  positions: PortfolioPosition[];
  allocation: AllocationEntry[];
  totalValueUsd: number;
  claimableMev: number;
  lastSnapshot?: { id: number; label?: string; ago: string };
}

export interface CompareResult {
  snapshotId: number | 'current';
  snapshotDate?: string;
  diffs: CompareEntry[];
  totalBefore: number;
  totalAfter: number;
  totalChange: number;
  totalChangePct: number | null;
}

export interface CompareEntry {
  wallet: string;
  symbol: string;
  valueBefore: number;
  valueAfter: number;
  change: number;
  changePct: number | null;
}

export interface PortfolioService {
  get(wallets: { name: string; address: string }[]): Promise<PortfolioReport>;
  takeSnapshot(wallets: { name: string; address: string }[], label?: string): Promise<{ snapshotId: number; walletCount: number; entryCount: number; totalValueUsd: number }>;
  autoSnapshot(report: PortfolioReport): Promise<boolean>;
  compareToSnapshot(wallets: { name: string; address: string }[], snapshotId?: number): Promise<CompareResult>;
  getPnl(wallets: { name: string; address: string }[], sinceId?: number): Promise<CompareResult>;
}

interface PortfolioDeps {
  price: PriceService;
  token: TokenService;
  stake: StakeService;
  lend: LendService;
  order: OrderService;
  predict: PredictService;
  earn: EarnService;
}

export function createPortfolioService(ctx: SolContext, deps: PortfolioDeps): PortfolioService {
  const { logger, cache } = ctx;

  async function get(wallets: { name: string; address: string }[]): Promise<PortfolioReport> {
    if (wallets.length === 0) throw new Error('No wallets provided');

    const walletData = await Promise.all(wallets.map(async (w) => {
      const [tokens, stakes, lends, orders, predictions, earns] = await Promise.all([
        deps.token.getTokenBalances(w.address),
        deps.stake.getStakeAccounts(w.address),
        deps.lend.getPositions(w.address).catch((err) => {
          logger.verbose(`Could not fetch lending positions: ${err}`);
          return [] as LendingPosition[];
        }),
        deps.order.getOpenOrders(w.address).catch((err) => {
          logger.verbose(`Could not fetch open orders: ${err}`);
          return [] as OpenOrderPosition[];
        }),
        deps.predict.getPositions(w.address).catch((err) => {
          logger.verbose(`Could not fetch prediction positions: ${err}`);
          return [] as PredictionPosition[];
        }),
        deps.earn.getPositions(w.address).catch((err) => {
          logger.verbose(`Could not fetch earn positions: ${err}`);
          return [] as EarnPosition[];
        }),
      ]);
      return { wallet: w, tokens, stakes, lends, orders, predictions, earns };
    }));

    // Collect all mints for batch price fetch
    const allMints = new Set<string>();
    for (const { tokens, lends, orders, earns } of walletData) {
      for (const t of tokens) allMints.add(t.mint);
      for (const l of lends) allMints.add(l.mint);
      for (const o of orders) allMints.add(o.inputMint);
      for (const e of earns) allMints.add(e.mint);
    }
    allMints.add(SOL_MINT);

    const prices = await deps.price.getPrices([...allMints]);

    // Build positions
    const positions: PortfolioPosition[] = [];
    let claimableMev = 0;

    for (const { wallet, tokens, stakes, lends, orders, predictions, earns } of walletData) {
      for (const t of tokens) {
        const price = prices.get(t.mint);
        positions.push({
          type: 'token', protocol: 'native', wallet: wallet.name, mint: t.mint, symbol: t.symbol,
          amount: t.uiBalance, valueUsd: price ? t.uiBalance * price.priceUsd : null,
        });
      }

      for (const s of stakes) {
        const solPrice = prices.get(SOL_MINT);
        positions.push({
          type: 'stake', protocol: 'native', wallet: wallet.name, mint: SOL_MINT, symbol: 'SOL',
          amount: s.solBalance, valueUsd: solPrice ? s.solBalance * solPrice.priceUsd : null,
          extra: { stakeAccount: s.address, validator: s.validator, status: s.status, claimableExcess: s.claimableExcess },
        });
        claimableMev += s.claimableExcess;
      }

      for (const l of lends) {
        const value = l.type === 'borrow' ? -l.valueUsd : l.valueUsd;
        positions.push({
          type: 'lend', protocol: l.protocol, wallet: wallet.name, mint: l.mint, symbol: l.token,
          amount: l.amount, valueUsd: value,
          extra: { side: l.type, apy: l.apy, healthFactor: l.healthFactor },
        });
      }

      for (const o of orders) {
        positions.push({
          type: 'order', protocol: o.type === 'dca' ? 'jupiter-recurring' : 'jupiter-trigger',
          wallet: wallet.name, mint: o.inputMint, symbol: o.inputSymbol || 'unknown',
          amount: o.remainingInputAmount, valueUsd: o.valueUsd,
          extra: { orderType: o.type, orderKey: o.orderKey, outputSymbol: o.outputSymbol, outputMint: o.outputMint, status: o.status, ...o.extra },
        });
      }

      for (const pred of predictions) {
        if (pred.status === 'closed' || pred.status === 'lost') continue;
        positions.push({
          type: 'predict', protocol: pred.provider, wallet: wallet.name, mint: 'prediction',
          symbol: pred.isYes ? 'YES' : 'NO', amount: pred.contracts, valueUsd: pred.currentValueUsd,
          extra: { positionPubkey: pred.pubkey, marketId: pred.marketId, marketTitle: pred.marketTitle, eventTitle: pred.eventTitle, costBasis: pred.costBasisUsd, unrealizedPnl: pred.unrealizedPnlUsd, claimable: pred.claimable },
        });
      }

      for (const e of earns) {
        const price = prices.get(e.mint)?.priceUsd;
        const valueUsd = e.valueUsd ?? (price ? e.depositedAmount * price : null);
        positions.push({
          type: 'earn', protocol: e.protocol, wallet: wallet.name, mint: e.mint, symbol: e.token,
          amount: e.depositedAmount, valueUsd,
          extra: { vaultId: e.vaultId, vaultName: e.vaultName, apy: e.apy, shares: e.shares },
        });
      }
    }

    // Compute allocation
    const symbolTotals = new Map<string, number>();
    let totalValueUsd = 0;
    for (const p of positions) {
      if (p.valueUsd != null) {
        totalValueUsd += p.valueUsd;
        symbolTotals.set(p.symbol, (symbolTotals.get(p.symbol) || 0) + p.valueUsd);
      }
    }

    const allocation: AllocationEntry[] = [...symbolTotals.entries()]
      .map(([symbol, valueUsd]) => ({ symbol, pct: totalValueUsd > 0 ? (valueUsd / totalValueUsd) * 100 : 0, valueUsd }))
      .sort((a, b) => b.valueUsd - a.valueUsd);

    // Last snapshot hint
    let lastSnapshot: PortfolioReport['lastSnapshot'];
    const latest = cache.getLatestSnapshot?.();
    if (latest) {
      lastSnapshot = { id: latest.id, label: latest.label ?? undefined, ago: timeAgo(latest.created_at) };
    }

    return { wallets, positions, allocation, totalValueUsd, claimableMev, lastSnapshot };
  }

  async function takeSnapshot(wallets: { name: string; address: string }[], label?: string) {
    const portfolio = await get(wallets);
    if (!cache.createSnapshot || !cache.insertSnapshotEntry) {
      throw new Error('Snapshot support not available (cache does not implement snapshot methods)');
    }

    const snapshotId = cache.createSnapshot(label);
    let entryCount = 0;

    for (const p of portfolio.positions) {
      cache.insertSnapshotEntry({
        snapshot_id: snapshotId, wallet_name: p.wallet, wallet_address: '',
        mint: p.mint, symbol: p.symbol, balance: String(p.amount),
        price_usd: p.valueUsd != null && p.amount > 0 ? p.valueUsd / p.amount : null,
        value_usd: p.valueUsd, position_type: p.type, protocol: p.protocol ?? null,
        pool_id: (p.extra?.stakeAccount as string) ?? null,
      });
      entryCount++;
    }

    return { snapshotId, walletCount: portfolio.wallets.length, entryCount, totalValueUsd: portfolio.totalValueUsd };
  }

  async function autoSnapshot(report: PortfolioReport): Promise<boolean> {
    if (!cache.getLatestSnapshot || !cache.createSnapshot || !cache.insertSnapshotEntry) return false;

    const latest = cache.getLatestSnapshot();
    if (latest) {
      const ageMs = Date.now() - new Date(latest.created_at).getTime();
      if (ageMs < 5 * 60 * 1000) return false;
    }

    logger.verbose('Taking auto-snapshot');
    const snapshotId = cache.createSnapshot('auto');
    for (const p of report.positions) {
      cache.insertSnapshotEntry({
        snapshot_id: snapshotId, wallet_name: p.wallet, wallet_address: '',
        mint: p.mint, symbol: p.symbol, balance: String(p.amount),
        price_usd: p.valueUsd != null && p.amount > 0 ? p.valueUsd / p.amount : null,
        value_usd: p.valueUsd, position_type: p.type, protocol: p.protocol ?? null,
        pool_id: (p.extra?.stakeAccount as string) ?? null,
      });
    }
    return true;
  }

  async function compareToSnapshot(wallets: { name: string; address: string }[], snapshotId?: number): Promise<CompareResult> {
    if (!cache.getSnapshot || !cache.getLatestSnapshot || !cache.getSnapshotEntries) {
      throw new Error('Snapshot support not available');
    }

    let snap: SnapshotRow | undefined;
    if (snapshotId != null) {
      snap = cache.getSnapshot(snapshotId);
      if (!snap) throw new Error(`Snapshot #${snapshotId} not found`);
    } else {
      snap = cache.getLatestSnapshot();
      if (!snap) throw new Error('No snapshots found');
    }

    const entries = cache.getSnapshotEntries(snap.id);
    if (entries.length === 0) throw new Error(`Snapshot #${snap.id} is empty`);

    const portfolio = await get(wallets);

    const keyFor = (wallet: string, mint: string, type: string) => `${wallet}:${mint}:${type}`;

    const beforeMap = new Map<string, { wallet: string; symbol: string; valueUsd: number }>();
    for (const e of entries) {
      const k = keyFor(e.wallet_name, e.mint, e.position_type);
      const existing = beforeMap.get(k);
      beforeMap.set(k, { wallet: e.wallet_name, symbol: e.symbol || 'unknown', valueUsd: (existing?.valueUsd ?? 0) + (e.value_usd ?? 0) });
    }

    const afterMap = new Map<string, { wallet: string; symbol: string; valueUsd: number }>();
    for (const p of portfolio.positions) {
      const k = keyFor(p.wallet, p.mint, p.type);
      const existing = afterMap.get(k);
      afterMap.set(k, { wallet: p.wallet, symbol: p.symbol, valueUsd: (existing?.valueUsd ?? 0) + (p.valueUsd ?? 0) });
    }

    const allKeys = new Set([...beforeMap.keys(), ...afterMap.keys()]);
    const diffs: CompareEntry[] = [];

    for (const key of allKeys) {
      const before = beforeMap.get(key);
      const after = afterMap.get(key);
      const v1 = before?.valueUsd ?? 0;
      const v2 = after?.valueUsd ?? 0;
      const change = v2 - v1;
      if (Math.abs(change) > 0.01) {
        diffs.push({
          wallet: before?.wallet || after?.wallet || '', symbol: before?.symbol || after?.symbol || 'unknown',
          valueBefore: v1, valueAfter: v2, change, changePct: v1 > 0 ? (change / v1) * 100 : null,
        });
      }
    }

    const totalBefore = entries.reduce((s, e) => s + (e.value_usd ?? 0), 0);
    const totalAfter = portfolio.totalValueUsd;
    const totalChange = totalAfter - totalBefore;

    return {
      snapshotId: snap.id, snapshotDate: snap.created_at,
      diffs: diffs.sort((a, b) => Math.abs(b.change) - Math.abs(a.change)),
      totalBefore, totalAfter, totalChange,
      totalChangePct: totalBefore > 0 ? (totalChange / totalBefore) * 100 : null,
    };
  }

  async function getPnl(wallets: { name: string; address: string }[], sinceId?: number): Promise<CompareResult> {
    if (!cache.listSnapshots) throw new Error('Snapshot support not available');
    let snapId = sinceId;
    if (snapId == null) {
      const all = cache.listSnapshots(1000);
      if (all.length === 0) throw new Error('No snapshots found');
      snapId = all[all.length - 1].id;
    }
    return compareToSnapshot(wallets, snapId);
  }

  return { get, takeSnapshot, autoSnapshot, compareToSnapshot, getPnl };
}

// ── Helpers ───────────────────────────────────────────────

function timeAgo(isoDate: string): string {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
