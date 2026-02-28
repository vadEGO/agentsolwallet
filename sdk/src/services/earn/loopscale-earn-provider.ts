import {
  fetchVaults,
  findBestVault,
  getUserVaultPositions,
  lpToUnderlying,
  loopscaleFetch,
  signAndSendLoopscaleTx,
  type VaultInfo,
} from '../lend/loopscale-provider.js';
import { uiToTokenAmount, explorerUrl } from '../../utils/solana.js';
import type { SolContext } from '../../types.js';
import type { TokenRegistryService, TokenMetadata } from '../token-registry-service.js';
import type { PriceService } from '../price-service.js';
import type { TransactionService } from '../transaction-service.js';
import type { EarnProvider, EarnVault, EarnPosition, EarnWriteResult } from './earn-provider.js';

// ── Dependencies ─────────────────────────────────────────

export interface LoopscaleEarnDeps {
  registry: TokenRegistryService;
  price: PriceService;
  tx: TransactionService;
}

// ── Provider ─────────────────────────────────────────────

export class LoopscaleEarnProvider implements EarnProvider {
  name = 'loopscale' as const;

  constructor(private ctx: SolContext, private deps: LoopscaleEarnDeps) {}

  private async resolveTokenStrict(symbolOrMint: string): Promise<TokenMetadata> {
    const meta = await this.deps.registry.resolveToken(symbolOrMint);
    if (!meta) throw new Error(`Unknown token: ${symbolOrMint}`);
    return meta;
  }

  async getVaults(tokens?: string[]): Promise<EarnVault[]> {
    const vaults = await fetchVaults(this.ctx, this.deps.registry);

    let filtered = vaults;
    if (tokens && tokens.length > 0) {
      const upper = tokens.map(t => t.toUpperCase());
      filtered = vaults.filter(v =>
        upper.includes(v.symbol.toUpperCase()) ||
        tokens.includes(v.principalMint)
      );
    }

    return filtered.map(v => ({
      protocol: 'loopscale',
      vaultId: v.address,
      vaultName: `Loopscale ${v.symbol}`,
      token: v.symbol || 'unknown',
      mint: v.principalMint,
      apy: v.depositApy,
      tvlToken: v.totalDeposited,
      tvlUsd: null, // enriched by service layer
      depositsEnabled: true,
    }));
  }

  async getPositions(walletAddress: string): Promise<EarnPosition[]> {
    this.ctx.logger.verbose(`Fetching Loopscale earn positions for ${walletAddress}`);

    const [userPositions, vaults] = await Promise.all([
      getUserVaultPositions(this.ctx, walletAddress).catch(() => []),
      fetchVaults(this.ctx, this.deps.registry),
    ]);

    const positions: EarnPosition[] = [];
    const mints = new Set<string>();
    for (const up of userPositions) {
      if (up.vaultLpBalance > 0) mints.add(up.mint);
    }
    const prices = mints.size > 0 ? await this.deps.price.getPrices([...mints]) : new Map();

    for (const up of userPositions) {
      if (up.vaultLpBalance <= 0) continue;
      const vault = vaults.find(v => v.address === up.vaultAddress);
      if (!vault) continue;

      const amount = lpToUnderlying(up.vaultLpBalance, vault);
      if (amount <= 0) continue;

      const price = prices.get(vault.principalMint)?.priceUsd ?? 0;

      positions.push({
        protocol: 'loopscale',
        vaultId: vault.address,
        vaultName: `Loopscale ${vault.symbol}`,
        token: vault.symbol || 'unknown',
        mint: vault.principalMint,
        depositedAmount: amount,
        valueUsd: amount * price,
        apy: vault.depositApy,
        shares: up.vaultLpBalance,
      });
    }

    return positions;
  }

  async deposit(walletName: string, token: string, amount: number, vaultId?: string): Promise<EarnWriteResult> {
    const meta = await this.resolveTokenStrict(token);
    const signer = await this.ctx.signer.getSigner(walletName);
    const rawAmount = uiToTokenAmount(amount, meta.decimals).toString();

    const vaults = await fetchVaults(this.ctx, this.deps.registry);
    let vault: VaultInfo | undefined;
    if (vaultId) {
      vault = vaults.find(v => v.address === vaultId);
      if (!vault) throw new Error(`Loopscale vault ${vaultId} not found`);
    } else {
      vault = findBestVault(vaults, meta.mint);
    }
    if (!vault) throw new Error(`No Loopscale vault found for ${meta.symbol}`);

    this.ctx.logger.verbose(`Using Loopscale vault ${vault.address} (APY: ${(vault.depositApy * 100).toFixed(2)}%)`);

    const resp = await loopscaleFetch(this.ctx, '/markets/lending_vaults/deposit', {
      vault: vault.address,
      principalAmount: Number(rawAmount),
      minLpAmount: 0,
    }, signer.address);

    const txObj = resp.transaction;
    if (!txObj?.message) throw new Error('Loopscale API did not return a transaction');

    const prices = await this.deps.price.getPrices([meta.mint]);
    const price = prices.get(meta.mint)?.priceUsd;

    const signature = await signAndSendLoopscaleTx(this.ctx, this.deps.tx, txObj, signer, {
      txType: 'earn-deposit',
      walletName,
      fromMint: meta.mint,
      fromAmount: rawAmount,
      fromPriceUsd: price,
    });

    return {
      signature,
      protocol: 'loopscale',
      explorerUrl: explorerUrl(signature),
    };
  }

  async withdraw(walletName: string, token: string, amount: number): Promise<EarnWriteResult> {
    const meta = await this.resolveTokenStrict(token);
    const signer = await this.ctx.signer.getSigner(walletName);

    const [vaults, userPositions] = await Promise.all([
      fetchVaults(this.ctx, this.deps.registry),
      getUserVaultPositions(this.ctx, signer.address).catch(() => []),
    ]);
    const userPos = userPositions.find(p => p.mint === meta.mint && p.vaultLpBalance > 0);
    const vault = userPos
      ? vaults.find(v => v.address === userPos.vaultAddress)
      : findBestVault(vaults, meta.mint);
    if (!vault) throw new Error(`No Loopscale vault found for ${meta.symbol}`);

    const isMax = !isFinite(amount);
    const body: Record<string, any> = { vault: vault.address };

    if (isMax) {
      body.withdrawAll = true;
      body.maxAmountLp = Number.MAX_SAFE_INTEGER;
      body.amountPrincipal = 0;
    } else {
      body.amountPrincipal = Number(uiToTokenAmount(amount, meta.decimals));
      body.maxAmountLp = Number.MAX_SAFE_INTEGER;
    }

    const resp = await loopscaleFetch(this.ctx, '/markets/lending_vaults/withdraw', body, signer.address);

    const txObj = resp.transaction;
    if (!txObj?.message) throw new Error('Loopscale API did not return a transaction');

    const prices = await this.deps.price.getPrices([meta.mint]);
    const price = prices.get(meta.mint)?.priceUsd;
    const rawAmount = isMax ? '0' : uiToTokenAmount(amount, meta.decimals).toString();

    const signature = await signAndSendLoopscaleTx(this.ctx, this.deps.tx, txObj, signer, {
      txType: 'earn-withdraw',
      walletName,
      toMint: meta.mint,
      toAmount: rawAmount,
      toPriceUsd: price,
    });

    return {
      signature,
      protocol: 'loopscale',
      explorerUrl: explorerUrl(signature),
    };
  }
}
