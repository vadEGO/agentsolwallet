import { MarginfiClient, getConfig, type MarginfiAccountWrapper } from '@mrgnlabs/marginfi-client-v2';
import { PublicKey, Keypair, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import {
  generateKeyPairSigner,
  type Instruction,
  type AccountMeta,
  address as kitAddress,
} from '@solana/kit';
import { getV1Connection, DummyWallet, toV2Instructions } from '../../compat/marginfi-compat.js';
import { uiToTokenAmount } from '../../utils/solana.js';
import type { LendProvider, LendWriteResult, LendingRate, LendingPosition } from './lend-provider.js';
import { MarginRequirementType } from '@mrgnlabs/marginfi-client-v2';
import type { SolContext } from '../../types.js';
import type { TokenRegistryService, TokenMetadata } from '../token-registry-service.js';
import type { PriceService } from '../price-service.js';
import type { TransactionService } from '../transaction-service.js';

// ── Deps ─────────────────────────────────────────────────

export interface MarginfiDeps {
  registry: TokenRegistryService;
  price: PriceService;
  tx: TransactionService;
  rpcUrl: string;
}

// ── Provider ─────────────────────────────────────────────

export class MarginfiProvider implements LendProvider {
  name = 'marginfi' as const;
  capabilities = { deposit: true, withdraw: true, borrow: true, repay: true };

  // Client caching
  private cachedClient: MarginfiClient | null = null;
  private clientLoadedAt = 0;
  private readonly CLIENT_TTL_MS = 60_000;

  constructor(private ctx: SolContext, private deps: MarginfiDeps) {}

  // ── Client loading ──────────────────────────────────────

  /**
   * Load a MarginFi client.
   * For read-only ops, uses a dummy wallet. For write ops, pass the wallet address
   * so account derivation (PDAs) uses the correct authority.
   */
  private async loadClient(walletAddress?: string): Promise<MarginfiClient> {
    const now = Date.now();
    if (this.cachedClient && (now - this.clientLoadedAt) < this.CLIENT_TTL_MS && !walletAddress) {
      return this.cachedClient;
    }

    this.ctx.logger.verbose('Loading MarginFi client...');
    const config = getConfig('production');
    const connection = getV1Connection(this.deps.rpcUrl);

    // DummyWallet for account derivation — signing is done via our v2 pipeline
    const wallet = walletAddress
      ? new DummyWallet(walletAddress)
      : new DummyWallet(Keypair.generate().publicKey.toBase58());

    const client = await MarginfiClient.fetch(config, wallet as any, connection as any);

    if (!walletAddress) {
      this.cachedClient = client;
      this.clientLoadedAt = now;
    }

    return client;
  }

  // ── Helpers ─────────────────────────────────────────────

  private async resolveTokenStrict(symbolOrMint: string): Promise<TokenMetadata> {
    const meta = await this.deps.registry.resolveToken(symbolOrMint);
    if (!meta) throw new Error(`Unknown token: ${symbolOrMint}`);
    return meta;
  }

  private async getExistingAccount(
    client: MarginfiClient,
    walletPubkey: PublicKey,
  ): Promise<MarginfiAccountWrapper | null> {
    const accounts = await client.getMarginfiAccountsForAuthority(walletPubkey);
    return accounts.length > 0 ? accounts[0] : null;
  }

  /**
   * Build create-account instructions with a v2-compatible ephemeral signer.
   * Returns both the v2 instructions (with signer injected) and the ephemeral signer.
   */
  private async buildCreateAccountIxs(client: MarginfiClient): Promise<Instruction[]> {
    const ephemeral = await generateKeyPairSigner();
    const { instructions } = await client.makeCreateMarginfiAccountIx(
      new PublicKey(ephemeral.address),
    );

    // Convert to v2, then replace the ephemeral account address with the actual signer
    // so signTransactionMessageWithSigners picks it up
    const v2Ixs = toV2Instructions(instructions);
    return v2Ixs.map(ix => ({
      ...ix,
      accounts: (ix.accounts ?? []).map((acc: AccountMeta) => {
        if (acc.address === ephemeral.address && (acc.role === 2 || acc.role === 3)) {
          return { ...acc, signer: ephemeral } as any;
        }
        return acc;
      }),
    }));
  }

  private computeHealthFactor(account: MarginfiAccountWrapper): number | undefined {
    try {
      const health = account.computeHealthComponents(MarginRequirementType.Maintenance);
      const liabilities = health.liabilities.toNumber();
      if (liabilities <= 0) return undefined;
      return health.assets.toNumber() / liabilities;
    } catch {
      return undefined;
    }
  }

  /**
   * Send Switchboard Pull oracle update transaction if needed.
   * MarginFi banks using SwitchboardPull oracles require a feed crank
   * in a separate transaction before borrow/withdraw operations.
   */
  private async sendOracleUpdateIfNeeded(
    account: MarginfiAccountWrapper,
    bankAddresses: PublicKey[],
    walletName: string,
  ): Promise<void> {
    const { instructions: feedIxs, luts: feedLuts } = await account.makeUpdateFeedIx(bankAddresses);
    if (feedIxs.length === 0) return;

    this.ctx.logger.verbose(`Sending Switchboard oracle update (${feedIxs.length} instructions)...`);
    const connection = getV1Connection(this.deps.rpcUrl);
    const rawBytes = this.ctx.signer.getRawBytes!(walletName);
    const v1Keypair = Keypair.fromSecretKey(rawBytes);

    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const msg = new TransactionMessage({
      instructions: feedIxs,
      payerKey: v1Keypair.publicKey,
      recentBlockhash: blockhash,
    }).compileToV0Message(feedLuts);

    const tx = new VersionedTransaction(msg);
    tx.sign([v1Keypair]);

    const sig = await connection.sendTransaction(tx, {
      skipPreflight: true,
      maxRetries: 0,
    });
    this.ctx.logger.verbose(`Oracle update sent: ${sig}`);

    // Wait for confirmation
    const start = Date.now();
    while (Date.now() - start < 30_000) {
      const result = await connection.getSignatureStatus(sig);
      if (result.value?.confirmationStatus === 'confirmed' || result.value?.confirmationStatus === 'finalized') {
        this.ctx.logger.verbose('Oracle update confirmed');
        return;
      }
      if (result.value?.err) {
        this.ctx.logger.verbose(`Oracle update failed: ${JSON.stringify(result.value.err)} — proceeding anyway`);
        return;
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    this.ctx.logger.verbose('Oracle update confirmation timeout — proceeding anyway');
  }

  // ── LendProvider methods ────────────────────────────────

  async getRates(tokens?: string[]): Promise<LendingRate[]> {
    const client = await this.loadClient();
    const rates: LendingRate[] = [];

    for (const [, bank] of client.banks) {
      const symbol = bank.tokenSymbol ?? '';
      if (!symbol) continue;

      // Filter if tokens specified
      if (tokens && tokens.length > 0) {
        const match = tokens.some(t =>
          t.toUpperCase() === symbol.toUpperCase() ||
          t === bank.mint.toBase58()
        );
        if (!match) continue;
      }

      const interestRates = bank.computeInterestRates();
      const mintFactor = Math.pow(10, bank.mintDecimals);

      rates.push({
        protocol: 'marginfi',
        token: symbol,
        mint: bank.mint.toBase58(),
        depositApy: interestRates.lendingRate.toNumber(),
        borrowApy: interestRates.borrowingRate.toNumber(),
        totalDeposited: bank.getTotalAssetQuantity().toNumber() / mintFactor,
        totalBorrowed: bank.getTotalLiabilityQuantity().toNumber() / mintFactor,
        utilizationPct: bank.computeUtilizationRate().toNumber() * 100,
      });
    }

    return rates;
  }

  async getPositions(walletAddress: string): Promise<LendingPosition[]> {
    this.ctx.logger.verbose(`Fetching MarginFi positions for ${walletAddress}`);
    const client = await this.loadClient(walletAddress);
    const walletPubkey = new PublicKey(walletAddress);

    const accounts = await client.getMarginfiAccountsForAuthority(walletPubkey);
    if (accounts.length === 0) return [];

    const positions: LendingPosition[] = [];

    for (const account of accounts) {
      const healthFactor = this.computeHealthFactor(account);

      for (const balance of account.activeBalances) {
        const bank = client.getBankByPk(balance.bankPk);
        if (!bank) continue;

        const qty = balance.computeQuantityUi(bank);
        const usdValue = balance.computeUsdValue(bank, client.oraclePrices.get(balance.bankPk.toBase58())!);
        const interestRates = bank.computeInterestRates();
        const symbol = bank.tokenSymbol ?? bank.mint.toBase58().slice(0, 8);

        const assets = qty.assets.toNumber();
        const liabilities = qty.liabilities.toNumber();

        if (assets > 0) {
          positions.push({
            protocol: 'marginfi',
            token: symbol,
            mint: bank.mint.toBase58(),
            type: 'deposit',
            amount: assets,
            valueUsd: usdValue.assets.toNumber(),
            apy: interestRates.lendingRate.toNumber(),
          });
        }

        if (liabilities > 0) {
          positions.push({
            protocol: 'marginfi',
            token: symbol,
            mint: bank.mint.toBase58(),
            type: 'borrow',
            amount: liabilities,
            valueUsd: usdValue.liabilities.toNumber(),
            apy: interestRates.borrowingRate.toNumber(),
            healthFactor,
          });
        }
      }
    }

    return positions;
  }

  async deposit(walletName: string, token: string, amount: number): Promise<LendWriteResult> {
    const meta = await this.resolveTokenStrict(token);
    const signer = await this.ctx.signer.getSigner(walletName);
    const client = await this.loadClient(signer.address);

    const bank = client.getBankByMint(new PublicKey(meta.mint));
    if (!bank) throw new Error(`No MarginFi bank for ${meta.symbol}`);

    const walletPubkey = new PublicKey(signer.address);
    let account = await this.getExistingAccount(client, walletPubkey);

    // First-time: create a MarginFi account in a separate tx
    if (!account) {
      this.ctx.logger.verbose('No MarginFi account — creating one...');
      const createIxs = await this.buildCreateAccountIxs(client);
      await this.deps.tx.buildAndSendTransaction(createIxs, signer, {
        txType: 'lend-create-account',
        walletName,
      });

      // Reload client and fetch the newly created account
      const refreshed = await this.loadClient(signer.address);
      account = await this.getExistingAccount(refreshed, walletPubkey);
      if (!account) throw new Error('Failed to create MarginFi account');
    }

    const ixResult = await account.makeDepositIx(amount, bank.address);
    const instructions = toV2Instructions(ixResult.instructions);

    const prices = await this.deps.price.getPrices([meta.mint]);
    const price = prices.get(meta.mint)?.priceUsd;
    const rawAmount = uiToTokenAmount(amount, meta.decimals).toString();

    const result = await this.deps.tx.buildAndSendTransaction(instructions, signer, {
      txType: 'lend-deposit',
      walletName,
      fromMint: meta.mint,
      fromAmount: rawAmount,
      fromPriceUsd: price,
    });

    return {
      signature: result.signature,
      protocol: 'marginfi',
      explorerUrl: result.explorerUrl,
    };
  }

  async withdraw(walletName: string, token: string, amount: number): Promise<LendWriteResult> {
    const meta = await this.resolveTokenStrict(token);
    const signer = await this.ctx.signer.getSigner(walletName);
    const client = await this.loadClient(signer.address);

    const bank = client.getBankByMint(new PublicKey(meta.mint));
    if (!bank) throw new Error(`No MarginFi bank for ${meta.symbol}`);

    const walletPubkey = new PublicKey(signer.address);
    const accounts = await client.getMarginfiAccountsForAuthority(walletPubkey);
    if (accounts.length === 0) throw new Error('No MarginFi account found');
    const account = accounts[0];

    // Crank Switchboard Pull oracles before withdraw (health check needs fresh prices)
    await this.sendOracleUpdateIfNeeded(account, [], walletName);

    const withdrawAll = !isFinite(amount);
    const ixResult = await account.makeWithdrawIx(
      withdrawAll ? 0 : amount,
      bank.address,
      withdrawAll,
    );
    const instructions = toV2Instructions(ixResult.instructions);

    const prices = await this.deps.price.getPrices([meta.mint]);
    const price = prices.get(meta.mint)?.priceUsd;
    const rawAmount = uiToTokenAmount(isFinite(amount) ? amount : 0, meta.decimals).toString();

    const result = await this.deps.tx.buildAndSendTransaction(instructions, signer, {
      txType: 'lend-withdraw',
      walletName,
      toMint: meta.mint,
      toAmount: rawAmount,
      toPriceUsd: price,
    });

    return {
      signature: result.signature,
      protocol: 'marginfi',
      explorerUrl: result.explorerUrl,
    };
  }

  async borrow(walletName: string, token: string, amount: number, _collateral: string): Promise<LendWriteResult> {
    const meta = await this.resolveTokenStrict(token);
    const signer = await this.ctx.signer.getSigner(walletName);
    const client = await this.loadClient(signer.address);

    const bank = client.getBankByMint(new PublicKey(meta.mint));
    if (!bank) throw new Error(`No MarginFi bank for ${meta.symbol}`);

    const walletPubkey = new PublicKey(signer.address);
    const accounts = await client.getMarginfiAccountsForAuthority(walletPubkey);
    if (accounts.length === 0) throw new Error('No MarginFi account found. Deposit collateral first.');
    const account = accounts[0];

    // Crank Switchboard Pull oracles before borrow (health check needs fresh prices)
    await this.sendOracleUpdateIfNeeded(account, [bank.address], walletName);

    const ixResult = await account.makeBorrowIx(amount, bank.address);
    const instructions = toV2Instructions(ixResult.instructions);

    const prices = await this.deps.price.getPrices([meta.mint]);
    const price = prices.get(meta.mint)?.priceUsd;
    const rawAmount = uiToTokenAmount(amount, meta.decimals).toString();

    const result = await this.deps.tx.buildAndSendTransaction(instructions, signer, {
      txType: 'lend-borrow',
      walletName,
      toMint: meta.mint,
      toAmount: rawAmount,
      toPriceUsd: price,
    });

    // Fetch health factor (best-effort)
    let healthFactor: number | undefined;
    try {
      const refreshed = await this.loadClient(signer.address);
      const accts = await refreshed.getMarginfiAccountsForAuthority(walletPubkey);
      if (accts.length > 0) healthFactor = this.computeHealthFactor(accts[0]);
    } catch { /* non-critical */ }

    return {
      signature: result.signature,
      protocol: 'marginfi',
      explorerUrl: result.explorerUrl,
      healthFactor,
    };
  }

  async repay(walletName: string, token: string, amount: number): Promise<LendWriteResult> {
    const meta = await this.resolveTokenStrict(token);
    const signer = await this.ctx.signer.getSigner(walletName);
    const client = await this.loadClient(signer.address);

    const bank = client.getBankByMint(new PublicKey(meta.mint));
    if (!bank) throw new Error(`No MarginFi bank for ${meta.symbol}`);

    const walletPubkey = new PublicKey(signer.address);
    const accounts = await client.getMarginfiAccountsForAuthority(walletPubkey);
    if (accounts.length === 0) throw new Error('No MarginFi account found');
    const account = accounts[0];

    const repayAll = !isFinite(amount);
    const ixResult = await account.makeRepayIx(
      repayAll ? 0 : amount,
      bank.address,
      repayAll,
    );
    const instructions = toV2Instructions(ixResult.instructions);

    const prices = await this.deps.price.getPrices([meta.mint]);
    const price = prices.get(meta.mint)?.priceUsd;
    const rawAmount = uiToTokenAmount(isFinite(amount) ? amount : 0, meta.decimals).toString();

    const result = await this.deps.tx.buildAndSendTransaction(instructions, signer, {
      txType: 'lend-repay',
      walletName,
      fromMint: meta.mint,
      fromAmount: rawAmount,
      fromPriceUsd: price,
    });

    // Fetch remaining debt (best-effort)
    let remainingDebt: number | undefined;
    try {
      const refreshed = await this.loadClient(signer.address);
      const accts = await refreshed.getMarginfiAccountsForAuthority(walletPubkey);
      if (accts.length > 0) {
        for (const bal of accts[0].activeBalances) {
          const b = client.getBankByPk(bal.bankPk);
          if (b && b.mint.toBase58() === meta.mint) {
            const qty = bal.computeQuantityUi(b);
            remainingDebt = qty.liabilities.toNumber();
            break;
          }
        }
      }
    } catch { /* non-critical */ }

    return {
      signature: result.signature,
      protocol: 'marginfi',
      explorerUrl: result.explorerUrl,
      remainingDebt,
    };
  }
}
