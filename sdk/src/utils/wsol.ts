import { type Address, type Instruction, address, type TransactionSigner } from '@solana/kit';
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getSyncNativeInstruction,
  getCloseAccountInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { getTransferSolInstruction } from '@solana-program/system';
import { SOL_MINT } from './solana.js';

const SOL_MINT_ADDRESS = address(SOL_MINT);

export function isNativeSol(mint: string): boolean {
  return mint === SOL_MINT;
}

/**
 * Creates ATA (idempotent), transfers lamports, calls syncNative for each wrap entry.
 * Pass only mints that are SOL_MINT — others are silently skipped.
 */
export async function buildWrapSolInstructions(
  signer: TransactionSigner,
  wraps: { mint: string; lamports: bigint }[],
): Promise<Instruction[]> {
  const ixs: Instruction[] = [];

  for (const { mint, lamports } of wraps) {
    if (!isNativeSol(mint) || lamports <= 0n) continue;

    const [ata] = await findAssociatedTokenPda({
      owner: address(signer.address),
      mint: SOL_MINT_ADDRESS,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

    // Ensure ATA exists
    ixs.push(await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: signer as unknown as Address & TransactionSigner,
      ata,
      owner: address(signer.address),
      mint: SOL_MINT_ADDRESS,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    }) as unknown as Instruction);

    // Transfer native SOL to the WSOL ATA
    ixs.push(getTransferSolInstruction({
      source: signer,
      destination: ata,
      amount: lamports,
    }) as unknown as Instruction);

    // Sync the token account to reflect the deposited lamports
    ixs.push(getSyncNativeInstruction({
      account: ata,
    }) as unknown as Instruction);
  }

  return ixs;
}

/**
 * Closes WSOL ATA → returns rent + balance as native SOL.
 * Pass any mints — non-SOL mints are silently skipped.
 */
export async function buildUnwrapSolInstructions(
  signer: TransactionSigner,
  mints: string[],
): Promise<Instruction[]> {
  const ixs: Instruction[] = [];
  let added = false;

  for (const mint of mints) {
    if (!isNativeSol(mint)) continue;
    if (added) continue; // Only need to close the ATA once

    const [ata] = await findAssociatedTokenPda({
      owner: address(signer.address),
      mint: SOL_MINT_ADDRESS,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

    ixs.push(getCloseAccountInstruction({
      account: ata,
      destination: address(signer.address),
      owner: signer,
    }) as unknown as Instruction);

    added = true;
  }

  return ixs;
}

/**
 * Idempotent ATA creation for one or more mints.
 */
export async function buildEnsureAtaInstructions(
  owner: Address,
  mints: string[],
): Promise<Instruction[]> {
  const ixs: Instruction[] = [];
  const seen = new Set<string>();

  for (const mint of mints) {
    if (seen.has(mint)) continue;
    seen.add(mint);

    const [ata] = await findAssociatedTokenPda({
      owner,
      mint: address(mint),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

    ixs.push(await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: owner as any,
      ata,
      owner,
      mint: address(mint),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    }) as unknown as Instruction);
  }

  return ixs;
}
