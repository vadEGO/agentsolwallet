import { createSolSdk, registerDefaultProviders, createNoopInstruction, type SolSdk } from '@solana-compass/sdk';
import { getRpc, getRpcUrl } from './core/rpc.js';
import { CliLogger } from './adapters/cli-logger.js';
import { TomlConfig } from './adapters/toml-config.js';
import { SqliteCache } from './adapters/sqlite-cache.js';
import { SqliteTxLogger } from './adapters/sqlite-tx-logger.js';
import { FileSigner } from './adapters/file-signer.js';

let sdk: SolSdk | null = null;
let providersRegistered = false;

export function getSdk(): SolSdk {
  if (!sdk) {
    sdk = createSolSdk({
      rpc: getRpc(),
      rpcUrl: getRpcUrl(),
      logger: new CliLogger(),
      config: new TomlConfig(),
      cache: new SqliteCache(),
      txLogger: new SqliteTxLogger(),
      signer: new FileSigner(),
      analyticsInstruction: () => createNoopInstruction(),
    });
  }
  return sdk;
}

/** Ensure providers (lend, earn, predict) are registered. Idempotent. */
export async function ensureProviders(): Promise<SolSdk> {
  const s = getSdk();
  if (!providersRegistered) {
    providersRegistered = true;
    await registerDefaultProviders(s);
  }
  return s;
}

/** Reset cached SDK instance (e.g. when RPC override changes). */
export function resetSdk(): void {
  sdk = null;
  providersRegistered = false;
}
