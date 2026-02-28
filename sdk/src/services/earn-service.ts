import type { SolContext } from '../types.js';
import type {
  EarnProvider,
  EarnVault,
  EarnPosition,
  EarnWriteResult,
  EarnProtocolName,
} from './earn/earn-provider.js';
import { EARN_PROTOCOL_NAMES } from './earn/earn-provider.js';
import type { PriceService } from './price-service.js';

export type { EarnVault, EarnPosition, EarnWriteResult } from './earn/earn-provider.js';

export interface VaultsResult {
  vaults: EarnVault[];
  warnings: string[];
  bestApyVault: Record<string, string>;
}

export interface EarnService {
  getVaults(tokens?: string[], protocol?: string, sort?: 'apy' | 'tvl'): Promise<VaultsResult>;
  getPositions(walletAddress: string, protocol?: string): Promise<EarnPosition[]>;
  deposit(walletName: string, token: string, amount: number, protocol?: string, vaultId?: string): Promise<EarnWriteResult>;
  withdraw(walletName: string, token: string, amount: number, protocol?: string): Promise<EarnWriteResult>;
  registerProvider(provider: EarnProvider): void;
}

export function createEarnService(ctx: SolContext, deps: { price: PriceService }): EarnService {
  const { logger, signer } = ctx;
  const providers: EarnProvider[] = [];

  function getProvider(name: string): EarnProvider {
    const p = providers.find(p => p.name === name);
    if (!p) throw new Error(`Unknown protocol: ${name}. Available: ${providers.map(p => p.name).join(', ')}`);
    return p;
  }

  function resolveProtocol(protocol?: string): string | undefined {
    if (!protocol) return undefined;
    const normalized = protocol.toLowerCase();
    if (!EARN_PROTOCOL_NAMES.includes(normalized as EarnProtocolName)) {
      throw new Error(`Unknown protocol: ${protocol}. Available: ${EARN_PROTOCOL_NAMES.join(', ')}`);
    }
    return normalized;
  }

  async function getVaults(tokens?: string[], protocol?: string, sort: 'apy' | 'tvl' = 'apy'): Promise<VaultsResult> {
    const proto = resolveProtocol(protocol);
    const targets = proto ? [getProvider(proto)] : providers;
    const results = await Promise.allSettled(targets.map(p => p.getVaults(tokens)));

    const vaults: EarnVault[] = [];
    const warnings: string[] = [];

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'fulfilled') {
        vaults.push(...r.value);
      } else {
        const name = targets[i].name;
        logger.verbose(`${name} vaults failed: ${r.reason}`);
        warnings.push(`${name}: ${r.reason?.message || r.reason}`);
      }
    }

    // Enrich TVL USD
    const mints = [...new Set(vaults.filter(v => v.tvlUsd == null).map(v => v.mint))];
    if (mints.length > 0) {
      const prices = await deps.price.getPrices(mints);
      for (const v of vaults) {
        if (v.tvlUsd == null) {
          const price = prices.get(v.mint)?.priceUsd;
          if (price) v.tvlUsd = v.tvlToken * price;
        }
      }
    }

    const bestApyVault: Record<string, string> = {};
    const byToken = new Map<string, EarnVault[]>();
    for (const v of vaults) {
      const arr = byToken.get(v.token) ?? [];
      arr.push(v);
      byToken.set(v.token, arr);
    }
    for (const [token, tokenVaults] of byToken) {
      const best = tokenVaults.reduce((a, b) => b.apy > a.apy ? b : a);
      bestApyVault[token] = best.vaultId;
    }

    if (sort === 'tvl') {
      vaults.sort((a, b) => (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0));
    } else {
      vaults.sort((a, b) => b.apy - a.apy);
    }

    return { vaults, warnings, bestApyVault };
  }

  async function getPositions(walletAddress: string, protocol?: string): Promise<EarnPosition[]> {
    const proto = resolveProtocol(protocol);
    const targets = proto ? [getProvider(proto)] : providers;
    const results = await Promise.allSettled(targets.map(p => p.getPositions(walletAddress)));

    const positions: EarnPosition[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'fulfilled') {
        positions.push(...r.value);
      } else {
        logger.verbose(`${targets[i].name} earn positions failed: ${r.reason}`);
      }
    }

    return positions;
  }

  async function deposit(walletName: string, token: string, amount: number, protocol?: string, vaultId?: string): Promise<EarnWriteResult> {
    const proto = resolveProtocol(protocol);

    if (proto) {
      return getProvider(proto).deposit(walletName, token, amount, vaultId);
    }

    if (vaultId) {
      for (const p of providers) {
        try {
          return await p.deposit(walletName, token, amount, vaultId);
        } catch { continue; }
      }
      throw new Error(`Vault ${vaultId} not found on any provider`);
    }

    const { vaults } = await getVaults([token]);
    if (vaults.length === 0) throw new Error(`No earn vault found for ${token}`);

    const best = vaults.reduce((a, b) => b.apy > a.apy ? b : a);
    logger.verbose(`Auto-selected ${best.protocol} vault "${best.vaultName}" (APY: ${(best.apy * 100).toFixed(2)}%)`);
    return getProvider(best.protocol).deposit(walletName, token, amount, best.vaultId);
  }

  async function withdraw(walletName: string, token: string, amount: number, protocol?: string): Promise<EarnWriteResult> {
    const proto = resolveProtocol(protocol);

    if (proto) {
      return getProvider(proto).withdraw(walletName, token, amount);
    }

    const signerAddr = await signer.getAddress(walletName);
    const allPositions = await getPositions(signerAddr);
    const tokenUpper = token.toUpperCase();
    const deposits = allPositions.filter(p => p.token.toUpperCase() === tokenUpper);

    if (deposits.length === 0) {
      throw new Error(`No ${token} earn position found. Check with: sol earn positions`);
    }

    const protos = [...new Set(deposits.map(d => d.protocol))];
    if (protos.length === 1) {
      return getProvider(protos[0]).withdraw(walletName, token, amount);
    }

    throw new Error(
      `${token} positions found on multiple protocols: ${protos.join(', ')}. ` +
      `Specify one with --protocol, e.g.: sol earn withdraw ${amount} ${token} --protocol ${protos[0]}`
    );
  }

  function registerProvider(provider: EarnProvider): void {
    providers.push(provider);
  }

  return { getVaults, getPositions, deposit, withdraw, registerProvider };
}
