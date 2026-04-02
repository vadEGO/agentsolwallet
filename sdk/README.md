# @agentsolwallet/sdk

Solana SDK for building apps with Jupiter, Kamino, MarginFi, Drift, Loopscale, and more. Extracted from the [Sol CLI](https://github.com/SolanaGuide/solana-cli) so websites, bots, and other consumers can reuse the same integrations without dragging in Commander, SQLite, or filesystem dependencies.

## Install

```bash
npm install @agentsolwallet/sdk @solana/kit
```

Optional peer dependencies for DeFi protocol support:

```bash
# Kamino lending & earn vaults
npm install @kamino-finance/klend-sdk @coral-xyz/anchor

# MarginFi lending
npm install @mrgnlabs/marginfi-client-v2

# Drift lending
npm install @drift-labs/sdk
```

If these aren't installed, those providers are silently skipped.

## Quick Start

```ts
import { createSolSdk, registerDefaultProviders, InMemoryConfig } from '@agentsolwallet/sdk';
import { createSolanaRpc } from '@solana/kit';

const rpc = createSolanaRpc('https://api.mainnet-beta.solana.com');

const sdk = createSolSdk({
  rpc,
  rpcUrl: 'https://api.mainnet-beta.solana.com', // needed for v1 compat providers
  signer: {
    getSigner: async (id) => walletAdapter, // your TransactionSigner
    getAddress: async (id) => walletAdapter.address,
  },
});

// Register DeFi providers (Kamino, MarginFi, Drift, Jupiter Lend, Loopscale)
await registerDefaultProviders(sdk);

// Read-only — works immediately
const prices = await sdk.price.getPrices(['So11111111111111111111111111111111']);
const rates = await sdk.lend.getRates(['SOL', 'USDC']);
const quote = await sdk.swap.getQuote('SOL', 'USDC', 1.0);

// Write — wallet signs the transaction
const result = await sdk.swap.executeSwap('SOL', 'USDC', 1.0, 'main');

// Portfolio
const report = await sdk.portfolio.get([
  { name: 'main', address: 'YourWa11etAddress...' },
]);
```

## Architecture

The SDK uses context-based dependency injection. Every service closes over a `SolContext` that carries pluggable implementations for logging, caching, config, signing, and transaction logging.

```
Your App                              Sol CLI
┌─────────────────────┐     ┌──────────────────────────┐
│ WalletAdapter signer │     │ FileSigner (key files)    │
│ InMemoryCache        │     │ SqliteCache (repos)       │
│ NoopLogger           │     │ CliLogger (verbose/warn)  │
│ NoopTransactionLogger│     │ SqliteTxLogger (tx_log)   │
└──────────┬──────────┘     │ TomlConfig (config.toml)  │
           │                └──────────┬───────────────┘
           ▼                           ▼
    ┌─────────────────────────────────────┐
    │  @agentsolwallet/sdk              │
    │  createSolSdk(opts) → SolSdk        │
    │  price, swap, stake, lend, earn,    │
    │  orders, predict, portfolio, x402   │
    └─────────────────────────────────────┘
```

### SolSdk Interface

```ts
interface SolSdk {
  price:     PriceService;
  token:     TokenService;
  registry:  TokenRegistryService;
  lists:     TokenListsService;
  swap:      SwapService;
  stake:     StakeService;
  lend:      LendService;
  earn:      EarnService;
  order:     OrderService;
  predict:   PredictService;
  portfolio: PortfolioService;
  x402:      X402Service;
  onramp:    OnrampService;
  tx:        TransactionService;
  ctx:       SolContext;
}
```

## DI Interfaces

### SolSdkOptions

```ts
interface SolSdkOptions {
  rpc: Rpc<SolanaRpcApi>;
  rpcUrl?: string;                           // needed by v1 compat (MarginFi, Drift)
  logger?: Logger;                           // defaults to NoopLogger
  config?: ConfigProvider;                   // defaults to InMemoryConfig({})
  cache?: CacheProvider;                     // defaults to InMemoryCache
  txLogger?: TransactionLogger;              // defaults to NoopTransactionLogger
  signer: SignerProvider;                    // required
  analyticsInstruction?: () => Instruction | null;
}
```

### Logger

```ts
interface Logger {
  verbose(msg: string): void;
  warn(msg: string): void;
}
```

### ConfigProvider

```ts
interface ConfigProvider {
  get(key: string): unknown;  // supports dot-notation: 'api.jupiterApiKey'
}
```

Config keys used by the SDK:

| Key | Type | Description |
|-----|------|-------------|
| `api.jupiterApiKey` | `string` | Jupiter API key (optional, falls back to lite API) |
| `api.jupiterBaseUrl` | `string` | Proxy URL for Jupiter API calls |
| `api.dflowApiKey` | `string` | DFlow router API key |
| `api.dflowBaseUrl` | `string` | Proxy URL for DFlow API calls |
| `api.loopscaleBaseUrl` | `string` | Proxy URL for Loopscale API calls |
| `api.coingeckoApiKey` | `string` | CoinGecko API key (price fallback) |
| `defaults.router` | `string` | Default swap router (`best`, `jupiter`, `dflow`) |
| `defaults.validator` | `string` | Default staking validator vote account |
| `defaults.slippage` | `number` | Default swap slippage in basis points |
| `lend.defaultProtocol` | `string` | Default lending protocol |
| `earn.defaultProtocol` | `string` | Default earn protocol |
| `predict.defaultProvider` | `string` | Default prediction market provider |

### CacheProvider

```ts
interface CacheProvider {
  // Price cache
  getLatestPrice(mint: string): PriceCacheEntry | undefined;
  insertPrice(mint: string, priceUsd: number, source: string): void;

  // Token cache
  getTokenByMint(mint: string): TokenCacheEntry | undefined;
  getTokenBySymbol(symbol: string): TokenCacheEntry[];
  isTokenCacheStale(mint: string, ttlHours?: number): boolean;
  upsertTokenBatch(tokens: TokenUpsert[]): void;

  // Optional — token lists
  getTokenList?(category: string, interval: string | null): TokenListCacheRow[];
  replaceTokenList?(category: string, interval: string | null, entries: TokenListCacheRow[]): void;
  isTokenListStale?(category: string, interval: string | null, ttlMinutes: number): boolean;

  // Optional — snapshots
  createSnapshot?(label?: string): number;
  insertSnapshotEntry?(entry: SnapshotEntryRow): void;
  getSnapshotEntries?(snapshotId: number): SnapshotEntryRow[];
  getSnapshot?(id: number): SnapshotRow | undefined;
  getLatestSnapshot?(): SnapshotRow | undefined;
  listSnapshots?(limit: number): SnapshotRow[];
}
```

### SignerProvider

```ts
interface SignerProvider {
  getSigner(identifier: string): Promise<TransactionSigner>;
  getAddress(identifier: string): Promise<string>;
  getRawBytes?(identifier: string): Uint8Array;  // v1 compat (MarginFi oracle crank)
}
```

The `identifier` is whatever your app uses to distinguish wallets. The CLI uses wallet names (e.g. `"main"`), but you can use addresses, indexes, or anything.

### TransactionLogger

```ts
interface TransactionLogger {
  log(entry: TxLogEntry): void;
  updateStatus(signature: string, status: string, error?: string): void;
}

interface TxLogEntry {
  signature: string;
  type: string;
  walletName?: string;
  fromMint?: string;
  toMint?: string;
  fromAmount?: string;
  toAmount?: string;
  fromPriceUsd?: number;
  toPriceUsd?: number;
  status: string;
  error?: string;
}
```

## Default Implementations

The SDK ships with zero-dependency defaults so you can get started without implementing every interface:

```ts
import {
  NoopLogger,              // verbose/warn are no-ops
  NoopTransactionLogger,   // log/updateStatus are no-ops
  InMemoryConfig,          // wraps a plain object, dot-notation get
  InMemoryCache,           // Map-based price + token cache
} from '@agentsolwallet/sdk';

// Pass a config object with dot-separated keys
const config = new InMemoryConfig({
  'api.jupiterBaseUrl': 'https://mysite.com/api/jupiter',
  'defaults.slippage': 100,
});
config.get('api.jupiterBaseUrl'); // 'https://mysite.com/api/jupiter'
config.get('defaults.slippage');  // 100
```

## Service Reference

### Price

```ts
sdk.price.getPrices(mints: string[]): Promise<Map<string, PriceResult>>
sdk.price.getPrice(mint: string): Promise<PriceResult | undefined>
sdk.price.getCachedPrice(mint: string): PriceResult | undefined
```

Fetches USD prices via Jupiter Price API with CoinGecko fallback. Results are cached.

```ts
import { SOL_MINT } from '@agentsolwallet/sdk';

const prices = await sdk.price.getPrices([SOL_MINT]);
const solPrice = prices.get(SOL_MINT);
console.log(solPrice?.priceUsd); // 150.42
```

### Token

```ts
sdk.token.getSolBalance(addr: string): Promise<number>
sdk.token.getTokenBalances(walletAddress: string): Promise<TokenBalance[]>
sdk.token.getAllTokenAccounts(walletAddress: string): Promise<TokenAccountInfo[]>
```

```ts
interface TokenBalance {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  balance: string;     // raw lamport/token amount
  uiBalance: number;   // human-readable
}
```

### Token Registry

```ts
sdk.registry.resolveToken(symbolOrMint: string): Promise<TokenMetadata | undefined>
sdk.registry.resolveTokens(queries: string[]): Promise<Map<string, TokenMetadata>>
sdk.registry.syncTokenCache(): Promise<number>
```

Resolves token symbols (e.g. `"SOL"`, `"USDC"`) or mint addresses to full metadata. Uses a well-known token list first, then falls back to Jupiter's token API.

```ts
const sol = await sdk.registry.resolveToken('SOL');
console.log(sol?.mint);     // 'So11111111111111111111111111111111'
console.log(sol?.decimals); // 9
```

### Token Lists

```ts
sdk.lists.getCategories(): CategoryInfo[]
sdk.lists.browseTokens(category: string, opts?: {
  interval?: string;
  limit?: number;
}): Promise<TokenListEntry[]>
```

Browse curated token lists (trending, new, top volume, etc.) from the Jupiter Token API.

### Swap

```ts
sdk.swap.getQuote(
  inputSymbol: string,
  outputSymbol: string,
  amount: number,
  opts?: { slippageBps?: number; router?: string },
): Promise<SwapQuote>

sdk.swap.executeSwap(
  inputSymbol: string,
  outputSymbol: string,
  amount: number,
  walletName: string,
  opts?: { slippageBps?: number; skipPreflight?: boolean; router?: string },
): Promise<SwapResult>
```

Uses a pluggable router system. The default `best` router queries Jupiter and DFlow in parallel and picks the best quote. Force a specific router with `opts.router`.

```ts
// Quote only
const quote = await sdk.swap.getQuote('SOL', 'USDC', 1.0);
console.log(`${quote.inputUiAmount} ${quote.inputSymbol} → ${quote.outputUiAmount} ${quote.outputSymbol}`);

// Execute
const result = await sdk.swap.executeSwap('SOL', 'USDC', 1.0, 'main');
console.log(result.explorerUrl);
```

### Stake

```ts
sdk.stake.getStakeAccounts(walletAddress: string): Promise<StakeAccountInfo[]>

sdk.stake.createAndDelegateStake(
  walletName: string,
  amountSol: number,
  validatorVote?: string,        // defaults to recommended validator
): Promise<CreateStakeResult>

sdk.stake.withdrawStake(
  walletName: string,
  stakeAccountAddress: string,
  amountSol?: number,            // partial withdraw
  force?: boolean,               // deactivate if still active
): Promise<WithdrawStakeResult>

sdk.stake.claimMev(
  walletName: string,
  walletAddress: string,
  stakeAccountAddress?: string,  // specific account, or all
  withdrawOnly?: boolean,        // withdraw instead of compound
): Promise<ClaimMevResult[]>
```

Native Solana staking. Creates stake account, funds it, and delegates — all in a single transaction.

### Lend

```ts
sdk.lend.getRates(tokens?: string[], protocol?: string): Promise<RatesResult>
sdk.lend.getPositions(walletAddress: string, protocol?: string): Promise<LendingPosition[]>
sdk.lend.deposit(walletName: string, token: string, amount: number, protocol?: string): Promise<LendWriteResult>
sdk.lend.withdraw(walletName: string, token: string, amount: number, protocol?: string): Promise<LendWriteResult>
sdk.lend.borrow(walletName: string, token: string, amount: number, collateral: string, protocol?: string): Promise<LendWriteResult>
sdk.lend.repay(walletName: string, token: string, amount: number, protocol?: string): Promise<LendWriteResult>
sdk.lend.registerProvider(provider: LendProvider): void
```

Multi-protocol lending across Kamino, MarginFi, Drift, Jupiter Lend, and Loopscale. Reads query all providers in parallel. Writes target a specific protocol (or the config default).

```ts
interface LendingRate {
  protocol: string;
  token: string;
  mint: string;
  depositApy: number;
  borrowApy: number;
  totalDeposited: number;
  totalBorrowed: number;
  utilizationPct: number;
}

interface LendingPosition {
  protocol: string;
  token: string;
  mint: string;
  type: 'deposit' | 'borrow';
  amount: number;
  valueUsd: number;
  apy: number;
  healthFactor?: number;
}
```

### Earn

```ts
sdk.earn.getVaults(tokens?: string[], protocol?: string, sort?: 'apy' | 'tvl'): Promise<VaultsResult>
sdk.earn.getPositions(walletAddress: string, protocol?: string): Promise<EarnPosition[]>
sdk.earn.deposit(walletName: string, token: string, amount: number, protocol?: string, vaultId?: string): Promise<EarnWriteResult>
sdk.earn.withdraw(walletName: string, token: string, amount: number, protocol?: string): Promise<EarnWriteResult>
sdk.earn.registerProvider(provider: EarnProvider): void
```

Yield vaults across Kamino and Loopscale. Same multi-provider pattern as lend.

### Orders (DCA & Limit)

```ts
sdk.order.createDca(
  totalAmount: number, inputSymbol: string, outputSymbol: string,
  walletName: string, opts: { interval: string; count: number },
): Promise<DcaCreateResult>
sdk.order.listDca(walletAddress: string, opts?: { status?: string }): Promise<DcaOrder[]>
sdk.order.cancelDca(orderKey: string, walletName: string): Promise<string>

sdk.order.createLimit(
  inputAmount: number, inputSymbol: string, outputSymbol: string,
  walletName: string, opts: { targetPrice: number; slippageBps?: number; expiredAt?: number },
): Promise<LimitCreateResult>
sdk.order.listLimit(walletAddress: string, opts?: { status?: string }): Promise<LimitOrder[]>
sdk.order.cancelLimit(orderKey: string, walletName: string): Promise<string>

sdk.order.getOpenOrders(walletAddress: string): Promise<OpenOrderPosition[]>
```

DCA and limit orders via Jupiter's Recurring and Trigger APIs.

### Predict (Prediction Markets)

```ts
sdk.predict.listEvents(opts?): Promise<PredictionEvent[]>
sdk.predict.searchEvents(query: string, limit?: number): Promise<PredictionEvent[]>
sdk.predict.getEvent(eventId: string): Promise<PredictionEvent>
sdk.predict.getMarket(marketId: string): Promise<PredictionMarket>
sdk.predict.getOrderbook(marketId: string): Promise<PredictionOrderbook | null>
sdk.predict.buy(walletName: string, marketId: string, isYes: boolean, amountUsd: number, maxPrice?: number): Promise<PredictionOrderResult>
sdk.predict.sell(walletName: string, positionPubkey: string, minPrice?: number): Promise<PredictionCloseResult>
sdk.predict.claim(walletName: string, positionPubkey: string): Promise<PredictionClaimResult>
sdk.predict.getPositions(walletAddress: string): Promise<PredictionPosition[]>
sdk.predict.getHistory(walletAddress: string, limit?: number): Promise<PredictionHistoryEntry[]>
sdk.predict.registerProvider(provider: PredictProvider): void
```

### Portfolio

```ts
sdk.portfolio.get(wallets: { name: string; address: string }[]): Promise<PortfolioReport>
sdk.portfolio.takeSnapshot(wallets: { name: string; address: string }[], label?: string): Promise<SnapshotResult>
sdk.portfolio.autoSnapshot(report: PortfolioReport): Promise<boolean>
sdk.portfolio.compareToSnapshot(wallets: { name: string; address: string }[], snapshotId?: number): Promise<CompareResult>
sdk.portfolio.getPnl(wallets: { name: string; address: string }[], sinceId?: number): Promise<CompareResult>
```

Aggregates positions across all services (tokens, staking, lending, earn, orders, prediction markets) into a unified view. Snapshots and P&L require the optional `CacheProvider` snapshot methods.

```ts
interface PortfolioReport {
  wallets: { name: string; address: string }[];
  positions: PortfolioPosition[];
  allocation: AllocationEntry[];
  totalValueUsd: number;
  claimableMev: number;
  lastSnapshot?: { id: number; label?: string; ago: string };
}
```

### X402 (Pay-Per-Request)

```ts
sdk.x402.fetch(url: string, opts?: X402FetchOptions): Promise<X402FetchResult>
```

HTTP client for the [x402 payment protocol](https://www.x402.org/). Automatically detects `402 Payment Required` responses, pays via USDC transfer, and retries with proof of payment.

### Onramp

```ts
sdk.onramp.getUrl(params: {
  walletAddress: string;
  amount?: number;
  currency?: string;
  provider?: string;
}): string
sdk.onramp.listProviders(): string[]
```

Generates fiat onramp URLs for purchasing SOL.

### Transaction

```ts
sdk.tx.buildAndSendTransaction(
  instructions: Instruction[],
  payer: TransactionSigner,
  opts?: BuildAndSendOpts,
): Promise<SendResult>

sdk.tx.sendEncodedTransaction(
  encodedTx: string,
  opts?: SendEncodedOpts,
): Promise<SendResult>
```

Handles blockhash fetching, signing, encoding, sending, confirmation polling, and retry with error classification. All write services use this internally.

```ts
interface SendResult {
  signature: string;
  status: string;
  attempts: number;
  elapsed_ms: number;
  explorerUrl: string;
}
```

Also exported as standalone utilities:

```ts
import { classifyError, ErrorClass, injectSigners } from '@agentsolwallet/sdk';

classifyError(err); // ErrorClass.RETRYABLE_TRANSIENT | TERMINAL_PROGRAM | etc.
injectSigners(instructions, [signer]); // attach signers to instruction accounts
```

## Utilities

Pure functions re-exported from the SDK:

```ts
import {
  // Solana helpers
  isValidAddress, lamportsToSol, solToLamports, uiToTokenAmount,
  tokenAmountToUi, shortenAddress, explorerUrl, SOL_MINT, SOL_DECIMALS,

  // Token list
  WELL_KNOWN_TOKENS, getWellKnownBySymbol, getWellKnownByMint,

  // Formatting
  fmtPrice, timed,

  // Retry / rate limiting
  withRetry, RateLimiter, isRetryableHttpError,

  // Constants
  AGENTSOLWALLET_VOTE,
  PROTOCOL_NAMES,         // lend protocol names
  EARN_PROTOCOL_NAMES,    // earn protocol names
  PREDICT_CATEGORIES,     // prediction market categories
  parseInterval,          // 'day' → seconds

  // Compat layers (for v1 SDK bridging)
  getKaminoRpc, kAddress, kSigner, getCurrentSlot,
  getMarginFiV1Connection, MarginFiDummyWallet,
  getDriftV1Connection, DriftDummyWallet,
} from '@agentsolwallet/sdk';
```

## API Proxy Support

For browser apps, you'll want to keep API keys server-side. The SDK supports URL overrides for all external APIs:

```ts
const sdk = createSolSdk({
  rpc,
  signer: { ... },
  config: new InMemoryConfig({
    'api.jupiterBaseUrl': 'https://mysite.com/api/jupiter',
    'api.dflowBaseUrl': 'https://mysite.com/api/dflow',
    'api.loopscaleBaseUrl': 'https://mysite.com/api/loopscale',
  }),
});
```

When a base URL is set, all API calls for that service go through your proxy. Your proxy adds the API key server-side so it never appears in client code.

## Custom Providers

Register your own lend, earn, or predict providers:

```ts
import type { LendProvider, EarnProvider, PredictProvider } from '@agentsolwallet/sdk';

class MyLendProvider implements LendProvider {
  name = 'my-protocol';
  capabilities = { deposit: true, withdraw: true, borrow: false, repay: false };
  async getRates(tokens?) { ... }
  async getPositions(walletAddress) { ... }
  async deposit(walletName, token, amount) { ... }
  async withdraw(walletName, token, amount) { ... }
}

sdk.lend.registerProvider(new MyLendProvider());
```

## License

MIT
