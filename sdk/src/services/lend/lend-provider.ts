// ── Shared types ─────────────────────────────────────────

export interface LendingRate {
  protocol: string;
  token: string;
  mint: string;
  depositApy: number;
  borrowApy: number;
  totalDeposited: number;
  totalBorrowed: number;
  utilizationPct: number;
}

export interface LendingPosition {
  protocol: string;
  token: string;
  mint: string;
  type: 'deposit' | 'borrow';
  amount: number;
  valueUsd: number;
  apy: number;
  healthFactor?: number;
}

export interface LendWriteResult {
  signature: string;
  protocol: string;
  explorerUrl: string;
  healthFactor?: number;
  remainingDebt?: number;
}

export interface LendProviderCapabilities {
  deposit: boolean;
  withdraw: boolean;
  borrow: boolean;
  repay: boolean;
}

// ── Provider interface ───────────────────────────────────

export interface LendProvider {
  name: string;
  capabilities: LendProviderCapabilities;

  getRates(tokens?: string[]): Promise<LendingRate[]>;
  getPositions(walletAddress: string): Promise<LendingPosition[]>;
  deposit(walletName: string, token: string, amount: number): Promise<LendWriteResult>;
  withdraw(walletName: string, token: string, amount: number): Promise<LendWriteResult>;
  borrow?(walletName: string, token: string, amount: number, collateral: string): Promise<LendWriteResult>;
  repay?(walletName: string, token: string, amount: number): Promise<LendWriteResult>;
}

export const PROTOCOL_NAMES = ['kamino', 'marginfi', 'drift', 'jup-lend', 'loopscale'] as const;
export type ProtocolName = typeof PROTOCOL_NAMES[number];
