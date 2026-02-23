import { Command } from 'commander';
import { getRpc } from '../core/rpc.js';
import { output, success, failure, isJsonMode, timed, verbose } from '../output/formatter.js';
import { explorerUrl, isValidAddress, lamportsToSol } from '../utils/solana.js';
import { getTransactionBySignature } from '../db/repos/transaction-repo.js';

interface TxInfo {
  signature: string;
  // On-chain data
  slot: number | null;
  blockTime: number | null;
  blockTimeFormatted: string | null;
  fee: number | null;
  status: string;
  err: unknown | null;
  // Instruction summary
  programIds: string[];
  instructionCount: number;
  // Local context (from our transaction_log)
  localContext: {
    type: string;
    walletName: string | null;
    fromMint: string | null;
    toMint: string | null;
    fromAmount: string | null;
    toAmount: string | null;
    recordedAt: string;
  } | null;
  explorerUrl: string;
}

export function registerTxCommand(program: Command): void {
  program
    .command('tx <signature>')
    .description('Look up a transaction by signature')
    .action(async (signature: string) => {
      try {
        const { result: data, elapsed_ms } = await timed(async () => {
          // 1. Check local SQLite for context
          let localContext: TxInfo['localContext'] = null;
          try {
            const localTx = getTransactionBySignature(signature);
            if (localTx) {
              localContext = {
                type: localTx.type,
                walletName: localTx.wallet_name,
                fromMint: localTx.from_mint,
                toMint: localTx.to_mint,
                fromAmount: localTx.from_amount,
                toAmount: localTx.to_amount,
                recordedAt: localTx.created_at,
              };
            }
          } catch {
            verbose('Could not check local transaction log');
          }

          // 2. Fetch on-chain data
          const rpc = getRpc();
          const txResult = await rpc.getTransaction(signature as any, {
            encoding: 'jsonParsed',
            maxSupportedTransactionVersion: 0,
          }).send();

          if (!txResult) {
            if (localContext) {
              // We have local data but transaction not found on-chain (maybe too old)
              return {
                signature,
                slot: null,
                blockTime: null,
                blockTimeFormatted: null,
                fee: null,
                status: 'not found on-chain',
                err: null,
                programIds: [],
                instructionCount: 0,
                localContext,
                explorerUrl: explorerUrl(signature),
              } satisfies TxInfo;
            }
            throw new Error('Transaction not found');
          }

          // Parse on-chain data
          const meta = txResult.meta;
          const fee = meta?.fee != null ? lamportsToSol(meta.fee) : null;
          const err = meta?.err ?? null;
          const status = err ? 'failed' : 'confirmed';

          const blockTime = txResult.blockTime != null ? Number(txResult.blockTime) : null;
          const blockTimeFormatted = blockTime
            ? new Date(blockTime * 1000).toISOString()
            : null;

          // Extract program IDs and instruction count
          const message = (txResult.transaction as any)?.message;
          const instructions = message?.instructions ?? [];
          const programIds = [...new Set(
            instructions.map((ix: any) => ix.programId ?? ix.program ?? '').filter(Boolean)
          )] as string[];

          const innerCount = (meta?.innerInstructions ?? []).reduce(
            (sum: number, inner: any) => sum + (inner.instructions?.length ?? 0), 0
          );

          return {
            signature,
            slot: txResult.slot != null ? Number(txResult.slot) : null,
            blockTime,
            blockTimeFormatted,
            fee,
            status,
            err,
            programIds,
            instructionCount: instructions.length + innerCount,
            localContext,
            explorerUrl: explorerUrl(signature),
          } satisfies TxInfo;
        });

        if (isJsonMode()) {
          output(success(data, { elapsed_ms }));
        } else {
          console.log(`\nTransaction: ${data.signature}`);
          console.log('');
          if (data.status === 'not found on-chain') {
            console.log('  Status:      not found on-chain (may have expired from ledger)');
          } else {
            console.log(`  Status:      ${data.status}`);
            if (data.slot !== null) console.log(`  Slot:        ${data.slot.toLocaleString()}`);
            if (data.blockTimeFormatted) console.log(`  Time:        ${data.blockTimeFormatted}`);
            if (data.fee !== null) console.log(`  Fee:         ${data.fee} SOL`);
            if (data.instructionCount > 0) console.log(`  Instructions: ${data.instructionCount}`);
            if (data.programIds.length > 0) console.log(`  Programs:    ${data.programIds.join(', ')}`);
            if (data.err) console.log(`  Error:       ${JSON.stringify(data.err)}`);
          }

          if (data.localContext) {
            console.log('');
            console.log('  Local Context:');
            console.log(`    Type:      ${data.localContext.type}`);
            if (data.localContext.walletName) console.log(`    Wallet:    ${data.localContext.walletName}`);
            if (data.localContext.fromAmount) console.log(`    From:      ${data.localContext.fromAmount} (${data.localContext.fromMint})`);
            if (data.localContext.toAmount) console.log(`    To:        ${data.localContext.toAmount} (${data.localContext.toMint})`);
            console.log(`    Recorded:  ${data.localContext.recordedAt}`);
          }

          console.log('');
          console.log(`  Explorer:    ${data.explorerUrl}`);
          console.log('');
        }
      } catch (err: any) {
        output(failure('TX_LOOKUP_FAILED', err.message));
        process.exitCode = 1;
      }
    });
}
