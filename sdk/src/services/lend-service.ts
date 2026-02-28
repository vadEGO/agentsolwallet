import type { SolContext } from '../types.js';
import type {
  LendProvider,
  LendWriteResult,
  LendingRate,
  LendingPosition,
  ProtocolName,
} from './lend/lend-provider.js';
import { PROTOCOL_NAMES } from './lend/lend-provider.js';

export type { LendingRate, LendingPosition, LendWriteResult } from './lend/lend-provider.js';

export interface RatesResult {
  rates: LendingRate[];
  warnings: string[];
  bestDepositProtocol: Record<string, string>;
  bestBorrowProtocol: Record<string, string>;
}

export interface LendService {
  getRates(tokens?: string[], protocol?: string): Promise<RatesResult>;
  getPositions(walletAddress: string, protocol?: string): Promise<LendingPosition[]>;
  deposit(walletName: string, token: string, amount: number, protocol?: string): Promise<LendWriteResult>;
  withdraw(walletName: string, token: string, amount: number, protocol?: string): Promise<LendWriteResult>;
  borrow(walletName: string, token: string, amount: number, collateral: string, protocol?: string): Promise<LendWriteResult>;
  repay(walletName: string, token: string, amount: number, protocol?: string): Promise<LendWriteResult>;
  registerProvider(provider: LendProvider): void;
}

export function createLendService(ctx: SolContext): LendService {
  const { logger, signer } = ctx;
  const providers: LendProvider[] = [];

  function getProvider(name: string): LendProvider {
    const p = providers.find(p => p.name === name);
    if (!p) throw new Error(`Unknown protocol: ${name}. Available: ${providers.map(p => p.name).join(', ')}`);
    return p;
  }

  function resolveProtocol(protocol?: string): string | undefined {
    if (!protocol) {
      const defaultProto = ctx.config.get('lend.defaultProtocol') as string | undefined;
      return defaultProto || undefined;
    }
    const normalized = protocol.toLowerCase();
    if (!PROTOCOL_NAMES.includes(normalized as ProtocolName)) {
      throw new Error(`Unknown protocol: ${protocol}. Available: ${PROTOCOL_NAMES.join(', ')}`);
    }
    return normalized;
  }

  async function getRates(tokens?: string[], protocol?: string): Promise<RatesResult> {
    const proto = resolveProtocol(protocol);
    const targets = proto ? [getProvider(proto)] : providers;
    const results = await Promise.allSettled(targets.map(p => p.getRates(tokens)));

    const rates: LendingRate[] = [];
    const warnings: string[] = [];

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'fulfilled') {
        rates.push(...r.value);
      } else {
        const name = targets[i].name;
        logger.verbose(`${name} rates failed: ${r.reason}`);
        warnings.push(`${name}: ${r.reason?.message || r.reason}`);
      }
    }

    const bestDepositProtocol: Record<string, string> = {};
    const bestBorrowProtocol: Record<string, string> = {};

    const byToken = new Map<string, LendingRate[]>();
    for (const r of rates) {
      const arr = byToken.get(r.token) ?? [];
      arr.push(r);
      byToken.set(r.token, arr);
    }

    for (const [token, tokenRates] of byToken) {
      const bestDeposit = tokenRates.reduce((best, r) => r.depositApy > best.depositApy ? r : best);
      bestDepositProtocol[token] = bestDeposit.protocol;

      const borrowRates = tokenRates.filter(r => r.borrowApy > 0);
      if (borrowRates.length > 0) {
        const bestBorrow = borrowRates.reduce((best, r) => r.borrowApy < best.borrowApy ? r : best);
        bestBorrowProtocol[token] = bestBorrow.protocol;
      }
    }

    return { rates, warnings, bestDepositProtocol, bestBorrowProtocol };
  }

  async function getPositions(walletAddress: string, protocol?: string): Promise<LendingPosition[]> {
    const proto = resolveProtocol(protocol);
    const targets = proto ? [getProvider(proto)] : providers;
    const results = await Promise.allSettled(targets.map(p => p.getPositions(walletAddress)));

    const positions: LendingPosition[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'fulfilled') {
        positions.push(...r.value);
      } else {
        logger.verbose(`${targets[i].name} positions failed: ${r.reason}`);
      }
    }

    return positions;
  }

  async function deposit(walletName: string, token: string, amount: number, protocol?: string): Promise<LendWriteResult> {
    const proto = resolveProtocol(protocol);

    if (proto) {
      return getProvider(proto).deposit(walletName, token, amount);
    }

    const { rates, bestDepositProtocol } = await getRates([token]);
    const bestProto = bestDepositProtocol[token.toUpperCase()] ?? bestDepositProtocol[token];

    if (!bestProto && rates.length === 0) {
      throw new Error(`No lending protocol has a reserve for ${token}`);
    }

    const target = bestProto ? getProvider(bestProto) : providers[0];
    logger.verbose(`Auto-selected ${target.name} (best deposit rate for ${token})`);
    return target.deposit(walletName, token, amount);
  }

  async function withdraw(walletName: string, token: string, amount: number, protocol?: string): Promise<LendWriteResult> {
    const proto = resolveProtocol(protocol);

    if (proto) {
      return getProvider(proto).withdraw(walletName, token, amount);
    }

    const signerAddr = await signer.getAddress(walletName);
    const allPositions = await getPositions(signerAddr);
    const tokenUpper = token.toUpperCase();
    const deposits = allPositions.filter(p =>
      p.type === 'deposit' && p.token.toUpperCase() === tokenUpper
    );

    if (deposits.length === 0) {
      throw new Error(`No ${token} deposit found. Check with: sol lend positions`);
    }
    if (deposits.length === 1) {
      return getProvider(deposits[0].protocol).withdraw(walletName, token, amount);
    }

    const protos = [...new Set(deposits.map(d => d.protocol))];
    if (protos.length === 1) {
      return getProvider(protos[0]).withdraw(walletName, token, amount);
    }

    throw new Error(
      `${token} deposits found on multiple protocols: ${protos.join(', ')}. ` +
      `Specify one with --protocol, e.g.: sol lend withdraw ${amount} ${token} --protocol ${protos[0]}`
    );
  }

  async function borrow(walletName: string, token: string, amount: number, collateral: string, protocol?: string): Promise<LendWriteResult> {
    const proto = resolveProtocol(protocol) ?? 'kamino';

    const provider = getProvider(proto);
    if (!provider.capabilities.borrow || !provider.borrow) {
      const available = providers.filter(p => p.capabilities.borrow).map(p => p.name);
      throw new Error(
        `${provider.name} does not support borrowing. Available: ${available.join(', ')}`
      );
    }

    return provider.borrow(walletName, token, amount, collateral);
  }

  async function repay(walletName: string, token: string, amount: number, protocol?: string): Promise<LendWriteResult> {
    const proto = resolveProtocol(protocol);

    if (proto) {
      const provider = getProvider(proto);
      if (!provider.capabilities.repay || !provider.repay) {
        throw new Error(`${provider.name} does not support repayment.`);
      }
      return provider.repay(walletName, token, amount);
    }

    const signerAddr = await signer.getAddress(walletName);
    const allPositions = await getPositions(signerAddr);
    const tokenUpper = token.toUpperCase();
    const borrows = allPositions.filter(p =>
      p.type === 'borrow' && p.token.toUpperCase() === tokenUpper
    );

    if (borrows.length === 0) {
      throw new Error(`No ${token} borrow found. Check with: sol lend positions`);
    }

    const protos = [...new Set(borrows.map(b => b.protocol))];
    if (protos.length === 1) {
      const provider = getProvider(protos[0]);
      if (!provider.repay) throw new Error(`${provider.name} does not support repayment.`);
      return provider.repay(walletName, token, amount);
    }

    throw new Error(
      `${token} borrows found on multiple protocols: ${protos.join(', ')}. ` +
      `Specify one with --protocol, e.g.: sol lend repay ${amount} ${token} --protocol ${protos[0]}`
    );
  }

  function registerProvider(provider: LendProvider): void {
    providers.push(provider);
  }

  return { getRates, getPositions, deposit, withdraw, borrow, repay, registerProvider };
}
