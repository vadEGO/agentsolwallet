import { table } from './table.js';
import type { PortfolioReport, CompareResult } from '../core/portfolio-service.js';

const BAR_WIDTH = 30;

export function renderPortfolio(report: PortfolioReport): string {
  const lines: string[] = [];

  // Header
  const walletCount = report.wallets.length;
  const walletLabel = walletCount === 1 ? '1 wallet' : `${walletCount} wallets`;
  lines.push(`Portfolio — ${walletLabel} — $${fmt(report.totalValueUsd)}`);
  lines.push('');

  // Tokens section — group by symbol across wallets
  const tokenPositions = report.positions.filter(p => p.type === 'token' && p.amount > 0);
  if (tokenPositions.length > 0) {
    const grouped = new Map<string, { symbol: string; amount: number; valueUsd: number | null }>();
    for (const p of tokenPositions) {
      const existing = grouped.get(p.symbol);
      if (existing) {
        existing.amount += p.amount;
        if (p.valueUsd != null) existing.valueUsd = (existing.valueUsd ?? 0) + p.valueUsd;
      } else {
        grouped.set(p.symbol, { symbol: p.symbol, amount: p.amount, valueUsd: p.valueUsd });
      }
    }
    const rows = [...grouped.values()].sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));

    lines.push('Tokens');
    lines.push(table(
      rows.map(r => ({
        token: r.symbol,
        balance: fmtAmount(r.amount),
        value: r.valueUsd != null ? `$${fmt(r.valueUsd)}` : '—',
        pct: r.valueUsd != null && report.totalValueUsd > 0
          ? `${((r.valueUsd / report.totalValueUsd) * 100).toFixed(1)}%`
          : '',
      })),
      [
        { key: 'token', header: 'Token' },
        { key: 'balance', header: 'Balance', align: 'right' },
        { key: 'value', header: 'Value', align: 'right' },
        { key: 'pct', header: '%', align: 'right' },
      ],
    ));
    lines.push('');
  }

  // Staking section
  const stakePositions = report.positions.filter(p => p.type === 'stake');
  if (stakePositions.length > 0) {
    lines.push('Staking');
    lines.push(table(
      stakePositions.map(p => {
        const addr = String(p.extra?.stakeAccount ?? '');
        const short = addr.length > 12 ? `${addr.slice(0, 4)}...${addr.slice(-6)}` : addr;
        const validator = String(p.extra?.validator ?? '—');
        const validatorShort = validator.length > 12 ? `${validator.slice(0, 7)}...${validator.slice(-5)}` : validator;
        const excess = p.extra?.claimableExcess as number ?? 0;
        return {
          account: short,
          staked: `${fmtAmount(p.amount)} SOL`,
          validator: validatorShort,
          mev: excess > 0 ? `${fmtAmount(excess)} SOL *` : '—',
        };
      }),
      [
        { key: 'account', header: 'Account' },
        { key: 'staked', header: 'Staked', align: 'right' },
        { key: 'validator', header: 'Validator' },
        { key: 'mev', header: 'MEV', align: 'right' },
      ],
    ));
    lines.push('');
  }

  // Lending section
  const lendPositions = report.positions.filter(p => p.type === 'lend');
  if (lendPositions.length > 0) {
    lines.push('Lending (Kamino)');
    const deposits = lendPositions.filter(p => p.extra?.side === 'deposit');
    const borrows = lendPositions.filter(p => p.extra?.side === 'borrow');
    const allLendRows = [
      ...deposits.map(p => ({
        type: 'Deposit',
        token: p.symbol,
        amount: fmtAmount(p.amount),
        value: p.valueUsd != null ? `$${fmt(p.valueUsd)}` : '—',
        apy: p.extra?.apy != null ? `${((p.extra.apy as number) * 100).toFixed(2)}%` : '—',
      })),
      ...borrows.map(p => ({
        type: 'Borrow',
        token: p.symbol,
        amount: fmtAmount(p.amount),
        value: p.valueUsd != null ? `-$${fmt(Math.abs(p.valueUsd))}` : '—',
        apy: p.extra?.apy != null ? `${((p.extra.apy as number) * 100).toFixed(2)}%` : '—',
      })),
    ];

    lines.push(table(allLendRows, [
      { key: 'type', header: 'Type' },
      { key: 'token', header: 'Token' },
      { key: 'amount', header: 'Amount', align: 'right' },
      { key: 'value', header: 'Value', align: 'right' },
      { key: 'apy', header: 'APY', align: 'right' },
    ]));

    const depositTotal = deposits.reduce((s, p) => s + (p.valueUsd ?? 0), 0);
    const borrowTotal = borrows.reduce((s, p) => s + Math.abs(p.valueUsd ?? 0), 0);
    if (deposits.length > 0 && borrows.length > 0) {
      lines.push(`  Net: $${fmt(depositTotal - borrowTotal)}`);
    }

    // Health factor warning
    const healthFactors = borrows.map(p => p.extra?.healthFactor as number).filter(h => h != null && h > 0);
    if (healthFactors.length > 0) {
      const minHealth = Math.min(...healthFactors);
      if (minHealth < 1.1) {
        lines.push(`  Warning: health factor ${minHealth.toFixed(2)} — consider repaying or adding collateral.`);
      }
    }
    lines.push('');
  }

  // Open Orders section (DCA + limit)
  const orderPositions = report.positions.filter(p => p.type === 'order');
  if (orderPositions.length > 0) {
    lines.push('Open Orders');
    lines.push(table(
      orderPositions.map(p => {
        const orderType = String(p.extra?.orderType ?? '').toUpperCase();
        const outputSymbol = String(p.extra?.outputSymbol ?? '?');
        const orderKey = String(p.extra?.orderKey ?? '');
        const shortKey = orderKey.length > 12 ? `${orderKey.slice(0, 6)}..${orderKey.slice(-4)}` : orderKey;
        const fillPct = p.extra?.fillPct as number ?? 0;
        const fillStr = `${fillPct.toFixed(0)}%`;
        return {
          type: orderType,
          pair: `${p.symbol} → ${outputSymbol}`,
          locked: fmtAmount(p.amount) + ' ' + p.symbol,
          value: p.valueUsd != null ? `$${fmt(p.valueUsd)}` : '—',
          filled: fillStr,
          key: shortKey,
        };
      }),
      [
        { key: 'type', header: 'Type' },
        { key: 'pair', header: 'Pair' },
        { key: 'locked', header: 'Remaining', align: 'right' },
        { key: 'value', header: 'Value', align: 'right' },
        { key: 'filled', header: 'Filled', align: 'right' },
        { key: 'key', header: 'Order Key' },
      ],
    ));
    lines.push('');
  }

  // Allocation bars
  if (report.allocation.length > 0) {
    lines.push('Allocation');
    const maxSymLen = Math.max(...report.allocation.map(a => a.symbol.length), 4);
    for (const a of report.allocation) {
      const filled = Math.round((a.pct / 100) * BAR_WIDTH);
      const empty = BAR_WIDTH - filled;
      const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(empty);
      const pctStr = `${a.pct.toFixed(1)}%`.padStart(6);
      lines.push(`${a.symbol.padEnd(maxSymLen)}  ${bar} ${pctStr}`);
    }
    lines.push('');
  }

  // Per-wallet breakdown (only if multiple wallets)
  if (report.wallets.length > 1) {
    const walletTotals = new Map<string, number>();
    for (const p of report.positions) {
      if (p.valueUsd != null) {
        walletTotals.set(p.wallet, (walletTotals.get(p.wallet) ?? 0) + p.valueUsd);
      }
    }
    const walletRows = [...walletTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, value]) => ({
        wallet: name,
        value: `$${fmt(value)}`,
        pct: report.totalValueUsd > 0
          ? `${((value / report.totalValueUsd) * 100).toFixed(1)}%`
          : '',
      }));

    lines.push('Wallets');
    lines.push(table(walletRows, [
      { key: 'wallet', header: 'Wallet' },
      { key: 'value', header: 'Value', align: 'right' },
      { key: 'pct', header: '%', align: 'right' },
    ]));
    lines.push('');
  }

  // Footer
  lines.push(`Total: $${fmt(report.totalValueUsd)} across ${walletLabel}`);

  // Signposts
  if (report.claimableMev > 0) {
    lines.push(`* ${fmtAmount(report.claimableMev)} SOL claimable MEV. Run \`sol stake claim-mev\` to compound.`);
  }
  if (report.lastSnapshot) {
    lines.push(`Last snapshot: ${report.lastSnapshot.ago}. Run \`sol portfolio compare\` to see changes.`);
  } else {
    lines.push('No snapshots yet. Run `sol portfolio snapshot` to save current state.');
  }

  return lines.join('\n');
}

export function renderCompare(result: CompareResult, label: string): string {
  const lines: string[] = [];

  lines.push(`${label}\n`);

  if (result.diffs.length === 0) {
    lines.push('No significant changes.');
  } else {
    lines.push(table(
      result.diffs.map(d => ({
        wallet: d.wallet,
        symbol: d.symbol,
        before: `$${fmt(d.valueBefore)}`,
        after: `$${fmt(d.valueAfter)}`,
        change: `${d.change >= 0 ? '+' : ''}$${fmt(d.change)}`,
        pct: d.changePct != null ? `${d.changePct >= 0 ? '+' : ''}${d.changePct.toFixed(1)}%` : '—',
      })),
      [
        { key: 'wallet', header: 'Wallet' },
        { key: 'symbol', header: 'Token' },
        { key: 'before', header: 'Before', align: 'right' },
        { key: 'after', header: 'After', align: 'right' },
        { key: 'change', header: 'Change', align: 'right' },
        { key: 'pct', header: '%', align: 'right' },
      ],
    ));
  }

  const sign = result.totalChange >= 0 ? '+' : '';
  const pctStr = result.totalChangePct != null
    ? ` (${sign}${result.totalChangePct.toFixed(1)}%)`
    : '';
  lines.push(`\nTotal: $${fmt(result.totalBefore)} → $${fmt(result.totalAfter)} (${sign}$${fmt(result.totalChange)})${pctStr}`);

  return lines.join('\n');
}

// ── Helpers ───────────────────────────────────────────────

function fmt(n: number): string {
  return n.toFixed(2);
}

function fmtAmount(n: number): string {
  if (n >= 1_000_000) return n.toFixed(0);
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.0001) return n.toFixed(6);
  return n.toFixed(9);
}
