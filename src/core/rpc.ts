import { createSolanaRpc, createSolanaRpcSubscriptions, type Rpc, type SolanaRpcApi } from '@solana/kit';
import { execSync } from 'node:child_process';
import { getConfigValue, setConfigValue } from './config-manager.js';
import { warn, verbose } from '../output/formatter.js';

let rpcOverride: string | undefined;
let cachedRpc: Rpc<SolanaRpcApi> | null = null;
let cachedUrl: string | null = null;

export function setRpcOverride(url: string): void {
  rpcOverride = url;
  cachedRpc = null;
  cachedUrl = null;
}

export function getRpcUrl(): string {
  if (cachedUrl) return cachedUrl;

  // 1. CLI flag override
  if (rpcOverride) {
    cachedUrl = rpcOverride;
    return cachedUrl;
  }

  // 2. Environment variable
  const envUrl = process.env.SOL_RPC_URL;
  if (envUrl) {
    verbose('Using RPC from SOL_RPC_URL env var');
    cachedUrl = envUrl;
    return cachedUrl;
  }

  // 3. Config file
  const configUrl = getConfigValue('rpc.url') as string | undefined;
  if (configUrl) {
    verbose('Using RPC from config.toml');
    cachedUrl = configUrl;
    return cachedUrl;
  }

  // 4. Auto-detect from Solana CLI
  try {
    const output = execSync('solana config get', { timeout: 3000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    const match = output.match(/RPC URL:\s*(https?:\/\/\S+)/);
    if (match) {
      verbose(`Using RPC from Solana CLI config: ${match[1]}`);
      cachedUrl = match[1];
      // Persist so future runs don't need to shell out
      try { setConfigValue('rpc.url', cachedUrl); } catch { /* non-critical */ }
      return cachedUrl;
    }
  } catch {
    // solana CLI not installed or config not found — continue
  }

  // 5. Fallback
  warn('Using public RPC (slow, rate-limited). Set a better one:\n  sol config set rpc.url https://your-rpc.com\n  Free options: https://www.helius.dev (1M credits free)');
  cachedUrl = 'https://api.mainnet-beta.solana.com';
  return cachedUrl;
}

export function getRpc(): Rpc<SolanaRpcApi> {
  if (cachedRpc) return cachedRpc;
  const url = getRpcUrl();
  cachedRpc = createSolanaRpc(url);
  return cachedRpc;
}

export function resetRpcCache(): void {
  cachedRpc = null;
  cachedUrl = null;
}
