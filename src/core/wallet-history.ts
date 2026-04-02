import { address } from '@solana/kit';
import { getRpc } from './rpc.js';
import * as walletRepo from '../db/repos/wallet-repo.js';
import * as txRepo from '../db/repos/transaction-repo.js';
import { SOL_MINT } from '../utils/solana.js';

interface ChainSignatureInfo {
  signature: string;
  blockTime: number | null;
  err: unknown | null;
}

interface ParsedTransfer {
  source?: string;
  destination?: string;
  lamports?: number;
}

export async function syncRecentTransactions(walletName: string, limit = 20): Promise<{ synced: number; fetched: number }> {
  const wallet = walletRepo.getWallet(walletName);
  if (!wallet) throw new Error(`Wallet "${walletName}" not found`);

  const rpc = getRpc();
  const signatures = await rpc.getSignaturesForAddress(address(wallet.address), { limit }).send() as readonly ChainSignatureInfo[];

  let synced = 0;
  for (const item of signatures) {
    const existing = txRepo.getTransactionBySignature(item.signature);
    const tx = await rpc.getTransaction(item.signature as any, {
      encoding: 'jsonParsed',
      maxSupportedTransactionVersion: 0,
    }).send() as any;

    if (!tx) continue;

    const summary = summarizeTransaction(tx, wallet.address);
    txRepo.upsertTransaction({
      signature: item.signature,
      type: summary.type,
      wallet_name: existing?.wallet_name ?? walletName,
      from_mint: existing?.from_mint ?? summary.fromMint ?? null,
      to_mint: existing?.to_mint ?? summary.toMint ?? null,
      from_amount: existing?.from_amount ?? summary.fromAmount ?? null,
      to_amount: existing?.to_amount ?? summary.toAmount ?? null,
      from_price_usd: existing?.from_price_usd ?? null,
      to_price_usd: existing?.to_price_usd ?? null,
      status: item.err ? 'failed' : 'confirmed',
      error: item.err ? JSON.stringify(item.err) : null,
      created_at: toSqliteDate(item.blockTime),
    });
    synced++;
  }

  return { synced, fetched: signatures.length };
}

function summarizeTransaction(tx: any, walletAddress: string): {
  type: string;
  fromMint?: string;
  toMint?: string;
  fromAmount?: string;
  toAmount?: string;
} {
  const instructions = tx?.transaction?.message?.instructions ?? [];

  for (const ix of instructions) {
    const parsed = ix?.parsed;
    if (ix?.program === 'system' && parsed?.type === 'transfer') {
      const info = parsed.info as ParsedTransfer;
      const amount = String(info.lamports ?? '');
      if (info.destination === walletAddress) {
        return {
          type: 'transfer',
          toMint: SOL_MINT,
          toAmount: amount,
        };
      }
      if (info.source === walletAddress) {
        return {
          type: 'transfer',
          fromMint: SOL_MINT,
          fromAmount: amount,
        };
      }
      return {
        type: 'transfer',
        fromMint: SOL_MINT,
        toMint: SOL_MINT,
        fromAmount: amount,
        toAmount: amount,
      };
    }
  }

  const preTokenBalances = tx?.meta?.preTokenBalances ?? [];
  const postTokenBalances = tx?.meta?.postTokenBalances ?? [];
  if (preTokenBalances.length || postTokenBalances.length) {
    return { type: 'token' };
  }

  return { type: 'unknown' };
}

function toSqliteDate(blockTime: number | bigint | null | undefined): string {
  if (blockTime == null) return new Date().toISOString().replace('T', ' ').slice(0, 19);
  return new Date(Number(blockTime) * 1000).toISOString().replace('T', ' ').slice(0, 19);
}
