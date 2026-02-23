import { getRpc } from './rpc.js';
import { loadSigner } from './wallet-manager.js';
import { address } from '@solana/kit';
import { verbose } from '../output/formatter.js';
import { lamportsToSol, solToLamports } from '../utils/solana.js';

// Solana Compass validator — default recommendation
export const SOLANA_COMPASS_VOTE = 'CompaaS7TZTneMbSRBL3YQzsTn45MfBTqGM3MxjGz45A';

export interface StakeAccountInfo {
  address: string;
  lamports: number;
  solBalance: number;
  status: string;
  validator?: string;
  activationEpoch?: number;
  deactivationEpoch?: number;
}

export async function getStakeAccounts(walletAddress: string): Promise<StakeAccountInfo[]> {
  const rpc = getRpc();
  verbose(`Fetching stake accounts for ${walletAddress}`);

  try {
    const accounts = await rpc.getProgramAccounts(
      address('Stake11111111111111111111111111111111111111'),
      {
        filters: [
          { memcmp: { offset: BigInt(12), bytes: walletAddress as any, encoding: 'base58' } },
        ],
        encoding: 'jsonParsed',
      }
    ).send();

    return accounts.map((acc: any) => {
      const parsed = acc.account.data?.parsed?.info;
      const meta = parsed?.meta;
      const stake = parsed?.stake;
      const lamportVal = Number(acc.account.lamports);

      return {
        address: acc.pubkey,
        lamports: lamportVal,
        solBalance: lamportsToSol(lamportVal),
        status: parsed?.type || 'unknown',
        validator: stake?.delegation?.voter,
        activationEpoch: stake?.delegation?.activationEpoch ? Number(stake.delegation.activationEpoch) : undefined,
        deactivationEpoch: stake?.delegation?.deactivationEpoch ? Number(stake.delegation.deactivationEpoch) : undefined,
      };
    });
  } catch (err) {
    verbose(`Failed to fetch stake accounts: ${err}`);
    return [];
  }
}
