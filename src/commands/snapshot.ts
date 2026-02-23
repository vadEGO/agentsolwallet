import { Command } from 'commander';
import * as walletManager from '../core/wallet-manager.js';
import { getTokenBalances } from '../core/token-service.js';
import { getPrices } from '../core/price-service.js';
import * as snapshotRepo from '../db/repos/snapshot-repo.js';
import { output, success, failure, isJsonMode, timed } from '../output/formatter.js';
import { table } from '../output/table.js';

export function registerSnapshotCommand(program: Command): void {
  const snapshot = program.command('snapshot').description('Portfolio snapshots for tracking P&L');

  snapshot
    .command('take')
    .description('Take a snapshot of all wallet balances')
    .option('--label <label>', 'Label for this snapshot')
    .action(async (opts) => {
      try {
        const { result: data, elapsed_ms } = await timed(async () => {
          const wallets = walletManager.listWallets();
          if (wallets.length === 0) throw new Error('No wallets found');

          // 1. Fetch all balances first
          const walletBalances = new Map<string, Awaited<ReturnType<typeof getTokenBalances>>>();
          const allMints = new Set<string>();

          for (const wallet of wallets) {
            const balances = await getTokenBalances(wallet.address);
            walletBalances.set(wallet.name, balances);
            for (const b of balances) allMints.add(b.mint);
          }

          // 2. Deduplicate and fetch prices in a single batch
          const prices = await getPrices([...allMints]);

          // 3. Insert snapshot entries
          const snapshotId = snapshotRepo.createSnapshot(opts.label);
          let totalValueUsd = 0;
          let entryCount = 0;

          for (const wallet of wallets) {
            const balances = walletBalances.get(wallet.name) || [];
            for (const b of balances) {
              const price = prices.get(b.mint);
              const valueUsd = price ? b.uiBalance * price.priceUsd : null;
              if (valueUsd) totalValueUsd += valueUsd;

              snapshotRepo.insertSnapshotEntry({
                snapshot_id: snapshotId,
                wallet_name: wallet.name,
                wallet_address: wallet.address,
                mint: b.mint,
                symbol: b.symbol,
                balance: b.balance,
                price_usd: price?.priceUsd ?? null,
                value_usd: valueUsd,
                position_type: 'token',
                protocol: null,
                pool_id: null,
              });
              entryCount++;
            }
          }

          return { snapshotId, walletCount: wallets.length, entryCount, totalValueUsd };
        });

        if (isJsonMode()) {
          output(success(data, { elapsed_ms }));
        } else {
          console.log(`Snapshot #${data.snapshotId} taken`);
          console.log(`  Wallets: ${data.walletCount}`);
          console.log(`  Entries: ${data.entryCount}`);
          console.log(`  Total value: $${data.totalValueUsd.toFixed(2)}`);
        }
      } catch (err: any) {
        output(failure('SNAPSHOT_TAKE_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  snapshot
    .command('list')
    .description('List all snapshots')
    .action(() => {
      try {
        const snapshots = snapshotRepo.listSnapshots();

        if (isJsonMode()) {
          output(success(snapshots));
        } else if (snapshots.length === 0) {
          console.log('No snapshots found. Take one with: sol snapshot take');
        } else {
          console.log(table(
            snapshots.map(s => ({
              id: String(s.id),
              label: s.label || '—',
              date: s.created_at,
            })),
            [
              { key: 'id', header: 'ID' },
              { key: 'label', header: 'Label' },
              { key: 'date', header: 'Date' },
            ]
          ));
        }
      } catch (err: any) {
        output(failure('SNAPSHOT_LIST_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  snapshot
    .command('compare <id1> [id2]')
    .description('Compare two snapshots or current vs snapshot')
    .option('--last <period>', 'Compare current vs N days/hours ago (e.g., 7d, 24h)')
    .action(async (id1Str: string, id2Str?: string, opts?: any) => {
      try {
        const { result: data, elapsed_ms } = await timed(async () => {
          const id1 = parseInt(id1Str);
          const entries1 = snapshotRepo.getSnapshotEntries(id1);
          if (entries1.length === 0) throw new Error(`Snapshot #${id1} not found or empty`);

          let entries2;
          let label2: string;

          if (id2Str) {
            const id2 = parseInt(id2Str);
            entries2 = snapshotRepo.getSnapshotEntries(id2);
            label2 = `Snapshot #${id2}`;
          } else {
            // Compare against latest snapshot or time period
            throw new Error('Compare with current state coming soon. Provide two snapshot IDs.');
          }

          // Build comparison
          const map1 = new Map(entries1.map(e => [`${e.wallet_name}:${e.mint}`, e]));
          const map2 = new Map(entries2.map(e => [`${e.wallet_name}:${e.mint}`, e]));

          const allKeys = new Set([...map1.keys(), ...map2.keys()]);
          const diffs = [];

          for (const key of allKeys) {
            const e1 = map1.get(key);
            const e2 = map2.get(key);
            const v1 = e1?.value_usd ?? 0;
            const v2 = e2?.value_usd ?? 0;
            const change = v2 - v1;
            if (Math.abs(change) > 0.01) {
              diffs.push({
                wallet: e1?.wallet_name || e2?.wallet_name || '',
                symbol: e1?.symbol || e2?.symbol || 'unknown',
                valueBefore: v1,
                valueAfter: v2,
                change,
                changePct: v1 > 0 ? (change / v1) * 100 : null,
              });
            }
          }

          const totalBefore = entries1.reduce((s, e) => s + (e.value_usd ?? 0), 0);
          const totalAfter = entries2.reduce((s, e) => s + (e.value_usd ?? 0), 0);

          return {
            snapshot1: id1,
            snapshot2: id2Str ? parseInt(id2Str) : 'current',
            diffs: diffs.sort((a, b) => Math.abs(b.change) - Math.abs(a.change)),
            totalBefore,
            totalAfter,
            totalChange: totalAfter - totalBefore,
          };
        });

        if (isJsonMode()) {
          output(success(data, { elapsed_ms }));
        } else {
          console.log(`Comparing Snapshot #${data.snapshot1} vs ${data.snapshot2}:\n`);
          if (data.diffs.length === 0) {
            console.log('No significant changes.');
          } else {
            console.log(table(
              data.diffs.map(d => ({
                wallet: d.wallet,
                symbol: d.symbol,
                before: `$${d.valueBefore.toFixed(2)}`,
                after: `$${d.valueAfter.toFixed(2)}`,
                change: `${d.change >= 0 ? '+' : ''}$${d.change.toFixed(2)}`,
              })),
              [
                { key: 'wallet', header: 'Wallet' },
                { key: 'symbol', header: 'Token' },
                { key: 'before', header: 'Before', align: 'right' },
                { key: 'after', header: 'After', align: 'right' },
                { key: 'change', header: 'Change', align: 'right' },
              ]
            ));
          }
          const sign = data.totalChange >= 0 ? '+' : '';
          console.log(`\nTotal: $${data.totalBefore.toFixed(2)} → $${data.totalAfter.toFixed(2)} (${sign}$${data.totalChange.toFixed(2)})`);
        }
      } catch (err: any) {
        output(failure('SNAPSHOT_COMPARE_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  snapshot
    .command('delete <id>')
    .description('Delete a snapshot')
    .action((idStr: string) => {
      try {
        const id = parseInt(idStr);
        const deleted = snapshotRepo.deleteSnapshot(id);
        if (!deleted) throw new Error(`Snapshot #${id} not found`);

        if (isJsonMode()) {
          output(success({ id, deleted: true }));
        } else {
          console.log(`Deleted snapshot #${id}`);
        }
      } catch (err: any) {
        output(failure('SNAPSHOT_DELETE_FAILED', err.message));
        process.exitCode = 1;
      }
    });
}
