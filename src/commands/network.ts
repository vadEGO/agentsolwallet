import { Command } from 'commander';
import { getRpc } from '../core/rpc.js';
import { AGENTSOLWALLET_VOTE } from '@agentsolwallet/sdk';
import { output, success, failure, isJsonMode, timed, verbose } from '../output/formatter.js';
import { withRetry, isRetryableHttpError } from '../utils/retry.js';

// Solana targets ~400ms per slot
const MS_PER_SLOT = 400;

interface NetworkStatus {
  epoch: number;
  epochProgress: number;
  epochStartSlot: number;
  epochEndSlot: number;
  epochEstimatedEnd: string;
  slotIndex: number;
  slotsInEpoch: number;
  absoluteSlot: number;
  tps: number | null;
  version: string | null;
  inflationTotal: number | null;
  inflationValidator: number | null;
  inflationFoundation: number | null;
  stakingApy: number | null;
  recommendedApy: number | null;
}

export function registerNetworkCommand(program: Command): void {
  program
    .command('network')
    .description('Show Solana network status, inflation, and staking APY')
    .action(async () => {
      try {
        const { result: data, elapsed_ms } = await timed(async () => {
          const rpc = getRpc();

          // Fire all RPC calls in parallel
          const [epochInfo, inflationRate, version, perfSamples] = await Promise.all([
            rpc.getEpochInfo().send(),
            rpc.getInflationRate().send().catch((err: unknown) => {
              verbose(`Failed to fetch inflation rate: ${err}`);
              return null;
            }),
            rpc.getVersion().send().catch((err: unknown) => {
              verbose(`Failed to fetch version: ${err}`);
              return null;
            }),
            rpc.getRecentPerformanceSamples(1 as unknown as undefined).send().catch((err: unknown) => {
              verbose(`Failed to fetch performance samples: ${err}`);
              return null;
            }),
          ]);

          // Calculate TPS from performance sample
          let tps: number | null = null;
          if (perfSamples && perfSamples.length > 0) {
            const sample = perfSamples[0];
            if (sample.samplePeriodSecs > 0) {
              tps = Math.round(Number(sample.numTransactions) / sample.samplePeriodSecs);
            }
          }

          // Fetch staking APY from StakeWiz (non-critical)
          let stakingApy: number | null = null;
          let recommendedApy: number | null = null;
          try {
            const [clusterApy, validatorApy] = await Promise.all([
              fetchStakingApy(),
              fetchValidatorApy(AGENTSOLWALLET_VOTE),
            ]);
            stakingApy = clusterApy;
            recommendedApy = validatorApy;
          } catch (err) {
            verbose(`StakeWiz API failed: ${err}`);
          }

          const slotIndex = Number(epochInfo.slotIndex);
          const slotsInEpoch = Number(epochInfo.slotsInEpoch);
          const absoluteSlot = Number(epochInfo.absoluteSlot);

          const epochProgress = slotsInEpoch > 0
            ? (slotIndex / slotsInEpoch) * 100
            : 0;

          const epochStartSlot = absoluteSlot - slotIndex;
          const epochEndSlot = epochStartSlot + slotsInEpoch - 1;
          const slotsRemaining = slotsInEpoch - slotIndex;
          const msRemaining = slotsRemaining * MS_PER_SLOT;
          const epochEstimatedEnd = new Date(Date.now() + msRemaining).toISOString();

          const status: NetworkStatus = {
            epoch: Number(epochInfo.epoch),
            epochProgress: Math.round(epochProgress * 10) / 10,
            epochStartSlot,
            epochEndSlot,
            epochEstimatedEnd,
            slotIndex,
            slotsInEpoch,
            absoluteSlot,
            tps,
            version: version ? version['solana-core'] : null,
            inflationTotal: inflationRate ? inflationRate.total * 100 : null,
            inflationValidator: inflationRate ? inflationRate.validator * 100 : null,
            inflationFoundation: inflationRate ? inflationRate.foundation * 100 : null,
            stakingApy,
            recommendedApy,
          };

          return status;
        });

        if (isJsonMode()) {
          output(success(data, { elapsed_ms }));
        } else {
          const endDate = new Date(data.epochEstimatedEnd);
          const endFormatted = endDate.toISOString().replace('T', ' ').slice(0, 19);
          const msLeft = endDate.getTime() - Date.now();
          const timeLeft = formatDuration(msLeft);

          console.log(`
Solana Network Status

Epoch        ${data.epoch} (${data.epochProgress}% complete, ${timeLeft} left)
Epoch slots  ${data.epochStartSlot} → ${data.epochEndSlot} (${data.slotsInEpoch} total)
Est. end     ${endFormatted}
Slot         ${data.absoluteSlot}
TPS          ${data.tps !== null ? `~${data.tps.toLocaleString()}` : 'unavailable'}
Version      ${data.version ?? 'unavailable'}
Inflation    ${data.inflationTotal !== null ? `${data.inflationTotal.toFixed(2)}%` : 'unavailable'}
Staking APY  ${data.stakingApy !== null ? `~${data.stakingApy.toFixed(2)}% (network average)` : 'unavailable'}${data.recommendedApy !== null ? `\nRecommended APY  ~${data.recommendedApy.toFixed(2)}% (incl. MEV)` : ''}
`);
        }
      } catch (err: any) {
        output(failure('NETWORK_FAILED', err.message));
        process.exitCode = 1;
      }
    });
}

async function fetchStakingApy(): Promise<number | null> {
  const res = await withRetry(
    () => fetch('https://api.stakewiz.com/cluster_stats', {
      signal: AbortSignal.timeout(5000),
    }),
    { maxRetries: 1, shouldRetry: isRetryableHttpError }
  );

  if (!res.ok) return null;

  const data = await res.json() as any;
  // StakeWiz returns avg_apy already as a percentage (e.g., 4.67 for 4.67%)
  if (typeof data?.avg_apy === 'number') {
    return data.avg_apy;
  }
  return null;
}

async function fetchValidatorApy(voteAccount: string): Promise<number | null> {
  const res = await withRetry(
    () => fetch(`https://api.stakewiz.com/validator/${voteAccount}`, {
      signal: AbortSignal.timeout(5000),
    }),
    { maxRetries: 1, shouldRetry: isRetryableHttpError }
  );

  if (!res.ok) return null;

  const data = await res.json() as any;
  // total_apy includes staking rewards + Jito MEV tips
  if (typeof data?.total_apy === 'number') {
    return data.total_apy;
  }
  return null;
}

function formatDuration(ms: number): string {
  if (ms <= 0) return '0m';
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
