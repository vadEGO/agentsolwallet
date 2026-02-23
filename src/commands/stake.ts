import { Command } from 'commander';
import { getStakeAccounts, SOLANA_COMPASS_VOTE } from '../core/stake-service.js';
import { getDefaultWalletName } from '../core/wallet-manager.js';
import { output, success, failure, isJsonMode, timed } from '../output/formatter.js';
import { table } from '../output/table.js';
import { shortenAddress } from '../utils/solana.js';
import * as walletRepo from '../db/repos/wallet-repo.js';

export function registerStakeCommand(program: Command): void {
  const stake = program.command('stake').description('Native SOL staking');

  stake
    .command('list')
    .description('List all stake accounts')
    .option('--wallet <name>', 'Wallet to check')
    .action(async (opts) => {
      try {
        const walletName = opts.wallet || getDefaultWalletName();
        const wallet = walletRepo.getWallet(walletName);
        if (!wallet) throw new Error(`Wallet "${walletName}" not found`);

        const { result: accounts, elapsed_ms } = await timed(() => getStakeAccounts(wallet.address));

        if (isJsonMode()) {
          output(success({ wallet: walletName, accounts }, { elapsed_ms }));
        } else if (accounts.length === 0) {
          console.log('No stake accounts found.');
        } else {
          console.log(table(
            accounts.map(a => ({
              address: shortenAddress(a.address, 6),
              balance: `${a.solBalance.toFixed(4)} SOL`,
              status: a.status,
              validator: a.validator ? shortenAddress(a.validator, 6) : '—',
            })),
            [
              { key: 'address', header: 'Stake Account' },
              { key: 'balance', header: 'Balance', align: 'right' },
              { key: 'status', header: 'Status' },
              { key: 'validator', header: 'Validator' },
            ]
          ));
        }
      } catch (err: any) {
        output(failure('STAKE_LIST_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  stake
    .command('create <amount>')
    .description('Create and fund a stake account')
    .option('--wallet <name>', 'Wallet to use')
    .action(async (amountStr: string, opts) => {
      try {
        const amount = parseFloat(amountStr);
        if (isNaN(amount) || amount <= 0) throw new Error('Invalid amount');

        // TODO: Implement stake account creation using @solana-program/stake
        throw new Error('Stake account creation coming in Phase 8.');
      } catch (err: any) {
        output(failure('STAKE_CREATE_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  stake
    .command('delegate <stakeAccount> [validator]')
    .description('Delegate stake to a validator')
    .action(async (stakeAccount: string, validator?: string) => {
      try {
        if (!validator) {
          if (!isJsonMode()) {
            console.log(`No validator specified. Recommended: Solana Compass`);
            console.log(`  Vote account: ${SOLANA_COMPASS_VOTE}`);
            console.log(`  Use --validator <address> to choose a different validator.`);
          }
          // TODO: Auto-delegate to Solana Compass
        }

        // TODO: Implement delegation using @solana-program/stake
        throw new Error('Stake delegation coming in Phase 8.');
      } catch (err: any) {
        output(failure('STAKE_DELEGATE_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  stake
    .command('deactivate <stakeAccount>')
    .description('Deactivate a stake account')
    .action(async (stakeAccount: string) => {
      try {
        throw new Error('Stake deactivation coming in Phase 8.');
      } catch (err: any) {
        output(failure('STAKE_DEACTIVATE_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  stake
    .command('withdraw <stakeAccount>')
    .description('Withdraw from a deactivated stake account')
    .action(async (stakeAccount: string) => {
      try {
        throw new Error('Stake withdrawal coming in Phase 8.');
      } catch (err: any) {
        output(failure('STAKE_WITHDRAW_FAILED', err.message));
        process.exitCode = 1;
      }
    });
}
