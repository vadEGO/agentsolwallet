import type { SolContext } from '../types.js';
import type {
  LpProvider,
  LpPoolInfo,
  LpPositionInfo,
  LpDepositParams,
  LpDepositQuote,
  LpWithdrawParams,
  LpWriteResult,
  LpFarmInfo,
  LpFarmResult,
  CreatePoolParams,
  LpProtocolName,
  PoolType,
  PoolConfig,
} from './lp/lp-provider.js';
import { LP_PROTOCOL_NAMES } from './lp/lp-provider.js';
import type { PriceService } from './price-service.js';

export type {
  LpPoolInfo, LpPositionInfo, LpDepositParams, LpDepositQuote,
  LpWithdrawParams, LpWriteResult, LpFarmInfo, LpFarmResult,
  CreatePoolParams, PoolConfig,
} from './lp/lp-provider.js';

// ── Service types ───────────────────────────────────────

export interface PoolsResult {
  pools: LpPoolInfo[];
  warnings: string[];
}

export interface LpService {
  getConfigs(protocol?: string, poolType?: PoolType): Promise<PoolConfig[]>;
  getPools(tokenA?: string, tokenB?: string, opts?: {
    protocol?: string; sort?: 'tvl' | 'apy' | 'volume';
    limit?: number; poolType?: PoolType;
  }): Promise<PoolsResult>;
  getPositions(walletAddress: string, protocol?: string): Promise<LpPositionInfo[]>;
  getDepositQuote(walletName: string, params: LpDepositParams, protocol?: string): Promise<LpDepositQuote>;
  deposit(walletName: string, params: LpDepositParams, protocol?: string): Promise<LpWriteResult>;
  withdraw(walletName: string, params: LpWithdrawParams, protocol?: string): Promise<LpWriteResult>;
  claimFees(walletName: string, positionId: string, protocol?: string): Promise<LpWriteResult>;
  createPool(walletName: string, params: CreatePoolParams, protocol: string): Promise<LpWriteResult>;
  getFarms(walletAddress: string, protocol?: string): Promise<LpFarmInfo[]>;
  farmStake(walletName: string, positionId: string, farmId: string, protocol?: string): Promise<LpFarmResult>;
  farmUnstake(walletName: string, positionId: string, farmId: string, protocol?: string): Promise<LpFarmResult>;
  farmHarvest(walletName: string, farmId: string, protocol?: string): Promise<LpFarmResult>;
  registerProvider(provider: LpProvider): void;
}

// ── Factory ─────────────────────────────────────────────

export function createLpService(ctx: SolContext, deps: { price: PriceService }): LpService {
  const { logger } = ctx;
  const providers: LpProvider[] = [];

  function getProvider(name: string): LpProvider {
    const p = providers.find(p => p.name === name);
    if (!p) throw new Error(`Unknown LP protocol: ${name}. Available: ${providers.map(p => p.name).join(', ')}`);
    return p;
  }

  function resolveProtocol(protocol?: string): string | undefined {
    if (!protocol) return undefined;
    const normalized = protocol.toLowerCase();
    if (!LP_PROTOCOL_NAMES.includes(normalized as LpProtocolName)) {
      throw new Error(`Unknown LP protocol: ${protocol}. Available: ${LP_PROTOCOL_NAMES.join(', ')}`);
    }
    return normalized;
  }

  // ── Read operations ─────────────────────────────────

  async function getConfigs(protocol?: string, poolType?: PoolType): Promise<PoolConfig[]> {
    const proto = resolveProtocol(protocol);
    const targets = proto
      ? [getProvider(proto)]
      : providers.filter(p => p.getConfigs);

    const results = await Promise.allSettled(
      targets.filter(p => p.getConfigs).map(p => p.getConfigs!(poolType)),
    );

    const configs: PoolConfig[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'fulfilled') {
        configs.push(...r.value);
      } else {
        logger.verbose(`${targets[i].name} getConfigs failed: ${r.reason}`);
      }
    }

    return configs;
  }

  async function getPools(tokenA?: string, tokenB?: string, opts?: {
    protocol?: string; sort?: 'tvl' | 'apy' | 'volume';
    limit?: number; poolType?: PoolType;
  }): Promise<PoolsResult> {
    const proto = resolveProtocol(opts?.protocol);
    const targets = proto ? [getProvider(proto)] : providers;
    const results = await Promise.allSettled(targets.map(p => p.getPools(tokenA, tokenB, opts?.limit)));

    const pools: LpPoolInfo[] = [];
    const warnings: string[] = [];

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'fulfilled') {
        pools.push(...r.value);
      } else {
        const name = targets[i].name;
        logger.verbose(`${name} LP pools failed: ${r.reason}`);
        warnings.push(`${name}: ${r.reason?.message || r.reason}`);
      }
    }

    // Filter by pool type
    const filtered = opts?.poolType ? pools.filter(p => p.poolType === opts.poolType) : pools;

    // Sort
    const sort = opts?.sort ?? 'tvl';
    if (sort === 'apy') {
      filtered.sort((a, b) => (b.apy ?? 0) - (a.apy ?? 0));
    } else if (sort === 'volume') {
      filtered.sort((a, b) => (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0));
    } else {
      filtered.sort((a, b) => (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0));
    }

    const limited = opts?.limit ? filtered.slice(0, opts.limit) : filtered;

    return { pools: limited, warnings };
  }

  async function getPositions(walletAddress: string, protocol?: string): Promise<LpPositionInfo[]> {
    const proto = resolveProtocol(protocol);
    const targets = proto ? [getProvider(proto)] : providers;
    const results = await Promise.allSettled(targets.map(p => p.getPositions(walletAddress)));

    const positions: LpPositionInfo[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'fulfilled') {
        positions.push(...r.value);
      } else {
        logger.verbose(`${targets[i].name} LP positions failed: ${r.reason}`);
      }
    }

    return positions;
  }

  // ── Write routing ───────────────────────────────────

  async function findProviderByPool(poolId: string): Promise<LpProvider> {
    for (const p of providers) {
      try {
        const pools = await p.getPools();
        if (pools.some(pool => pool.poolId === poolId)) return p;
      } catch { continue; }
    }
    throw new Error(`Pool ${poolId} not found on any LP protocol`);
  }

  async function findProviderByPosition(positionId: string): Promise<LpProvider> {
    // First try to find position on each provider
    for (const p of providers) {
      try {
        const positions = await p.getPositions(''); // empty address = won't match but tests availability
        // Can't search by positionId without wallet, so fall through
      } catch { continue; }
    }
    // If we can't find it, try each provider's deposit/withdraw directly
    throw new Error(`Position ${positionId} not found on any LP protocol. Specify --protocol to narrow search.`);
  }

  async function getDepositQuote(walletName: string, params: LpDepositParams, protocol?: string): Promise<LpDepositQuote> {
    const proto = resolveProtocol(protocol);
    if (proto) return getProvider(proto).getDepositQuote(walletName, params);

    // Try to find pool across providers
    for (const p of providers) {
      try {
        return await p.getDepositQuote(walletName, params);
      } catch (e: any) {
        ctx.logger.verbose(`${p.name} getDepositQuote failed: ${e.message}`);
        continue;
      }
    }
    throw new Error(`Pool ${params.poolId} not found on any LP protocol`);
  }

  async function deposit(walletName: string, params: LpDepositParams, protocol?: string): Promise<LpWriteResult> {
    const proto = resolveProtocol(protocol);
    if (proto) return getProvider(proto).deposit(walletName, params);

    // Try to find pool across providers
    for (const p of providers) {
      try {
        return await p.deposit(walletName, params);
      } catch (e: any) {
        ctx.logger.verbose(`${p.name} deposit failed: ${e.message}`);
        continue;
      }
    }
    throw new Error(`Pool ${params.poolId} not found on any LP protocol`);
  }

  async function withdraw(walletName: string, params: LpWithdrawParams, protocol?: string): Promise<LpWriteResult> {
    const proto = resolveProtocol(protocol);
    if (proto) return getProvider(proto).withdraw(walletName, params);

    // Try each provider
    for (const p of providers) {
      try {
        return await p.withdraw(walletName, params);
      } catch (e: any) {
        ctx.logger.verbose(`${p.name} withdraw failed: ${e.message}`);
        continue;
      }
    }
    throw new Error(`Position ${params.positionId} not found on any LP protocol. Specify --protocol.`);
  }

  async function claimFees(walletName: string, positionId: string, protocol?: string): Promise<LpWriteResult> {
    const proto = resolveProtocol(protocol);
    if (proto) return getProvider(proto).claimFees(walletName, positionId);

    for (const p of providers) {
      try {
        return await p.claimFees(walletName, positionId);
      } catch (e: any) {
        ctx.logger.verbose(`${p.name} claimFees failed: ${e.message}`);
        continue;
      }
    }
    throw new Error(`Position ${positionId} not found on any LP protocol. Specify --protocol.`);
  }

  async function createPool(walletName: string, params: CreatePoolParams, protocol: string): Promise<LpWriteResult> {
    const p = getProvider(resolveProtocol(protocol)!);
    if (!p.createPool) throw new Error(`${p.name} does not support pool creation`);
    return p.createPool(walletName, params);
  }

  // ── Farming ─────────────────────────────────────────

  async function getFarms(walletAddress: string, protocol?: string): Promise<LpFarmInfo[]> {
    const proto = resolveProtocol(protocol);
    const targets = proto ? [getProvider(proto)] : providers;
    const results = await Promise.allSettled(
      targets.filter(p => p.capabilities.farming && p.getFarms)
        .map(p => p.getFarms!(walletAddress))
    );

    const farms: LpFarmInfo[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled') farms.push(...r.value);
    }
    return farms;
  }

  async function farmStake(walletName: string, positionId: string, farmId: string, protocol?: string): Promise<LpFarmResult> {
    const proto = resolveProtocol(protocol);
    if (proto) {
      const p = getProvider(proto);
      if (!p.farmStake) throw new Error(`${p.name} does not support farm staking`);
      return p.farmStake(walletName, positionId, farmId);
    }

    for (const p of providers) {
      if (!p.farmStake) continue;
      try {
        return await p.farmStake(walletName, positionId, farmId);
      } catch { continue; }
    }
    throw new Error('Farm not found. Specify --protocol.');
  }

  async function farmUnstake(walletName: string, positionId: string, farmId: string, protocol?: string): Promise<LpFarmResult> {
    const proto = resolveProtocol(protocol);
    if (proto) {
      const p = getProvider(proto);
      if (!p.farmUnstake) throw new Error(`${p.name} does not support farm unstaking`);
      return p.farmUnstake(walletName, positionId, farmId);
    }

    for (const p of providers) {
      if (!p.farmUnstake) continue;
      try {
        return await p.farmUnstake(walletName, positionId, farmId);
      } catch { continue; }
    }
    throw new Error('Farm not found. Specify --protocol.');
  }

  async function farmHarvest(walletName: string, farmId: string, protocol?: string): Promise<LpFarmResult> {
    const proto = resolveProtocol(protocol);
    if (proto) {
      const p = getProvider(proto);
      if (!p.farmHarvest) throw new Error(`${p.name} does not support farm harvesting`);
      return p.farmHarvest(walletName, farmId);
    }

    for (const p of providers) {
      if (!p.farmHarvest) continue;
      try {
        return await p.farmHarvest(walletName, farmId);
      } catch { continue; }
    }
    throw new Error('Farm not found. Specify --protocol.');
  }

  function registerProvider(provider: LpProvider): void {
    providers.push(provider);
  }

  return {
    getConfigs, getPools, getPositions, getDepositQuote, deposit, withdraw,
    claimFees, createPool, getFarms, farmStake, farmUnstake, farmHarvest,
    registerProvider,
  };
}
