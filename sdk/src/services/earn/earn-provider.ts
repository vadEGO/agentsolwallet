export interface EarnVault {
  protocol: string;
  vaultId: string;
  vaultName: string;
  token: string;
  mint: string;
  apy: number;
  tvlToken: number;
  tvlUsd: number | null;
  depositsEnabled: boolean;
}

export interface EarnPosition {
  protocol: string;
  vaultId: string;
  vaultName: string;
  token: string;
  mint: string;
  depositedAmount: number;
  valueUsd: number | null;
  apy: number;
  shares?: number;
}

export interface EarnWriteResult {
  signature: string;
  protocol: string;
  explorerUrl: string;
}

export interface EarnProvider {
  name: string;
  getVaults(tokens?: string[]): Promise<EarnVault[]>;
  getPositions(walletAddress: string): Promise<EarnPosition[]>;
  deposit(walletName: string, token: string, amount: number, vaultId?: string): Promise<EarnWriteResult>;
  withdraw(walletName: string, token: string, amount: number): Promise<EarnWriteResult>;
}

export const EARN_PROTOCOL_NAMES = ['kamino', 'loopscale'] as const;
export type EarnProtocolName = typeof EARN_PROTOCOL_NAMES[number];
