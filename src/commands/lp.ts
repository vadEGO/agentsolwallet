import { Command } from 'commander';
import { ensureProviders } from '../sdk-init.js';
import { LP_PROTOCOL_NAMES } from '@agentsolwallet/sdk';
import { getDefaultWalletName, resolveWalletName } from '../core/wallet-manager.js';
import { isPermitted } from '../core/config-manager.js';
import { output, success, failure, isJsonMode, timed } from '../output/formatter.js';
import { table } from '../output/table.js';
import * as walletRepo from '../db/repos/wallet-repo.js';

export function registerLpCommand(program: Command): void {
  const lp = program.command('lp').description('Liquidity pool operations (Orca, Raydium, Meteora, Kamino)');

  const protocolOption = '--protocol <name>';
  const protocolDesc = `Protocol filter (${LP_PROTOCOL_NAMES.join(', ')})`;
  const walletOption = '--wallet <name>';

  // ── pools ────────────────────────────────────────────

  lp
    .command('pools [tokenA] [tokenB]')
    .description('Browse pools for a token or pair')
    .option(protocolOption, protocolDesc)
    .option('--sort <field>', 'Sort by: tvl (default), apy, volume', 'tvl')
    .option('--type <type>', 'Filter by pool type: amm, clmm')
    .option('--limit <n>', 'Max results', parseInt)
    .action(async (tokenA: string | undefined, tokenB: string | undefined, opts) => {
      try {
        const sdk = await ensureProviders();
        const sort = (['tvl', 'apy', 'volume'].includes(opts.sort) ? opts.sort : 'tvl') as 'tvl' | 'apy' | 'volume';
        const poolType = opts.type === 'amm' || opts.type === 'clmm' ? opts.type : undefined;

        const { result, elapsed_ms } = await timed(() =>
          sdk.lp.getPools(tokenA, tokenB, {
            protocol: opts.protocol, sort, limit: opts.limit ?? 20, poolType,
          })
        );

        if (isJsonMode()) {
          output(success({ tokenA, tokenB, ...result }, { elapsed_ms }));
        } else if (result.pools.length === 0) {
          const label = tokenA ? (tokenB ? `${tokenA}/${tokenB}` : tokenA) : 'any tokens';
          console.log(`No pools found for ${label}.`);
        } else {
          const pairLabel = tokenA ? (tokenB ? ` — ${tokenA}/${tokenB}` : ` — ${tokenA}`) : '';
          const protoLabel = opts.protocol ? ` — ${opts.protocol}` : '';
          console.log(`LP Pools${protoLabel}${pairLabel}\n`);

          console.log(table(
            result.pools.map(p => ({
              protocol: p.protocol,
              pair: `${p.tokenA}/${p.tokenB}`,
              type: p.poolType.toUpperCase(),
              tvl: p.tvlUsd != null ? `$${fmtLargeAmount(p.tvlUsd)}` : '\u2014',
              apy: p.apy != null ? `${(p.apy * 100).toFixed(2)}%` : '\u2014',
              volume: p.volume24hUsd != null ? `$${fmtLargeAmount(p.volume24hUsd)}` : '\u2014',
              fee: `${(p.feeRate * 100).toFixed(2)}%`,
              poolId: p.poolId,
            })),
            [
              { key: 'protocol', header: 'Protocol' },
              { key: 'pair', header: 'Pair' },
              { key: 'type', header: 'Type' },
              { key: 'tvl', header: 'TVL', align: 'right' },
              { key: 'apy', header: 'APY', align: 'right' },
              { key: 'volume', header: '24h Vol', align: 'right' },
              { key: 'fee', header: 'Fee', align: 'right' },
              { key: 'poolId', header: 'Pool ID' },
            ],
          ));

          if (result.warnings.length > 0) {
            for (const w of result.warnings) console.log(`  Warning: ${w}`);
          }
          console.log(`\nRun \`sol lp deposit <poolId> <amount> <token>\` to add liquidity.`);
        }
      } catch (err: any) {
        output(failure('LP_POOLS_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  // ── info ─────────────────────────────────────────────

  lp
    .command('info <poolId>')
    .description('Detailed pool info')
    .option(walletOption, 'Show your positions in this pool')
    .action(async (poolId: string, opts) => {
      try {
        const sdk = await ensureProviders();
        const { result, elapsed_ms } = await timed(async () => {
          const { pools } = await sdk.lp.getPools();
          const pool = pools.find(p => p.poolId === poolId);
          if (!pool) throw new Error(`Pool ${poolId} not found`);

          let positions = undefined;
          if (opts.wallet) {
            const walletName = resolveWalletName(opts.wallet);
            const wallet = walletRepo.getWallet(walletName);
            if (wallet) {
              const allPos = await sdk.lp.getPositions(wallet.address);
              positions = allPos.filter(p => p.poolId === poolId);
            }
          }
          return { pool, positions };
        });

        if (isJsonMode()) {
          output(success(result, { elapsed_ms }));
        } else {
          const p = result.pool;
          console.log(`Pool: ${p.poolId}`);
          console.log(`  Protocol:   ${p.protocol}`);
          console.log(`  Type:       ${p.poolType.toUpperCase()}`);
          console.log(`  Pair:       ${p.tokenA}/${p.tokenB}`);
          console.log(`  Fee:        ${(p.feeRate * 100).toFixed(2)}%`);
          console.log(`  Price:      ${fmtAmount(p.currentPrice)} ${p.tokenB}/${p.tokenA}`);
          if (p.tvlUsd != null) console.log(`  TVL:        $${fmtLargeAmount(p.tvlUsd)}`);
          if (p.apy != null) console.log(`  APY:        ${(p.apy * 100).toFixed(2)}%`);
          if (p.volume24hUsd != null) console.log(`  24h Vol:    $${fmtLargeAmount(p.volume24hUsd)}`);
          if (p.tickSpacing != null) console.log(`  Tick space: ${p.tickSpacing}`);
          if (p.binStep != null) console.log(`  Bin step:   ${p.binStep}`);

          if (result.positions && result.positions.length > 0) {
            console.log('\nYour positions:');
            for (const pos of result.positions) {
              console.log(`  ${pos.positionId}: ${fmtAmount(pos.amountA)} ${pos.tokenA} + ${fmtAmount(pos.amountB)} ${pos.tokenB} ($${pos.valueUsd.toFixed(2)})`);
              if (pos.unclaimedFeesUsd > 0) console.log(`    Unclaimed fees: $${pos.unclaimedFeesUsd.toFixed(2)}`);
            }
          }
        }
      } catch (err: any) {
        output(failure('LP_INFO_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  // ── configs ─────────────────────────────────────────

  lp
    .command('configs')
    .description('Show available pool creation configurations per protocol')
    .option(protocolOption, protocolDesc)
    .option('--type <type>', 'Filter by pool type: amm, clmm')
    .action(async (opts) => {
      try {
        const sdk = await ensureProviders();
        const poolType = opts.type === 'amm' || opts.type === 'clmm' ? opts.type : undefined;

        const { result: configs, elapsed_ms } = await timed(() =>
          sdk.lp.getConfigs(opts.protocol, poolType)
        );

        if (isJsonMode()) {
          output(success({ protocol: opts.protocol ?? 'all', poolType: poolType ?? 'all', configs }, { elapsed_ms }));
        } else if (configs.length === 0) {
          console.log('No configs found.');
        } else {
          const protoLabel = opts.protocol ? ` — ${opts.protocol}` : '';
          const typeLabel = poolType ? ` (${poolType.toUpperCase()})` : '';
          console.log(`Pool Creation Configs${protoLabel}${typeLabel}\n`);

          console.log(table(
            configs.map(c => ({
              protocol: c.protocol,
              type: c.poolType.toUpperCase(),
              fee: `${c.feeBps}`,
              tickSpacing: c.tickSpacing != null ? String(c.tickSpacing) : '\u2014',
              binStep: c.binStep != null ? String(c.binStep) : '\u2014',
              createFee: c.createFeeSol != null ? `${c.createFeeSol} SOL` : '\u2014',
              configId: c.configId ?? '\u2014',
            })),
            [
              { key: 'protocol', header: 'Protocol' },
              { key: 'type', header: 'Type' },
              { key: 'fee', header: 'Fee (bps)', align: 'right' },
              { key: 'tickSpacing', header: 'Tick Spacing', align: 'right' },
              { key: 'binStep', header: 'Bin Step', align: 'right' },
              { key: 'createFee', header: 'Create Fee', align: 'right' },
              { key: 'configId', header: 'Config ID' },
            ],
          ));

          console.log(`\nUse --fee-tier, --tick-spacing, or --bin-step with 'sol lp create'.`);
        }
      } catch (err: any) {
        output(failure('LP_CONFIGS_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  // ── positions ────────────────────────────────────────

  lp
    .command('positions')
    .description('Show LP positions')
    .option(walletOption, 'Wallet to check')
    .option(protocolOption, protocolDesc)
    .action(async (opts) => {
      try {
        const sdk = await ensureProviders();
        const walletName = opts.wallet ? resolveWalletName(opts.wallet) : getDefaultWalletName();
        const wallet = walletRepo.getWallet(walletName);
        if (!wallet) throw new Error(`Wallet "${walletName}" not found`);

        const { result: positions, elapsed_ms } = await timed(() =>
          sdk.lp.getPositions(wallet.address, opts.protocol)
        );

        if (isJsonMode()) {
          output(success({ wallet: walletName, protocol: opts.protocol ?? 'all', positions }, { elapsed_ms }));
        } else if (positions.length === 0) {
          console.log('No LP positions found.');
          console.log('Run `sol lp pools` to browse available pools.');
        } else {
          console.log('LP Positions\n');

          console.log(table(
            positions.map(p => {
              const rangeStr = p.poolType === 'amm' ? 'full' :
                p.lowerPrice != null && p.upperPrice != null
                  ? `$${fmtAmount(p.lowerPrice)}\u2014$${fmtAmount(p.upperPrice)} ${p.inRange ? '\u2713' : '\u2717 OUT'}`
                  : 'managed';
              return {
                protocol: p.protocol,
                pool: `${p.tokenA}/${p.tokenB}`,
                type: p.poolType.toUpperCase(),
                tokenA: `${fmtAmount(p.amountA)} ${p.tokenA}`,
                tokenB: `${fmtAmount(p.amountB)} ${p.tokenB}`,
                value: `$${p.valueUsd.toFixed(2)}`,
                fees: p.unclaimedFeesUsd > 0 ? `$${p.unclaimedFeesUsd.toFixed(2)}` : '\u2014',
                range: rangeStr,
                positionId: p.positionId,
              };
            }),
            [
              { key: 'protocol', header: 'Protocol' },
              { key: 'pool', header: 'Pool' },
              { key: 'type', header: 'Type' },
              { key: 'tokenA', header: 'Token A', align: 'right' },
              { key: 'tokenB', header: 'Token B', align: 'right' },
              { key: 'value', header: 'Value', align: 'right' },
              { key: 'fees', header: 'Fees', align: 'right' },
              { key: 'range', header: 'Range' },
              { key: 'positionId', header: 'Position ID' },
            ],
          ));

          // P&L section
          const withPnl = positions.filter(p => p.pnl);
          if (withPnl.length > 0) {
            console.log('\nP&L\n');
            console.log(table(
              withPnl.map(p => ({
                pool: `${p.tokenA}/${p.tokenB}`,
                deposit: `$${p.pnl!.depositValueUsd.toFixed(2)}`,
                current: `$${p.valueUsd.toFixed(2)}`,
                il: p.pnl!.ilUsd !== 0 ? `-$${Math.abs(p.pnl!.ilUsd).toFixed(2)}` : '\u2014',
                fees: `$${p.pnl!.feesEarnedUsd.toFixed(2)}`,
                netPnl: `${p.pnl!.netPnlUsd >= 0 ? '+' : ''}$${p.pnl!.netPnlUsd.toFixed(2)}`,
                feeIl: p.pnl!.feeToIlRatio != null ? `${p.pnl!.feeToIlRatio.toFixed(2)}x` : '\u2014',
              })),
              [
                { key: 'pool', header: 'Pool' },
                { key: 'deposit', header: 'Deposit', align: 'right' },
                { key: 'current', header: 'Current', align: 'right' },
                { key: 'il', header: 'IL', align: 'right' },
                { key: 'fees', header: 'Fees', align: 'right' },
                { key: 'netPnl', header: 'Net P&L', align: 'right' },
                { key: 'feeIl', header: 'Fee/IL', align: 'right' },
              ],
            ));
          }

          const totalValue = positions.reduce((s, p) => s + p.valueUsd, 0);
          const totalFees = positions.reduce((s, p) => s + p.unclaimedFeesUsd, 0);
          console.log(`\nTotal value: $${totalValue.toFixed(2)}` + (totalFees > 0 ? `  Unclaimed fees: $${totalFees.toFixed(2)}` : ''));

          const outOfRange = positions.filter(p => p.inRange === false);
          if (outOfRange.length > 0) {
            console.log(`\n${outOfRange.length} position${outOfRange.length > 1 ? 's' : ''} out of range (not earning fees).`);
            console.log('  Consider rebalancing: sol lp withdraw <id> && sol lp deposit <pool> ...');
          }
        }
      } catch (err: any) {
        output(failure('LP_POSITIONS_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  // ── deposit ──────────────────────────────────────────

  if (isPermitted('canLend')) lp
    .command('deposit <poolId> <amount> <token> [amountB] [tokenB]')
    .description('Add liquidity to a pool')
    .option(walletOption, 'Wallet to use')
    .option('--position <id>', 'Add to existing position')
    .option('--lower-price <n>', 'CLMM/DLMM: lower price bound', parseFloat)
    .option('--upper-price <n>', 'CLMM/DLMM: upper price bound', parseFloat)
    .option('--range <pct>', 'CLMM/DLMM: \u00b1percentage of current price', parseFloat)
    .option('--slippage <bps>', 'Slippage tolerance (default: 100)', parseInt)
    .option('--quote-only', 'Preview deposit amounts without executing')
    .option(protocolOption, protocolDesc)
    .action(async (poolId: string, amountStr: string, token: string, amountBStr: string | undefined, tokenBArg: string | undefined, opts) => {
      try {
        const amount = parseFloat(amountStr);
        if (isNaN(amount) || amount <= 0) throw new Error('Invalid amount');

        const sdk = await ensureProviders();
        const walletName = opts.wallet ? resolveWalletName(opts.wallet) : getDefaultWalletName();

        const params: any = {
          poolId,
          amount,
          token,
          positionId: opts.position,
          lowerPrice: opts.lowerPrice,
          upperPrice: opts.upperPrice,
          rangePct: opts.range,
          slippageBps: opts.slippage ?? 100,
        };

        // Dual-token mode
        if (amountBStr && tokenBArg) {
          const amountB = parseFloat(amountBStr);
          if (isNaN(amountB) || amountB <= 0) throw new Error('Invalid second amount');
          params.amountA = amount;
          params.amountB = amountB;
          // token and tokenB used for resolution
        }

        if (opts.quoteOnly) {
          const { result: quote, elapsed_ms } = await timed(() =>
            sdk.lp.getDepositQuote(walletName, params, opts.protocol)
          );

          if (isJsonMode()) {
            output(success(quote, { elapsed_ms }));
          } else {
            console.log(`Deposit Quote — ${quote.protocol}\n`);
            console.log(`  Pool:      ${quote.poolId}`);
            console.log(`  Token A:   ${fmtAmount(quote.amountA)} ${quote.tokenA}`);
            console.log(`  Token B:   ${fmtAmount(quote.amountB)} ${quote.tokenB}`);
            console.log(`  Value:     $${quote.estimatedValueUsd.toFixed(2)}`);
            console.log(`  Price:     ${fmtAmount(quote.currentPrice)}`);
            if (quote.priceImpactPct != null) console.log(`  Impact:    ${quote.priceImpactPct.toFixed(4)}%`);
            if (quote.lowerPrice != null) console.log(`  Range:     $${fmtAmount(quote.lowerPrice)} \u2014 $${fmtAmount(quote.upperPrice!)}`);
            console.log(`\nRemove --quote-only to execute.`);
          }
        } else {
          const { result, elapsed_ms } = await timed(() =>
            sdk.lp.deposit(walletName, params, opts.protocol)
          );

          if (isJsonMode()) {
            output(success(result, { elapsed_ms }));
          } else {
            console.log(`Added liquidity via ${result.protocol}`);
            console.log(`  Tx: ${result.explorerUrl}`);
            if (result.positionId) console.log(`  Position: ${result.positionId}`);
            console.log(`\nRun \`sol lp positions\` to see your positions.`);
          }
        }
      } catch (err: any) {
        output(failure('LP_DEPOSIT_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  // ── withdraw ─────────────────────────────────────────

  if (isPermitted('canWithdrawLend')) lp
    .command('withdraw <positionId>')
    .description('Remove liquidity (default: 100%, auto-closes position)')
    .option('--percent <n>', 'Partial withdrawal (1-100, no auto-close)', parseInt)
    .option('--keep', "Don't close position on 100% withdraw")
    .option(walletOption, 'Wallet to use')
    .option('--slippage <bps>', 'Slippage tolerance', parseInt)
    .option(protocolOption, protocolDesc)
    .action(async (positionId: string, opts) => {
      try {
        const sdk = await ensureProviders();
        const walletName = opts.wallet ? resolveWalletName(opts.wallet) : getDefaultWalletName();
        const percent = opts.percent ?? 100;
        const close = opts.keep ? false : (percent === 100);

        const { result, elapsed_ms } = await timed(() =>
          sdk.lp.withdraw(walletName, {
            positionId, percent, close,
            slippageBps: opts.slippage ?? 100,
          }, opts.protocol)
        );

        if (isJsonMode()) {
          output(success(result, { elapsed_ms }));
        } else {
          const label = percent === 100 ? 'Removed all liquidity' : `Removed ${percent}% of liquidity`;
          console.log(`${label} via ${result.protocol}`);
          console.log(`  Tx: ${result.explorerUrl}`);
          if (close) console.log('  Position closed and rent reclaimed.');
          console.log(`\nRun \`sol lp positions\` to check remaining positions.`);
        }
      } catch (err: any) {
        output(failure('LP_WITHDRAW_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  // ── claim ────────────────────────────────────────────

  if (isPermitted('canWithdrawLend')) lp
    .command('claim <positionId>')
    .description('Claim uncollected fees/rewards')
    .option(walletOption, 'Wallet to use')
    .option(protocolOption, protocolDesc)
    .action(async (positionId: string, opts) => {
      try {
        const sdk = await ensureProviders();
        const walletName = opts.wallet ? resolveWalletName(opts.wallet) : getDefaultWalletName();

        const { result, elapsed_ms } = await timed(() =>
          sdk.lp.claimFees(walletName, positionId, opts.protocol)
        );

        if (isJsonMode()) {
          output(success(result, { elapsed_ms }));
        } else {
          console.log(`Claimed fees via ${result.protocol}`);
          console.log(`  Tx: ${result.explorerUrl}`);
        }
      } catch (err: any) {
        output(failure('LP_CLAIM_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  // ── farm ─────────────────────────────────────────────

  const farm = lp.command('farm').description('Farm operations (stake, unstake, harvest)');

  farm
    .command('list')
    .description('Show staked positions and pending farm rewards')
    .option(walletOption, 'Wallet to check')
    .option(protocolOption, protocolDesc)
    .action(async (opts) => {
      try {
        const sdk = await ensureProviders();
        const walletName = opts.wallet ? resolveWalletName(opts.wallet) : getDefaultWalletName();
        const wallet = walletRepo.getWallet(walletName);
        if (!wallet) throw new Error(`Wallet "${walletName}" not found`);

        const { result: farms, elapsed_ms } = await timed(() =>
          sdk.lp.getFarms(wallet.address, opts.protocol)
        );

        if (isJsonMode()) {
          output(success({ wallet: walletName, farms }, { elapsed_ms }));
        } else if (farms.length === 0) {
          console.log('No staked LP positions found.');
        } else {
          console.log('Farm Positions\n');
          console.log(table(
            farms.map(f => ({
              protocol: f.protocol,
              pool: f.poolId,
              staked: `$${f.stakedValueUsd.toFixed(2)}`,
              rewards: f.pendingRewards.map(r => `${fmtAmount(r.amount)} ${r.token}`).join(', ') || '\u2014',
              rewardsUsd: `$${f.pendingRewards.reduce((s, r) => s + r.valueUsd, 0).toFixed(2)}`,
            })),
            [
              { key: 'protocol', header: 'Protocol' },
              { key: 'pool', header: 'Pool' },
              { key: 'staked', header: 'Staked', align: 'right' },
              { key: 'rewards', header: 'Pending Rewards' },
              { key: 'rewardsUsd', header: 'Value', align: 'right' },
            ],
          ));
        }
      } catch (err: any) {
        output(failure('LP_FARM_LIST_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  if (isPermitted('canLend')) farm
    .command('stake <positionId>')
    .description('Stake LP position in farm for additional rewards')
    .option(walletOption, 'Wallet to use')
    .option('--farm <id>', 'Specific farm ID')
    .option(protocolOption, protocolDesc)
    .action(async (positionId: string, opts) => {
      try {
        const sdk = await ensureProviders();
        const walletName = opts.wallet ? resolveWalletName(opts.wallet) : getDefaultWalletName();

        const { result, elapsed_ms } = await timed(() =>
          sdk.lp.farmStake(walletName, positionId, opts.farm ?? '', opts.protocol)
        );

        if (isJsonMode()) {
          output(success(result, { elapsed_ms }));
        } else {
          console.log(`Staked in farm via ${result.protocol}`);
          console.log(`  Tx: ${result.explorerUrl}`);
        }
      } catch (err: any) {
        output(failure('LP_FARM_STAKE_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  if (isPermitted('canWithdrawLend')) farm
    .command('unstake <positionId>')
    .description('Unstake LP position from farm')
    .option(walletOption, 'Wallet to use')
    .option('--farm <id>', 'Specific farm ID')
    .option(protocolOption, protocolDesc)
    .action(async (positionId: string, opts) => {
      try {
        const sdk = await ensureProviders();
        const walletName = opts.wallet ? resolveWalletName(opts.wallet) : getDefaultWalletName();

        const { result, elapsed_ms } = await timed(() =>
          sdk.lp.farmUnstake(walletName, positionId, opts.farm ?? '', opts.protocol)
        );

        if (isJsonMode()) {
          output(success(result, { elapsed_ms }));
        } else {
          console.log(`Unstaked from farm via ${result.protocol}`);
          console.log(`  Tx: ${result.explorerUrl}`);
        }
      } catch (err: any) {
        output(failure('LP_FARM_UNSTAKE_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  if (isPermitted('canWithdrawLend')) farm
    .command('harvest <positionId>')
    .description('Harvest pending farm rewards')
    .option(walletOption, 'Wallet to use')
    .option(protocolOption, protocolDesc)
    .action(async (positionId: string, opts) => {
      try {
        const sdk = await ensureProviders();
        const walletName = opts.wallet ? resolveWalletName(opts.wallet) : getDefaultWalletName();

        const { result, elapsed_ms } = await timed(() =>
          sdk.lp.farmHarvest(walletName, positionId, opts.protocol)
        );

        if (isJsonMode()) {
          output(success(result, { elapsed_ms }));
        } else {
          console.log(`Harvested rewards via ${result.protocol}`);
          console.log(`  Tx: ${result.explorerUrl}`);
        }
      } catch (err: any) {
        output(failure('LP_FARM_HARVEST_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  // ── create ───────────────────────────────────────────

  if (isPermitted('canLend')) lp
    .command('create <tokenA> <tokenB> <amountA> <amountB>')
    .description('Create a new pool')
    .requiredOption(protocolOption, protocolDesc)
    .option('--fee-tier <bps>', 'Fee tier in bps', parseInt)
    .option('--initial-price <n>', 'Starting price', parseFloat)
    .option('--tick-spacing <n>', 'Orca/Raydium CLMM tick spacing', parseInt)
    .option('--bin-step <n>', 'Meteora DLMM bin step', parseInt)
    .option('--type <type>', 'Pool type: amm, clmm')
    .option(walletOption, 'Wallet to use')
    .action(async (tokenA: string, tokenB: string, amountAStr: string, amountBStr: string, opts) => {
      try {
        const amountA = parseFloat(amountAStr);
        const amountB = parseFloat(amountBStr);
        if (isNaN(amountA) || isNaN(amountB) || amountA <= 0 || amountB <= 0) throw new Error('Invalid amounts');

        const sdk = await ensureProviders();
        const walletName = opts.wallet ? resolveWalletName(opts.wallet) : getDefaultWalletName();

        const { result, elapsed_ms } = await timed(() =>
          sdk.lp.createPool(walletName, {
            mintA: tokenA, mintB: tokenB,
            amountA, amountB,
            feeTier: opts.feeTier,
            initialPrice: opts.initialPrice,
            poolType: opts.type === 'amm' || opts.type === 'clmm' ? opts.type : undefined,
            tickSpacing: opts.tickSpacing,
            binStep: opts.binStep,
          }, opts.protocol)
        );

        if (isJsonMode()) {
          output(success(result, { elapsed_ms }));
        } else {
          console.log(`Created pool via ${result.protocol}`);
          console.log(`  Tx: ${result.explorerUrl}`);
          if (result.positionId) console.log(`  Pool: ${result.positionId}`);
        }
      } catch (err: any) {
        output(failure('LP_CREATE_FAILED', err.message));
        process.exitCode = 1;
      }
    });
}

// ── Helpers ───────────────────────────────────────────

function fmtAmount(n: number): string {
  if (n >= 1_000_000) return n.toFixed(0);
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.0001) return n.toFixed(6);
  return n.toFixed(9);
}

function fmtLargeAmount(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return fmtAmount(n);
}
