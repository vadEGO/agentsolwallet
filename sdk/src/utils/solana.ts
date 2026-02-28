const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isValidAddress(address: string): boolean {
  return BASE58_RE.test(address);
}

export function lamportsToSol(lamports: bigint | number): number {
  return Number(BigInt(lamports)) / 1e9;
}

export function solToLamports(sol: number): bigint {
  return BigInt(Math.round(sol * 1e9));
}

export function tokenAmountToUi(rawAmount: bigint | string, decimals: number): number {
  return Number(BigInt(rawAmount)) / Math.pow(10, decimals);
}

export function uiToTokenAmount(uiAmount: number, decimals: number): bigint {
  return BigInt(Math.round(uiAmount * Math.pow(10, decimals)));
}

export function shortenAddress(address: string, chars = 4): string {
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

export function explorerUrl(signature: string, type: 'tx' | 'address' = 'tx'): string {
  return `https://solscan.io/${type}/${signature}`;
}

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const SOL_DECIMALS = 9;
