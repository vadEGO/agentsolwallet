import { Command } from 'commander';
import * as lendService from '../core/lend-service.js';
import { getDefaultWalletName, resolveWalletName } from '../core/wallet-manager.js';
import { output, success, failure, isJsonMode, timed } from '../output/formatter.js';
import { table } from '../output/table.js';
import * as walletRepo from '../db/repos/wallet-repo.js';

export function registerLendCommand(program: Command): void {
  const lend = program.command('lend').description('Lending and borrowing (Kamino Finance)');

  // ── rates ───────────────────────────────────────────────

  lend
    .command('rates <token>')
    .description('Show Kamino deposit/borrow APY for a token')
    .action(async (token: string) => {
      try {
        const { result: rates, elapsed_ms } = await timed(() => lendService.getRates(token));

        if (isJsonMode()) {
          output(success({ token, rates }, { elapsed_ms }));
        } else if (rates.length === 0) {
          console.log(`No Kamino lending reserve found for "${token}".`);
        } else {
          const r = rates[0];
          console.log(`Kamino Lending — ${r.token}\n`);
          console.log(table(
            [{
              depositApy: `${(r.depositApy * 100).toFixed(2)}%`,
              borrowApy: `${(r.borrowApy * 100).toFixed(2)}%`,
              utilization: `${r.utilizationPct.toFixed(1)}%`,
              totalDeposited: fmtLargeAmount(r.totalDeposited),
              totalBorrowed: fmtLargeAmount(r.totalBorrowed),
            }],
            [
              { key: 'depositApy', header: 'Deposit APY', align: 'right' },
              { key: 'borrowApy', header: 'Borrow APY', align: 'right' },
              { key: 'utilization', header: 'Utilization', align: 'right' },
              { key: 'totalDeposited', header: 'Total Deposited', align: 'right' },
              { key: 'totalBorrowed', header: 'Total Borrowed', align: 'right' },
            ]
          ));
          console.log(`\nRun \`sol lend deposit <amount> ${token}\` to start earning.`);
        }
      } catch (err: any) {
        output(failure('LEND_RATES_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  // ── positions ───────────────────────────────────────────

  lend
    .command('positions')
    .description('List all Kamino lending/borrowing positions')
    .option('--wallet <name>', 'Wallet to check')
    .action(async (opts) => {
      try {
        const walletName = opts.wallet ? resolveWalletName(opts.wallet) : getDefaultWalletName();
        const wallet = walletRepo.getWallet(walletName);
        if (!wallet) throw new Error(`Wallet "${walletName}" not found`);

        const { result: positions, elapsed_ms } = await timed(() => lendService.getPositions(wallet.address));

        if (isJsonMode()) {
          output(success({ wallet: walletName, positions }, { elapsed_ms }));
        } else if (positions.length === 0) {
          console.log('No Kamino lending positions found.');
          console.log('Run `sol lend rates <token>` to see available rates.');
        } else {
          const deposits = positions.filter(p => p.type === 'deposit');
          const borrows = positions.filter(p => p.type === 'borrow');

          if (deposits.length > 0) {
            console.log('Deposits');
            console.log(table(
              deposits.map(p => ({
                token: p.token,
                amount: fmtAmount(p.amount),
                value: `$${p.valueUsd.toFixed(2)}`,
                apy: `${(p.apy * 100).toFixed(2)}%`,
              })),
              [
                { key: 'token', header: 'Token' },
                { key: 'amount', header: 'Amount', align: 'right' },
                { key: 'value', header: 'Value', align: 'right' },
                { key: 'apy', header: 'APY', align: 'right' },
              ],
            ));
            console.log('');
          }

          if (borrows.length > 0) {
            console.log('Borrows');
            console.log(table(
              borrows.map(p => ({
                token: p.token,
                amount: fmtAmount(p.amount),
                value: `$${p.valueUsd.toFixed(2)}`,
                apy: `${(p.apy * 100).toFixed(2)}%`,
                health: p.healthFactor != null ? p.healthFactor.toFixed(2) : '—',
              })),
              [
                { key: 'token', header: 'Token' },
                { key: 'amount', header: 'Amount', align: 'right' },
                { key: 'value', header: 'Value', align: 'right' },
                { key: 'apy', header: 'APY', align: 'right' },
                { key: 'health', header: 'Health', align: 'right' },
              ],
            ));

            // Health factor warning
            const minHealth = Math.min(...borrows.map(p => p.healthFactor ?? Infinity));
            if (minHealth < 1.1) {
              console.log('\nWarning: health factor below 1.1. Consider repaying or adding collateral.');
            }
            console.log('');
          }

          // Net value
          const totalDeposits = deposits.reduce((s, p) => s + p.valueUsd, 0);
          const totalBorrows = borrows.reduce((s, p) => s + p.valueUsd, 0);
          console.log(`Net lending value: $${(totalDeposits - totalBorrows).toFixed(2)}`);
        }
      } catch (err: any) {
        output(failure('LEND_POSITIONS_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  // ── deposit ─────────────────────────────────────────────

  lend
    .command('deposit <amount> <token>')
    .description('Deposit into Kamino lending vault')
    .option('--wallet <name>', 'Wallet to use')
    .action(async (amountStr: string, token: string, opts) => {
      try {
        const amount = parseFloat(amountStr);
        if (isNaN(amount) || amount <= 0) throw new Error('Invalid amount');

        const walletName = opts.wallet ? resolveWalletName(opts.wallet) : getDefaultWalletName();
        const { result, elapsed_ms } = await timed(() =>
          lendService.deposit(walletName, token, amount)
        );

        if (isJsonMode()) {
          output(success(result, { elapsed_ms }));
        } else {
          console.log(`Deposited ${amount} ${token.toUpperCase()} into Kamino`);
          console.log(`  Tx: ${result.explorerUrl}`);
          console.log(`\nRun \`sol lend positions\` to see your deposits.`);
        }
      } catch (err: any) {
        output(failure('LEND_DEPOSIT_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  // ── withdraw ────────────────────────────────────────────

  lend
    .command('withdraw <amount> <token>')
    .description('Withdraw from Kamino lending position (use "max" for full withdrawal)')
    .option('--wallet <name>', 'Wallet to use')
    .action(async (amountStr: string, token: string, opts) => {
      try {
        const amount = parseMaxAmount(amountStr);

        const walletName = opts.wallet ? resolveWalletName(opts.wallet) : getDefaultWalletName();
        const { result, elapsed_ms } = await timed(() =>
          lendService.withdraw(walletName, token, amount)
        );

        if (isJsonMode()) {
          output(success(result, { elapsed_ms }));
        } else {
          const label = isFinite(amount) ? `${amount} ${token.toUpperCase()}` : `all ${token.toUpperCase()}`;
          console.log(`Withdrew ${label} from Kamino`);
          console.log(`  Tx: ${result.explorerUrl}`);
          console.log(`\nRun \`sol lend positions\` to check remaining positions.`);
        }
      } catch (err: any) {
        output(failure('LEND_WITHDRAW_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  // ── borrow ──────────────────────────────────────────────

  lend
    .command('borrow <amount> <token>')
    .description('Borrow against collateral on Kamino')
    .option('--collateral <token>', 'Collateral token (required)')
    .option('--wallet <name>', 'Wallet to use')
    .action(async (amountStr: string, token: string, opts) => {
      try {
        const amount = parseFloat(amountStr);
        if (isNaN(amount) || amount <= 0) throw new Error('Invalid amount');
        if (!opts.collateral) throw new Error('--collateral is required');

        const walletName = opts.wallet ? resolveWalletName(opts.wallet) : getDefaultWalletName();
        const { result, elapsed_ms } = await timed(() =>
          lendService.borrow(walletName, token, amount, opts.collateral)
        );

        if (isJsonMode()) {
          output(success(result, { elapsed_ms }));
        } else {
          console.log(`Borrowed ${amount} ${token.toUpperCase()} from Kamino`);
          console.log(`  Tx: ${result.explorerUrl}`);
          if (result.healthFactor != null) {
            console.log(`  Health factor: ${result.healthFactor.toFixed(2)}`);
            if (result.healthFactor < 1.1) {
              console.log('  Warning: health factor is low. Monitor closely.');
            }
          }
          console.log(`\nRun \`sol lend positions\` to view all positions.`);
        }
      } catch (err: any) {
        output(failure('LEND_BORROW_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  // ── repay ───────────────────────────────────────────────

  lend
    .command('repay <amount> <token>')
    .description('Repay a Kamino loan (use "max" to repay full debt)')
    .option('--wallet <name>', 'Wallet to use')
    .action(async (amountStr: string, token: string, opts) => {
      try {
        const amount = parseMaxAmount(amountStr);

        const walletName = opts.wallet ? resolveWalletName(opts.wallet) : getDefaultWalletName();
        const { result, elapsed_ms } = await timed(() =>
          lendService.repay(walletName, token, amount)
        );

        if (isJsonMode()) {
          output(success(result, { elapsed_ms }));
        } else {
          const label = isFinite(amount) ? `${amount} ${token.toUpperCase()}` : `all ${token.toUpperCase()}`;
          console.log(`Repaid ${label} on Kamino`);
          console.log(`  Tx: ${result.explorerUrl}`);
          if (result.remainingDebt != null) {
            if (result.remainingDebt === 0) {
              console.log('  Loan fully repaid!');
            } else {
              console.log(`  Remaining debt: ${fmtAmount(result.remainingDebt)} ${token.toUpperCase()}`);
            }
          }
          console.log(`\nRun \`sol lend positions\` to check remaining positions.`);
        }
      } catch (err: any) {
        output(failure('LEND_REPAY_FAILED', err.message));
        process.exitCode = 1;
      }
    });
}

// ── Helpers ───────────────────────────────────────────────

function fmtAmount(n: number): string {
  if (n >= 1_000_000) return n.toFixed(0);
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.0001) return n.toFixed(6);
  return n.toFixed(9);
}

function parseMaxAmount(str: string): number {
  if (str === 'max' || str === 'all') return Infinity;
  const n = parseFloat(str);
  if (isNaN(n) || n <= 0) throw new Error('Invalid amount (use a number or "max")');
  return n;
}

function fmtLargeAmount(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return fmtAmount(n);
}
