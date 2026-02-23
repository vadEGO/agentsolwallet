import { Command } from 'commander';
import * as lendService from '../core/lend-service.js';
import { getDefaultWalletName } from '../core/wallet-manager.js';
import { output, success, failure, isJsonMode, timed } from '../output/formatter.js';
import { table } from '../output/table.js';
import * as walletRepo from '../db/repos/wallet-repo.js';

export function registerLendCommand(program: Command): void {
  const lend = program.command('lend').description('Lending and borrowing');

  lend
    .command('rates <token>')
    .description('Show deposit/borrow rates across protocols')
    .action(async (token: string) => {
      try {
        const { result: rates, elapsed_ms } = await timed(() => lendService.getRates(token));

        if (isJsonMode()) {
          output(success({ token, rates }, { elapsed_ms }));
        } else if (rates.length === 0) {
          console.log(`No lending rates found for ${token}. Lending integration coming in Phase 9.`);
        } else {
          console.log(table(
            rates.map(r => ({
              protocol: r.protocol,
              depositApy: `${(r.depositApy * 100).toFixed(2)}%`,
              borrowApy: `${(r.borrowApy * 100).toFixed(2)}%`,
            })),
            [
              { key: 'protocol', header: 'Protocol' },
              { key: 'depositApy', header: 'Deposit APY', align: 'right' },
              { key: 'borrowApy', header: 'Borrow APY', align: 'right' },
            ]
          ));
        }
      } catch (err: any) {
        output(failure('LEND_RATES_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  lend
    .command('positions')
    .description('List all lending/borrowing positions')
    .option('--wallet <name>', 'Wallet to check')
    .action(async (opts) => {
      try {
        const walletName = opts.wallet || getDefaultWalletName();
        const wallet = walletRepo.getWallet(walletName);
        if (!wallet) throw new Error(`Wallet "${walletName}" not found`);

        const { result: positions, elapsed_ms } = await timed(() => lendService.getPositions(wallet.address));

        if (isJsonMode()) {
          output(success({ wallet: walletName, positions }, { elapsed_ms }));
        } else if (positions.length === 0) {
          console.log('No lending positions found.');
        } else {
          console.log(table(
            positions.map(p => ({
              protocol: p.protocol,
              type: p.type,
              token: p.token,
              amount: p.amount.toFixed(4),
              value: `$${p.valueUsd.toFixed(2)}`,
              apy: `${(p.apy * 100).toFixed(2)}%`,
            })),
            [
              { key: 'protocol', header: 'Protocol' },
              { key: 'type', header: 'Type' },
              { key: 'token', header: 'Token' },
              { key: 'amount', header: 'Amount', align: 'right' },
              { key: 'value', header: 'Value', align: 'right' },
              { key: 'apy', header: 'APY', align: 'right' },
            ]
          ));
        }
      } catch (err: any) {
        output(failure('LEND_POSITIONS_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  lend
    .command('deposit <amount> <token>')
    .description('Deposit into best-yield lending vault')
    .option('--protocol <name>', 'Specific protocol (jupiter-lend, kamino)')
    .option('--wallet <name>', 'Wallet to use')
    .action(async (amountStr: string, token: string, opts) => {
      try {
        const amount = parseFloat(amountStr);
        if (isNaN(amount) || amount <= 0) throw new Error('Invalid amount');

        const walletName = opts.wallet || getDefaultWalletName();
        const result = await lendService.deposit(walletName, token, amount, opts.protocol);

        if (isJsonMode()) {
          output(success(result));
        } else {
          console.log(`Deposited ${amount} ${token} into ${result.protocol}`);
          console.log(`  Signature: ${result.signature}`);
        }
      } catch (err: any) {
        output(failure('LEND_DEPOSIT_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  lend
    .command('withdraw <amount> <token>')
    .description('Withdraw from lending position')
    .option('--wallet <name>', 'Wallet to use')
    .action(async (amountStr: string, token: string, opts) => {
      try {
        const amount = parseFloat(amountStr);
        if (isNaN(amount) || amount <= 0) throw new Error('Invalid amount');

        const walletName = opts.wallet || getDefaultWalletName();
        const result = await lendService.withdraw(walletName, token, amount);

        if (isJsonMode()) {
          output(success(result));
        }
      } catch (err: any) {
        output(failure('LEND_WITHDRAW_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  lend
    .command('borrow <amount> <token>')
    .description('Borrow against collateral')
    .option('--collateral <token>', 'Collateral token')
    .option('--wallet <name>', 'Wallet to use')
    .action(async (amountStr: string, token: string, opts) => {
      try {
        const amount = parseFloat(amountStr);
        if (isNaN(amount) || amount <= 0) throw new Error('Invalid amount');
        if (!opts.collateral) throw new Error('--collateral is required');

        const walletName = opts.wallet || getDefaultWalletName();
        const result = await lendService.borrow(walletName, token, amount, opts.collateral);

        if (isJsonMode()) {
          output(success(result));
        }
      } catch (err: any) {
        output(failure('LEND_BORROW_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  lend
    .command('repay <amount> <token>')
    .description('Repay a loan')
    .option('--wallet <name>', 'Wallet to use')
    .action(async (amountStr: string, token: string, opts) => {
      try {
        const amount = parseFloat(amountStr);
        if (isNaN(amount) || amount <= 0) throw new Error('Invalid amount');

        const walletName = opts.wallet || getDefaultWalletName();
        const result = await lendService.repay(walletName, token, amount);

        if (isJsonMode()) {
          output(success(result));
        }
      } catch (err: any) {
        output(failure('LEND_REPAY_FAILED', err.message));
        process.exitCode = 1;
      }
    });
}
