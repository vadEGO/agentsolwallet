import { verbose } from '../output/formatter.js';

// Lending protocol integration — stub for Phase 9
// Will integrate @jup-ag/lend and @kamino-finance/klend-sdk

export interface LendingRate {
  protocol: string;
  token: string;
  depositApy: number;
  borrowApy: number;
}

export interface LendingPosition {
  protocol: string;
  token: string;
  type: 'deposit' | 'borrow';
  amount: number;
  valueUsd: number;
  apy: number;
}

export async function getRates(token: string): Promise<LendingRate[]> {
  verbose(`Fetching lending rates for ${token}`);

  // TODO: Implement with @jup-ag/lend and @kamino-finance/klend-sdk
  // For now, return empty — will be populated in Phase 9
  return [];
}

export async function getPositions(walletAddress: string): Promise<LendingPosition[]> {
  verbose(`Fetching lending positions for ${walletAddress}`);

  // TODO: Implement in Phase 9
  return [];
}

export async function deposit(
  walletName: string,
  token: string,
  amount: number,
  protocol?: string
): Promise<{ signature: string; protocol: string }> {
  throw new Error('Lending deposit not yet implemented. Coming in Phase 9.');
}

export async function withdraw(
  walletName: string,
  token: string,
  amount: number
): Promise<{ signature: string }> {
  throw new Error('Lending withdraw not yet implemented. Coming in Phase 9.');
}

export async function borrow(
  walletName: string,
  token: string,
  amount: number,
  collateralToken: string
): Promise<{ signature: string }> {
  throw new Error('Lending borrow not yet implemented. Coming in Phase 9.');
}

export async function repay(
  walletName: string,
  token: string,
  amount: number
): Promise<{ signature: string }> {
  throw new Error('Lending repay not yet implemented. Coming in Phase 9.');
}
