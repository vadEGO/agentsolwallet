import { Command } from 'commander';
import * as lpService from '../core/lp-service.js';
import { getDefaultWalletName, resolveWalletName } from '../core/wallet-manager.js';
import { output, success, failure, isJsonMode, timed } from '../output/formatter.js';
import { table } from '../output/table.js';
import * as walletRepo from '../db/repos/wallet-repo.js';

export function registerLpCommand(program: Command): void {
  const lp = program.command('lp').description('Liquidity pool operations');

  lp
    .command('pools <tokenA> <tokenB>')
    .description('List available pools for a token pair')
    .action(async (tokenA: string, tokenB: string) => {
      try {
        const { result: pools, elapsed_ms } = await timed(() => lpService.getPools(tokenA, tokenB));

        if (isJsonMode()) {
          output(success({ tokenA, tokenB, pools }, { elapsed_ms }));
        } else if (pools.length === 0) {
          console.log(`No pools found for ${tokenA}/${tokenB}. LP integration coming in Phase 10.`);
        } else {
          console.log(table(
            pools.map(p => ({
              id: p.id.slice(0, 12) + '...',
              protocol: p.protocol,
              tvl: `$${p.tvl.toLocaleString()}`,
              apy: `${(p.apy * 100).toFixed(2)}%`,
              fee: `${(p.fee * 100).toFixed(2)}%`,
            })),
            [
              { key: 'id', header: 'Pool ID' },
              { key: 'protocol', header: 'Protocol' },
              { key: 'tvl', header: 'TVL', align: 'right' },
              { key: 'apy', header: 'APY', align: 'right' },
              { key: 'fee', header: 'Fee', align: 'right' },
            ]
          ));
        }
      } catch (err: any) {
        output(failure('LP_POOLS_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  lp
    .command('positions')
    .description('List all LP positions')
    .option('--wallet <name>', 'Wallet to check')
    .action(async (opts) => {
      try {
        const walletName = opts.wallet ? resolveWalletName(opts.wallet) : getDefaultWalletName();
        const wallet = walletRepo.getWallet(walletName);
        if (!wallet) throw new Error(`Wallet "${walletName}" not found`);

        const { result: positions, elapsed_ms } = await timed(() => lpService.getPositions(wallet.address));

        if (isJsonMode()) {
          output(success({ wallet: walletName, positions }, { elapsed_ms }));
        } else if (positions.length === 0) {
          console.log('No LP positions found.');
        } else {
          console.log(table(
            positions.map(p => ({
              pool: p.poolId.slice(0, 12) + '...',
              protocol: p.protocol,
              tokens: `${p.amountA.toFixed(4)} ${p.tokenA} / ${p.amountB.toFixed(4)} ${p.tokenB}`,
              value: `$${p.valueUsd.toFixed(2)}`,
              fees: `$${p.feesEarned.toFixed(2)}`,
            })),
            [
              { key: 'pool', header: 'Pool' },
              { key: 'protocol', header: 'Protocol' },
              { key: 'tokens', header: 'Tokens' },
              { key: 'value', header: 'Value', align: 'right' },
              { key: 'fees', header: 'Fees Earned', align: 'right' },
            ]
          ));
        }
      } catch (err: any) {
        output(failure('LP_POSITIONS_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  lp
    .command('deposit <poolId> <amountA> <tokenA> <amountB> <tokenB>')
    .description('Add liquidity to a pool')
    .option('--wallet <name>', 'Wallet to use')
    .action(async (poolId: string, amountAStr: string, tokenA: string, amountBStr: string, tokenB: string, opts) => {
      try {
        const amountA = parseFloat(amountAStr);
        const amountB = parseFloat(amountBStr);
        if (isNaN(amountA) || isNaN(amountB)) throw new Error('Invalid amounts');

        const walletName = opts.wallet ? resolveWalletName(opts.wallet) : getDefaultWalletName();
        const result = await lpService.deposit(walletName, poolId, amountA, tokenA, amountB, tokenB);

        if (isJsonMode()) {
          output(success(result));
        } else {
          console.log(`Added liquidity: ${amountA} ${tokenA} + ${amountB} ${tokenB}`);
          console.log(`  Signature: ${result.signature}`);
        }
      } catch (err: any) {
        output(failure('LP_DEPOSIT_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  lp
    .command('withdraw <poolId>')
    .description('Remove liquidity from a pool')
    .option('--percent <n>', 'Remove percentage (default: 100)', parseInt)
    .option('--wallet <name>', 'Wallet to use')
    .action(async (poolId: string, opts) => {
      try {
        const walletName = opts.wallet ? resolveWalletName(opts.wallet) : getDefaultWalletName();
        const result = await lpService.withdraw(walletName, poolId, opts.percent);

        if (isJsonMode()) {
          output(success(result));
        }
      } catch (err: any) {
        output(failure('LP_WITHDRAW_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  lp
    .command('fees <poolId>')
    .description('Show unclaimed fees/rewards')
    .action(async (poolId: string) => {
      try {
        // TODO: Implement in Phase 10
        if (isJsonMode()) {
          output(success({ poolId, fees: [], message: 'Coming in Phase 10' }));
        } else {
          console.log(`Fee tracking coming in Phase 10.`);
        }
      } catch (err: any) {
        output(failure('LP_FEES_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  lp
    .command('claim <poolId>')
    .description('Claim fees/rewards from a pool')
    .option('--wallet <name>', 'Wallet to use')
    .action(async (poolId: string, opts) => {
      try {
        const walletName = opts.wallet ? resolveWalletName(opts.wallet) : getDefaultWalletName();
        const result = await lpService.claimFees(walletName, poolId);

        if (isJsonMode()) {
          output(success(result));
        }
      } catch (err: any) {
        output(failure('LP_CLAIM_FAILED', err.message));
        process.exitCode = 1;
      }
    });
}
