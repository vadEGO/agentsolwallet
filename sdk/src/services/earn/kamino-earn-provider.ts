import {
  KaminoVaultClient,
  KaminoVault,
} from '@kamino-finance/klend-sdk';
import {
  KLEND_PROGRAM_ID,
  RECENT_SLOT_DURATION_MS,
  getKaminoRpc,
  kAddress,
  kSigner,
  toV2Instructions,
  getCurrentSlot,
} from '../../compat/kamino-compat.js';
import { uiToTokenAmount } from '../../utils/solana.js';
import type { SolContext } from '../../types.js';
import type { TokenRegistryService, TokenMetadata } from '../token-registry-service.js';
import type { PriceService } from '../price-service.js';
import type { TransactionService } from '../transaction-service.js';
import type { EarnProvider, EarnVault, EarnPosition, EarnWriteResult } from './earn-provider.js';

// ── Constants ────────────────────────────────────────────

const KAMINO_VAULTS_API = 'https://api.kamino.finance/kvaults/vaults';
const KVAULTS_PROGRAM_ID = 'KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd';
const CACHE_TTL_MS = 60_000;

// ── Caching ──────────────────────────────────────────────

interface CachedVaultData {
  address: string;
  name: string;
  tokenMint: string;
  tokenMintDecimals: number;
  sharesMint: string;
  sharesIssued: string;
  tokenAvailable: string;
  activeAllocations: number;
}

let vaultCache: CachedVaultData[] = [];
let vaultCacheTs = 0;

// ── Helpers ──────────────────────────────────────────────

function formatVaultName(raw: string, tokenSymbol: string): string {
  if (raw && raw.length > 2) return raw;
  return `Kamino ${tokenSymbol}`;
}

/** Extract net APY as decimal from SDK APY result. */
function extractApy(apyResult: any): number {
  // getVaultActualAPY returns { grossAPY: Decimal, netAPY: Decimal }
  const netApy = apyResult?.netAPY ?? apyResult?.grossAPY;
  return netApy ? netApy.toNumber() : 0;
}

/** Flatten deposit/withdraw ix objects into a single instruction array. */
function flattenIxs(ixResult: any): any[] {
  // depositIxs returns { ixs, stakeInFarmIfNeededIxs, stakeInFlcFarmIfNeededIxs }
  // withdrawIxs returns { unstakeFromFarmIfNeededIxs, withdrawIxs, postWithdrawIxs }
  const all: any[] = [];
  for (const key of Object.keys(ixResult)) {
    const val = ixResult[key];
    if (Array.isArray(val)) all.push(...val);
  }
  return all;
}

/**
 * Split withdraw ix result into [pre-txs, main-tx] when unstake ixs would
 * make a single transaction too large. Returns groups that should be sent sequentially.
 */
function splitWithdrawIxGroups(ixResult: any): any[][] {
  const unstake = ixResult.unstakeFromFarmIfNeededIxs ?? [];
  const withdraw = ixResult.withdrawIxs ?? [];
  const post = ixResult.postWithdrawIxs ?? [];

  if (unstake.length === 0) {
    // No farm — everything fits in one tx
    return [[...withdraw, ...post]];
  }

  // Farm unstake goes in a separate tx, then withdraw + post
  return [unstake, [...withdraw, ...post]];
}

// ── Dependencies ─────────────────────────────────────────

export interface KaminoEarnDeps {
  registry: TokenRegistryService;
  price: PriceService;
  tx: TransactionService;
}

// ── Provider ─────────────────────────────────────────────

export class KaminoEarnProvider implements EarnProvider {
  name = 'kamino' as const;

  private clientCache: KaminoVaultClient | null = null;

  constructor(private ctx: SolContext, private deps: KaminoEarnDeps) {}

  private getClient(): KaminoVaultClient {
    if (!this.clientCache) {
      this.clientCache = new KaminoVaultClient(
        getKaminoRpc(this.ctx.rpc),
        RECENT_SLOT_DURATION_MS,
        kAddress(KVAULTS_PROGRAM_ID),
        kAddress(KLEND_PROGRAM_ID),
      );
    }
    return this.clientCache;
  }

  private async fetchVaultList(): Promise<CachedVaultData[]> {
    if (Date.now() - vaultCacheTs < CACHE_TTL_MS && vaultCache.length > 0) {
      return vaultCache;
    }

    this.ctx.logger.verbose('Fetching Kamino vault list from API...');
    const resp = await fetch(KAMINO_VAULTS_API);
    if (!resp.ok) throw new Error(`Kamino vault API error ${resp.status}`);

    const data: any[] = await resp.json();

    const results: CachedVaultData[] = [];
    for (const v of data) {
      const s = v.state;
      const sharesIssued = BigInt(s.sharesIssued || '0');
      if (sharesIssued <= 0n) continue;

      const allocs = (s.vaultAllocationStrategy ?? []).filter(
        (a: any) => a.targetAllocationWeight > 0
      );
      if (allocs.length === 0) continue;

      results.push({
        address: v.address,
        name: s.name || '',
        tokenMint: s.tokenMint,
        tokenMintDecimals: s.tokenMintDecimals,
        sharesMint: s.sharesMint,
        sharesIssued: s.sharesIssued,
        tokenAvailable: s.tokenAvailable,
        activeAllocations: allocs.length,
      });
    }

    vaultCache = results;
    vaultCacheTs = Date.now();
    return results;
  }

  private async resolveTokenStrict(symbolOrMint: string): Promise<TokenMetadata> {
    const meta = await this.deps.registry.resolveToken(symbolOrMint);
    if (!meta) throw new Error(`Unknown token: ${symbolOrMint}`);
    return meta;
  }

  private async loadKaminoVault(vaultAddress: string): Promise<KaminoVault> {
    const client = this.getClient();
    const vault = new KaminoVault(
      getKaminoRpc(this.ctx.rpc),
      kAddress(vaultAddress),
      undefined,
      kAddress(KVAULTS_PROGRAM_ID),
      RECENT_SLOT_DURATION_MS,
    );
    vault.client = client;
    return vault;
  }

  async getVaults(tokens?: string[]): Promise<EarnVault[]> {
    const vaultList = await this.fetchVaultList();

    // Resolve token filters to mints
    let mintFilter: Set<string> | null = null;
    if (tokens && tokens.length > 0) {
      mintFilter = new Set<string>();
      for (const t of tokens) {
        const meta = await this.deps.registry.resolveToken(t);
        if (meta) mintFilter.add(meta.mint);
        else mintFilter.add(t); // might be a mint address directly
      }
    }

    let filtered = vaultList;
    if (mintFilter) {
      filtered = vaultList.filter(v => mintFilter!.has(v.tokenMint));
    }

    // Resolve symbols for all unique mints
    const mintSet = new Set(filtered.map(v => v.tokenMint));
    const symbolMap = new Map<string, string>();
    await Promise.all([...mintSet].map(async mint => {
      const meta = await this.deps.registry.resolveToken(mint);
      if (meta) symbolMap.set(mint, meta.symbol);
    }));

    // Compute APY and TVL for each vault using the SDK
    const client = this.getClient();
    const slot = await getCurrentSlot(this.ctx.rpc);
    const vaults: EarnVault[] = [];

    for (const v of filtered) {
      const symbol = symbolMap.get(v.tokenMint) ?? '';
      try {
        const kVault = await this.loadKaminoVault(v.address);
        const state = await kVault.getState();

        const reservesMap = await client.loadVaultReserves(state as any);
        // Holdings are in UI units (SDK converts from lamports internally)
        const holdings: any = await client.getVaultHoldings(state as any, slot, reservesMap);
        const totalTokens = holdings.available.add(holdings.invested);

        let apy = 0;
        try {
          const apyResult = await client.getVaultActualAPY(state as any, slot, reservesMap);
          apy = extractApy(apyResult);
        } catch {
          this.ctx.logger.verbose(`Could not compute APY for vault ${v.name || v.address}`);
        }

        vaults.push({
          protocol: 'kamino',
          vaultId: v.address,
          vaultName: formatVaultName(v.name, symbol),
          token: symbol || 'unknown',
          mint: v.tokenMint,
          apy,
          tvlToken: totalTokens.toNumber(),
          tvlUsd: null, // enriched by service layer
          depositsEnabled: true,
        });
      } catch (err: any) {
        this.ctx.logger.verbose(`Skipping vault ${v.name || v.address}: ${err.message}`);
      }
    }

    return vaults;
  }

  async getPositions(walletAddress: string): Promise<EarnPosition[]> {
    this.ctx.logger.verbose(`Fetching Kamino earn positions for ${walletAddress}`);

    const client = this.getClient();
    const vaultList = await this.fetchVaultList();
    const slot = await getCurrentSlot(this.ctx.rpc);

    // Check user shares in all vaults
    const results = await Promise.allSettled(
      vaultList.map(async (v) => {
        const kVault = await this.loadKaminoVault(v.address);
        const userShares = await client.getUserSharesBalanceSingleVault(
          kAddress(walletAddress),
          kVault,
        );

        if (userShares.totalShares.isZero()) return null;

        const state = await kVault.getState();
        const reservesMap = await client.loadVaultReserves(state as any);
        // Both totalShares and tokensPerShare are in UI units (SDK converts from lamports internally)
        const tokensPerShare = await client.getTokensPerShareSingleVault(state as any, slot, reservesMap);
        const depositedAmount = userShares.totalShares.mul(tokensPerShare).toNumber();

        if (depositedAmount <= 0) return null;

        let apy = 0;
        try {
          const apyResult = await client.getVaultActualAPY(state as any, slot, reservesMap);
          apy = extractApy(apyResult);
        } catch { /* non-critical */ }

        const symbol = (await this.deps.registry.resolveToken(v.tokenMint))?.symbol ?? '';

        return {
          protocol: 'kamino' as const,
          vaultId: v.address,
          vaultName: formatVaultName(v.name, symbol),
          token: symbol || 'unknown',
          mint: v.tokenMint,
          depositedAmount,
          valueUsd: null as number | null,
          apy,
          shares: userShares.totalShares.toNumber(),
        };
      })
    );

    const mints = new Set<string>();
    const rawPositions: EarnPosition[] = [];

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        rawPositions.push(r.value);
        mints.add(r.value.mint);
      }
    }

    if (rawPositions.length === 0) return [];

    const prices = await this.deps.price.getPrices([...mints]);
    for (const p of rawPositions) {
      const price = prices.get(p.mint)?.priceUsd ?? 0;
      p.valueUsd = p.depositedAmount * price;
    }

    return rawPositions;
  }

  async deposit(walletName: string, token: string, amount: number, vaultId?: string): Promise<EarnWriteResult> {
    const meta = await this.resolveTokenStrict(token);
    const signer = await this.ctx.signer.getSigner(walletName);
    const client = this.getClient();

    let targetVaultAddress: string;
    if (vaultId) {
      targetVaultAddress = vaultId;
    } else {
      // Pick best APY vault for this token
      const earnVaults = await this.getVaults([token]);
      if (earnVaults.length === 0) throw new Error(`No Kamino vault found for ${meta.symbol}`);
      const best = earnVaults.reduce((a, b) => b.apy > a.apy ? b : a);
      targetVaultAddress = best.vaultId;
      this.ctx.logger.verbose(`Auto-selected vault "${best.vaultName}" (APY: ${(best.apy * 100).toFixed(2)}%)`);
    }

    const kVault = await this.loadKaminoVault(targetVaultAddress);
    const state = await kVault.getState();
    const reservesMap = await client.loadVaultReserves(state as any);

    // klend-sdk expects UI amount (e.g. 1.0 for 1 USDC) — it converts to raw internally
    const { default: DecimalCls } = await import('decimal.js') as any;
    const ixResult = await client.depositIxs(
      kSigner(signer),
      kVault,
      new DecimalCls(amount.toString()),
      reservesMap,
    );

    const instructions = toV2Instructions(flattenIxs(ixResult));

    const prices = await this.deps.price.getPrices([meta.mint]);
    const price = prices.get(meta.mint)?.priceUsd;
    const rawAmount = uiToTokenAmount(amount, meta.decimals);

    const result = await this.deps.tx.buildAndSendTransaction(instructions, signer, {
      txType: 'earn-deposit',
      walletName,
      fromMint: meta.mint,
      fromAmount: rawAmount.toString(),
      fromPriceUsd: price,
    });

    return {
      signature: result.signature,
      protocol: 'kamino',
      explorerUrl: result.explorerUrl,
    };
  }

  async withdraw(walletName: string, token: string, amount: number): Promise<EarnWriteResult> {
    const meta = await this.resolveTokenStrict(token);
    const signer = await this.ctx.signer.getSigner(walletName);
    const client = this.getClient();
    const slot = await getCurrentSlot(this.ctx.rpc);

    // Find user's vault position for this token
    const positions = await this.getPositions(signer.address);
    const pos = positions.find(p => p.mint === meta.mint && p.depositedAmount > 0);
    if (!pos) throw new Error(`No Kamino vault position found for ${meta.symbol}`);

    const kVault = await this.loadKaminoVault(pos.vaultId);
    const state = await kVault.getState();
    const reservesMap = await client.loadVaultReserves(state as any);

    const isMax = !isFinite(amount);
    const { default: DecimalCls } = await import('decimal.js') as any;
    let shareAmount: any; // klend-sdk Decimal

    if (isMax) {
      // Withdraw all shares
      const userShares = await client.getUserSharesBalanceSingleVault(
        kAddress(signer.address),
        kVault,
      );
      shareAmount = userShares.totalShares;
    } else {
      // Convert token amount to shares
      const tokensPerShare = await client.getTokensPerShareSingleVault(state as any, slot, reservesMap);
      if (tokensPerShare.isZero()) throw new Error('Cannot compute share amount (zero exchange rate)');
      const rawAmount = uiToTokenAmount(amount, meta.decimals);
      shareAmount = new DecimalCls(rawAmount.toString()).div(tokensPerShare);
    }

    this.ctx.logger.verbose(`Withdrawing ${shareAmount.toFixed(0)} shares from vault ${pos.vaultName}`);

    const ixResult = await client.withdrawIxs(
      kSigner(signer),
      kVault,
      shareAmount,
      slot,
      reservesMap,
    );

    const prices = await this.deps.price.getPrices([meta.mint]);
    const price = prices.get(meta.mint)?.priceUsd;
    const rawAmount = isMax ? '0' : uiToTokenAmount(amount, meta.decimals).toString();

    // Split into multiple txs if farm unstake makes it too large
    const ixGroups = splitWithdrawIxGroups(ixResult);

    let result: any;
    for (let i = 0; i < ixGroups.length; i++) {
      const isLast = i === ixGroups.length - 1;
      const instructions = toV2Instructions(ixGroups[i]);
      if (instructions.length === 0) continue;

      if (i > 0) this.ctx.logger.verbose(`Sending withdraw transaction ${i + 1}/${ixGroups.length}...`);
      result = await this.deps.tx.buildAndSendTransaction(instructions, signer, {
        // Pre-txs (farm unstake) get a descriptive type; only the final tx is the real withdraw
        txType: isLast ? 'earn-withdraw' : 'earn-unstake',
        walletName,
        toMint: isLast ? meta.mint : undefined,
        toAmount: isLast ? rawAmount : undefined,
        toPriceUsd: isLast ? price : undefined,
      });
    }

    return {
      signature: result.signature,
      protocol: 'kamino',
      explorerUrl: result.explorerUrl,
    };
  }
}
