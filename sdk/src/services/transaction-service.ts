import {
  getSignatureFromTransaction,
  signTransactionMessageWithSigners,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  compressTransactionMessageUsingAddressLookupTables,
  fetchAddressesForLookupTables,
  type TransactionSigner,
  type Instruction,
  type Rpc,
  type SolanaRpcApi,
  type Address,
} from '@solana/kit';
import { getBase64EncodedWireTransaction } from '@solana/transactions';
import type { SolContext, SendResult } from '../types.js';
import { explorerUrl } from '../utils/solana.js';

// ── Error classification ────────────────────────────────────

export enum ErrorClass {
  RETRYABLE_TRANSIENT = 'RETRYABLE_TRANSIENT',
  RETRYABLE_EXPIRED = 'RETRYABLE_EXPIRED',
  RETRYABLE_STALE_QUOTE = 'RETRYABLE_STALE_QUOTE',
  TERMINAL_PROGRAM = 'TERMINAL_PROGRAM',
  TERMINAL_SIMULATION = 'TERMINAL_SIMULATION',
  TERMINAL_UNKNOWN = 'TERMINAL_UNKNOWN',
}

export function classifyError(err: unknown): ErrorClass {
  const msg = err instanceof Error ? err.message : String(err);

  if (msg.includes('BlockheightExceeded') || msg.includes('blockhash') || msg.includes('Blockhash not found')) {
    return ErrorClass.RETRYABLE_EXPIRED;
  }
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('Too many requests')) {
    return ErrorClass.RETRYABLE_TRANSIENT;
  }
  if (msg.includes('5') && (msg.includes('Internal') || msg.includes('server'))) {
    return ErrorClass.RETRYABLE_TRANSIENT;
  }
  if (msg.includes('timeout') || msg.includes('ECONNRESET') || msg.includes('ENOTFOUND')) {
    return ErrorClass.RETRYABLE_TRANSIENT;
  }
  if (msg.includes('-32005')) {
    return ErrorClass.RETRYABLE_TRANSIENT;
  }
  if (msg.includes('insufficient') || msg.includes('Insufficient')) {
    return ErrorClass.TERMINAL_PROGRAM;
  }
  if (msg.includes('simulation failed') || msg.includes('SimulationFailed')) {
    return ErrorClass.TERMINAL_SIMULATION;
  }
  if (msg.includes('Program error') || msg.includes('custom program error')) {
    return ErrorClass.TERMINAL_PROGRAM;
  }

  return ErrorClass.TERMINAL_UNKNOWN;
}

// ── Signer injection ────────────────────────────────────────

/**
 * Inject TransactionSigner references into instruction accounts that match known signers.
 * v1→v2 instruction conversions only produce role bits (2=READONLY_SIGNER, 3=WRITABLE_SIGNER)
 * without actual signer objects. signTransactionMessageWithSigners requires IAccountSignerMeta
 * entries to find signers, so we inject them here.
 */
export function injectSigners(
  instructions: Instruction[],
  signers: TransactionSigner[],
): Instruction[] {
  const signerMap = new Map(signers.map(s => [s.address, s]));
  return instructions.map(ix => ({
    ...ix,
    accounts: (ix.accounts ?? []).map((acc: any) => {
      const signer = signerMap.get(acc.address);
      if (!signer || acc.signer) return acc;
      // Already has signer role — just attach signer object
      if (acc.role === 2 || acc.role === 3) return { ...acc, signer };
      // v1 SDKs may not set isSigner on instruction accounts, relying on
      // transaction-level signing. Upgrade the role when address matches.
      if (acc.role === 0) return { ...acc, role: 2, signer }; // READONLY → READONLY_SIGNER
      if (acc.role === 1) return { ...acc, role: 3, signer }; // WRITABLE → WRITABLE_SIGNER
      return acc;
    }),
  }));
}

// ── Transaction service factory ─────────────────────────────

export interface TransactionService {
  buildAndSendTransaction(
    instructions: Instruction[],
    payer: TransactionSigner,
    opts?: BuildAndSendOpts,
  ): Promise<SendResult>;

  sendEncodedTransaction(
    encodedTx: string,
    opts?: SendEncodedOpts,
  ): Promise<SendResult>;
}

export interface BuildAndSendOpts {
  maxRetries?: number;
  skipPreflight?: boolean;
  txType?: string;
  walletName?: string;
  fromMint?: string;
  toMint?: string;
  fromAmount?: string;
  toAmount?: string;
  fromPriceUsd?: number;
  toPriceUsd?: number;
  /** Address lookup table addresses to compress the transaction with */
  addressLookupTableAddresses?: Address[];
}

export interface SendEncodedOpts {
  skipPreflight?: boolean;
  txType?: string;
  walletName?: string;
  fromMint?: string;
  toMint?: string;
  fromAmount?: string;
  toAmount?: string;
  fromPriceUsd?: number;
  toPriceUsd?: number;
}

export function createTransactionService(ctx: SolContext): TransactionService {
  const { rpc, logger, txLogger } = ctx;

  async function buildAndSendTransaction(
    instructions: Instruction[],
    payer: TransactionSigner,
    opts: BuildAndSendOpts = {},
  ): Promise<SendResult> {
    const maxRetries = opts.maxRetries ?? 3;
    const start = performance.now();
    let attempts = 0;
    let lastSignature: string | undefined;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      attempts++;
      try {
        const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

        // Optionally append analytics instruction
        const allInstructions = [...instructions];
        const analyticsIx = ctx.analyticsInstruction?.();
        if (analyticsIx) allInstructions.push(analyticsIx);

        let message = pipe(
          createTransactionMessage({ version: 0 }),
          m => setTransactionMessageFeePayer(payer.address, m),
          m => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
          m => appendTransactionMessageInstructions(injectSigners(allInstructions, [payer]), m),
        );

        // Compress using address lookup tables if provided
        if (opts.addressLookupTableAddresses?.length) {
          const addressesByLookupTable = await fetchAddressesForLookupTables(
            opts.addressLookupTableAddresses,
            rpc as any,
          );
          message = compressTransactionMessageUsingAddressLookupTables(
            message,
            addressesByLookupTable,
          ) as typeof message;
        }

        const signedTx = await signTransactionMessageWithSigners(message);
        const signature = getSignatureFromTransaction(signedTx);
        lastSignature = signature;
        const encodedTx = getBase64EncodedWireTransaction(signedTx);

        // Log as pending before sending
        txLogger.log({
          signature,
          type: opts.txType ?? 'unknown',
          walletName: opts.walletName,
          fromMint: opts.fromMint,
          toMint: opts.toMint,
          fromAmount: opts.fromAmount,
          toAmount: opts.toAmount,
          fromPriceUsd: opts.fromPriceUsd,
          toPriceUsd: opts.toPriceUsd,
          status: 'sending',
        });

        await rpc.sendTransaction(encodedTx, {
          skipPreflight: opts.skipPreflight ?? false,
          encoding: 'base64',
        }).send();

        logger.verbose(`Transaction sent: ${signature}, waiting for confirmation...`);
        txLogger.updateStatus(signature, 'sent');

        // Poll for confirmation
        await pollConfirmation(rpc, signature, 30_000, logger);

        const elapsed_ms = Math.round(performance.now() - start);
        txLogger.updateStatus(signature, 'confirmed');

        return {
          signature,
          status: 'confirmed',
          attempts,
          elapsed_ms,
          explorerUrl: explorerUrl(signature),
        };
      } catch (err) {
        const errorClass = classifyError(err);
        logger.verbose(`Transaction attempt ${attempt + 1} failed: ${errorClass} — ${err}`);

        // Extract and log simulation logs from SolanaError context
        const errCtx = (err as any)?.context;
        if (errCtx?.logs?.length) {
          logger.verbose('Transaction logs:');
          for (const log of errCtx.logs) logger.verbose(`  ${log}`);
        }

        if (lastSignature) {
          txLogger.updateStatus(lastSignature, 'failed', String(err));
        }

        if (errorClass === ErrorClass.RETRYABLE_EXPIRED || errorClass === ErrorClass.RETRYABLE_TRANSIENT) {
          if (attempt < maxRetries - 1) continue;
        }
        throw err;
      }
    }

    throw new Error('Max transaction retries exceeded');
  }

  async function sendEncodedTransaction(
    encodedTx: string,
    opts: SendEncodedOpts = {},
  ): Promise<SendResult> {
    const start = performance.now();

    const signature = await rpc.sendTransaction(encodedTx as any, {
      skipPreflight: opts.skipPreflight ?? false,
      encoding: 'base64',
    }).send().catch(err => {
      logger.verbose(`sendTransaction failed: ${err}`);
      const errCtx = (err as any)?.context;
      if (errCtx?.logs?.length) {
        logger.verbose('Transaction logs:');
        for (const log of errCtx.logs) logger.verbose(`  ${log}`);
      }
      if (errCtx?.error) {
        logger.verbose(`Context error: ${JSON.stringify(errCtx.error)}`);
      }
      throw err;
    });

    const sigStr = String(signature);

    txLogger.log({
      signature: sigStr,
      type: opts.txType ?? 'unknown',
      walletName: opts.walletName,
      fromMint: opts.fromMint,
      toMint: opts.toMint,
      fromAmount: opts.fromAmount,
      toAmount: opts.toAmount,
      fromPriceUsd: opts.fromPriceUsd,
      toPriceUsd: opts.toPriceUsd,
      status: 'sent',
    });

    logger.verbose(`Transaction sent: ${sigStr}, waiting for confirmation...`);

    try {
      await pollConfirmation(rpc, sigStr, 30_000, logger);
      txLogger.updateStatus(sigStr, 'confirmed');
    } catch (err) {
      txLogger.updateStatus(sigStr, 'failed', String(err));
      throw err;
    }

    const elapsed_ms = Math.round(performance.now() - start);

    return {
      signature: sigStr,
      status: 'confirmed',
      attempts: 1,
      elapsed_ms,
      explorerUrl: explorerUrl(sigStr),
    };
  }

  return { buildAndSendTransaction, sendEncodedTransaction };
}

// ── Confirmation polling ───────────────────────────────────

async function pollConfirmation(
  rpc: Rpc<SolanaRpcApi>,
  signature: string,
  timeoutMs: number,
  logger: { verbose(msg: string): void },
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await rpc.getSignatureStatuses([signature as any]).send();
      const status = result.value[0];
      if (status) {
        if (status.err) throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.err)}`);
        if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
          return;
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('Transaction failed')) {
        throw err;
      }
      logger.verbose(`Polling error (will retry): ${err}`);
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('Transaction confirmation timeout');
}
