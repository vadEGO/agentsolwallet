// ── Shared types ─────────────────────────────────────────

export interface EarnVault {
  protocol: string;
  vaultId: string;         // on-chain vault address
  vaultName: string;       // "Gauntlet USDC", "Loopscale SOL Vault"
  token: string;           // symbol
  mint: string;            // mint address
  apy: number;             // decimal (0.08 = 8%)
  tvlToken: number;        // total deposited in token units
  tvlUsd: number | null;   // enriched by service layer
  depositsEnabled: boolean;
}

export interface EarnPosition {
  protocol: string;
  vaultId: string;
  vaultName: string;
  token: string;
  mint: string;
  depositedAmount: number; // in token units
  valueUsd: number | null;
  apy: number;
  shares?: number;         // share token balance (Kamino)
}

export interface EarnWriteResult {
  signature: string;
  protocol: string;
  explorerUrl: string;
}

// ── Provider interface ───────────────────────────────────

export interface EarnProvider {
  name: string;

  /** List available vaults, optionally filtered by token symbols. */
  getVaults(tokens?: string[]): Promise<EarnVault[]>;

  /** Fetch user's vault positions. */
  getPositions(walletAddress: string): Promise<EarnPosition[]>;

  /** Deposit into a vault. */
  deposit(walletName: string, token: string, amount: number, vaultId?: string): Promise<EarnWriteResult>;

  /** Withdraw from a vault. */
  withdraw(walletName: string, token: string, amount: number): Promise<EarnWriteResult>;
}

/** Canonical earn protocol names. */
export const EARN_PROTOCOL_NAMES = ['kamino', 'loopscale'] as const;
export type EarnProtocolName = typeof EARN_PROTOCOL_NAMES[number];
