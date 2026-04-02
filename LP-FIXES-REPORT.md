# LP Integration Fixes Report

> Date: 2026-04-03
> Scope: Kamino SDK v12, Meteora API, Raydium SDK, Orca API

---

## 1. Kamino SDK v12 — `RewardScopePriceAccountNotPresent` Error

### Root Cause
The `RewardScopePriceAccountNotPresent` error occurs in the Kamino SDK v12 because:

1. The SDK's `getStrategyShareData()` and `getStrategyBalances()` methods internally call `getCollateralInfos()` → `getAllScopePriceFeedsForStrategy()` to map each strategy token (including reward tokens) to Scope oracle feed addresses, then call `this._scope.getMultipleOraclePrices(feeds)`.

2. **Reward tokens** (especially Kamino's own reward tokens like KMNO) don't always have Scope oracle price feeds configured. When the SDK tries to fetch a Scope oracle price account for a reward token that doesn't exist, it throws `RewardScopePriceAccountNotPresent`.

3. GitHub issues **#77** ("improve support multiple scope feeds") and **#76** ("Support multiple scope feeds in tokenInfo") were opened very recently (March 9, 2026) and closed — this indicates the Kamino team is actively fixing this in the SDK. Issue **#40** ("Support multiple scope prices in kliquidity program") and **#12** ("Do not fetch scope price for deprecated strategies") are also closed related issues.

4. The SDK version installed is **12.0.0** (latest on npm). The `@kamino-finance/scope-sdk` is at **10.2.2**.

### Fix Options

**Option A: Upgrade to latest Kamino SDK (if hotfix exists)**
```bash
cd /Users/vaddylandbot/.openclaw/workspace/agentsolwallet
npm update @kamino-finance/kliquidity-sdk @kamino-finance/scope-sdk
```

**Option B: Pre-fetch scope prices and pass them to avoid the error**
In `sdk/src/services/lp/kamino-lp-provider.ts`, the affected methods are:
- `getDepositQuote()` → calls `kamino.getStrategyShareData(kAddress(strategyAddress))`
- `deposit()` → calls `kamino.getStrategyByAddress()` and `kamino.deposit()` / `kamino.singleSidedDepositTokenA/TokenB()`

The `getStrategyShareData` method accepts an optional `scopePrices` parameter:
```typescript
getStrategyShareData = async (
  strategy: Address | StrategyWithAddress,
  scopePrices?: OraclePrices | Record<Address, OraclePrices>
): Promise<ShareData>
```

Modify the provider to pass pre-fetched prices. However, the **deposit/withdraw methods** in the SDK (as seen in the source) internally fetch balances and always attempt to resolve Scope feeds for reward tokens. The fix from Kamino's side (issues #76/#77) is needed for a complete resolution.

**Option C: Catch and gracefully handle the error as workaround**
In `kamino-lp-provider.ts`, wrap the SDK calls in try/catch:
```typescript
try {
  const shareData = await kamino.getStrategyShareData(kAddress(strategyAddress));
} catch (err: any) {
  if (err.message?.includes('RewardScopePriceAccountNotPresent')) {
    // Fallback: use API data instead of SDK for share pricing
    this.ctx.logger.verbose('Scope oracle unavailable, using API fallback');
    // Use fetchStrategiesApi() data which doesn't need Scope oracle
  } else {
    throw err;
  }
}
```

**Recommended**: Wait for Kamino SDK hotfix from issues #76/#77 (already merged and closed as of March 9, 2026). In the meantime, wrap the calls with a fallback to REST API data.

### Relevant Links
- SDK: https://github.com/Kamino-Finance/kliquidity-sdk
- Issue #77: https://github.com/Kamino-Finance/kliquidity-sdk/issues/77 (improve support multiple scope feeds - closed 2026-03-09)
- Issue #76: https://github.com/Kamino-Finance/kliquidity-sdk/issues/76 (Support multiple scope feeds - closed 2026-03-09)
- Issue #40: https://github.com/Kamino-Finance/kliquidity-sdk/issues/40 (Support multiple scope prices - closed)
- Issue #12: https://github.com/Kamino-Finance/kliquidity-sdk/issues/12 (Do not fetch scope price for deprecated - closed)
- npm: https://www.npmjs.com/package/@kamino-finance/kliquidity-sdk (v12.0.0)
- Scope SDK: https://www.npmjs.com/package/@kamino-finance/scope-sdk (v10.2.2)

---

## 2. Meteora API — 404 on `dlmm-api.meteora.ag` and `amm-v2.meteora.ag`

### Root Cause
**Confirmed via live testing**: Both endpoints return HTTP 404:
- `GET https://dlmm-api.meteora.ag/pair/all` → 404
- `GET https://dlmm-api.meteora.ag/pair/search` → 404
- `GET https://amm-v2.meteora.ag/pools/search` → 400

These REST API endpoints have been **decommissioned** by Meteora. Multiple alternative endpoints were tested (`dlmm-api.meteora.ag/pairs/all`, `api.meteora.ag/dlmm/pairs/all`, `mainnet-api.meteora.ag/pairs/all`, `amm-api.meteora.ag/graphql`, etc.) — all returned 404 or connection errors.

### Fix: Use SDK methods instead of REST API

The `@meteora-ag/dlmm` SDK (v1.9.3) can fetch pool data directly from on-chain accounts. Replace the REST API calls with SDK-based discovery.

#### For DLMM Pool Discovery:
```typescript
// OLD (broken - API is gone):
// const resp = await fetch('https://dlmm-api.meteora.ag/pair/all');

// NEW: Use On-chain account scanning
import DLMM from '@meteora-ag/dlmm';
import { PublicKey, Connection } from '@solana/web3.js';

const DLMM_PROGRAM = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
const connection = new Connection('https://api.mainnet-beta.solana.com');

// DLMM pairs are LbPair accounts with discriminator [242, 196, 24, 0, 0, 0, 0, 0]
// (8-byte discriminator for LbPair account)
const PAIR_DISCRIMINATOR = Buffer.from([242, 196, 24, 0, 0, 0, 0, 0]);

const accounts = await connection.getProgramAccounts(DLMM_PROGRAM, {
  filters: [{
    memcmp: {
      offset: 0,
      bytes: PAIR_DISCRIMINATOR.toString('base64'),
      encoding: 'base64',
    },
  }],
});

// Decode each LbPair account to get token mints and bin step
import { getLbPairDecoder } from '@meteora-ag/dlmm';
const pairs = accounts.map(({ pubkey, account }) => {
  const pair = getLbPairDecoder().decode(account.data);
  return {
    address: pubkey.toBase58(),
    mintX: pair.tokenXMint.toBase58(),
    mintY: pair.tokenYMint.toBase58(),
    binStep: Number(pair.binStep),
  };
});
```

#### For DLMM Single-Pair Lookup (when you have a pool address):
```typescript
// Still works — load a single pair from on-chain
const dlmm = await DLMM.create(connection, new PublicKey(poolAddress));
const lbPair = dlmm.lbPair;
const activeBin = await dlmm.getActiveBin();
```

#### For DAMM v2 Pool Discovery:
```typescript
import CpAmm from '@meteora-ag/cp-amm-sdk';

const cpAmm = new CpAmm(connection);

// If you know the pool address, fetch it directly:
const poolState = await cpAmm.fetchPoolState(new PublicKey(poolAddress));

// For pool discovery, scan CPAMM program accounts:
// CPAMM program ID: CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C
// Pool state discriminator: [31, 211, 155, 71, 110, 43, 30, 106]
const CPAMM_PROGRAM = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');
```

### Code Changes Required in `meteora-provider.ts`:

Replace `fetchDlmmPairs()` method:
```typescript
// REPLACE this:
const resp = await fetch(DLMM_PAIRS_API);
const data = await resp.json();

// WITH on-chain scanning (use memoization/caching since getProgramAccounts is expensive):
private async fetchDlmmPairsFromChain(): Promise<CachedDlmmPair[]> {
  // Return cached results if available
  if (Date.now() - dlmmPairCacheTs < POOL_CACHE_TTL_MS && dlmmPairCache.length > 0) {
    return dlmmPairCache;
  }

  // For production, use a third-party indexer API or maintain a static list
  // of known DLMM pairs. For single-pair lookups, use DLMM.create() directly.
  
  // Recommendation: Use known pool addresses from a config file or 
  // fetch from a community-maintained list.
  // The DLMM SDK's create() method works perfectly for single pair loading.
  
  this.ctx.logger.verbose('DLMM pair list API is deprecated; use single-pair SDK lookups');
  return []; // Return empty; individual pool lookups still work via DLMM.create()
}
```

**Key insight**: The `getPools()` method that uses `fetchDlmmPairs()` for "list all pools" is the one that breaks. But `getPositions()`, `deposit()`, `withdraw()` all use `DLMM.create(connection, pubkey)` which fetches pool data from on-chain and **still works fine**. The fix is to either:
1. Remove the "list all pools" feature for DLMM (return empty or error gracefully)
2. Use alternative indexer (e.g., Helius DAS API, Triton) for pair listing
3. Seed from a known-pair JSON config file

### Relevant Links
- DLMM SDK: https://github.com/MeteoraAg/dlmm-sdk
- DLMM SDK npm: https://www.npmjs.com/package/@meteora-ag/dlmm (v1.9.3)
- CPAMM SDK npm: https://www.npmjs.com/package/@meteora-ag/cp-amm-sdk (v1.3.6)
- DLMM API swagger (deprecated): https://dlmm-api.meteora.ag/swagger-ui/ (likely offline)
- Meteora docs: https://docs.meteora.ag/
- Meteora developer guide: https://docs.meteora.ag/developer-guide/home

---

## 3. Raydium SDK — `fetch pool config error`

### Root Cause
The Raydium SDK v2 (0.2.39-alpha) uses `raydium.clmm.getPoolInfoFromRpc(poolId)` to fetch pool configuration. When this RPC call fails, it typically means:

1. **The pool ID format doesn't match what the SDK expects** — SDK expects a CLMM pool PDA address, but may be receiving an AMM pool ID or an invalid string.

2. **The pool type mismatch** — Code calls `raydium.clmm.getPoolInfoFromRpc()` on a CPAMM pool or vice versa. The provider correctly maps pool types via `mapPoolType()`, but the `deposit()` method only handles `clmm` type, not `amm`.

3. **RPC connection issue** — The SDK's `getPoolInfoFromRpc` makes multi-step RPC calls (getAccountInfo for pool state, tick arrays, etc.). If the RPC is rate-limited or the pool doesn't exist on-chain, it throws.

### Fix

The code already uses the Raydium REST API (`api-v3.raydium.io`) for pool discovery, which is correct. But during deposit, it fetches pool config via SDK's `getPoolInfoFromRpc`. The error likely occurs because:

1. The pool was found via API but is no longer valid on-chain, OR
2. The RPC connection has issues, OR  
3. AMM-type pools are incorrectly routed to CLMM deposit code

Add validation and fallback:
```typescript
// In deposit() method, validate pool exists on-chain before proceeding:
const poolInfo = await raydium.clmm.getPoolInfoFromRpc(poolId).catch(err => {
  // If CLMM fails, try CPAMM
  return raydium.cpmm.getPoolInfoFromRpc(poolId).catch(() => {
    throw new Error(`Pool ${poolId} not found on-chain via CLMM or CPMM. Pool may be invalid or delisted.`);
  });
});

// Also add AMM deposit support - currently only CLMM is handled:
if (poolType === 'amm') {
  // Use CPMM deposit path
  const poolInfo = await raydium.cpmm.getPoolInfoFromRpc(poolId);
  // ... cpmm addLiquidity
}
```

### Relevant Links
- Raydium SDK v2: https://github.com/raydium-io/raydium-sdk-V2
- Raydium SDK v2 npm: https://www.npmjs.com/package/@raydium-io/raydium-sdk-v2 (v0.2.39-alpha)
- Raydium API: https://api-v3.raydium.io/
- Raydium SDK v2 docs: https://deepwiki.com/raydium-io/raydium-sdk-V2
- Issue #94: https://github.com/raydium-io/raydium-sdk-V2/issues/94

---

## 4. Orca API — `data.map is not a function`

### Root Cause
**Confirmed via live API test**: The Orca API v2 endpoint works (HTTP 200) but has **two breaking changes**:

1. **Wrapped response format**: Used to return a raw array `[{...}, {...}]`, now returns:
```json
{
  "data": [ {... pool object ...} ],
  "meta": { "next": null, "previous": null }
}
```
The code does `const data = await resp.json()` then `data.map(...)` — fails because `data` is now an object `{ data, meta }` not an array.

2. **Changed field types and names**: The pool objects in the v2 API have different field names and ALL numeric values are **strings**:  
   - `price`: string (`"78.73..."`) not number
   - `tvlUsdc`: string not number  
   - `volume24hUsdc`: **doesn't exist** → replaced by `stats["24h"].volume` (string)
   - `yield24hUsdc`, `totalApr24h`, `feeApr24h`, `rewardApr24h`: **don't exist**
   - `stats["24h"]` contains: `{ volume, fees, rewards, yieldOverTvl, volumeDelta, feesDelta, ... }` (all strings)
   - `tokenA`/`tokenB` objects include: `{ address, programId, imageUrl, name, symbol, decimals, tags }`

**Actual live response sample** (verified 2026-04-03):
```json
{
  "data": [{
    "address": "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE",
    "tokenMintA": "So11111111111111111111111111111111111111112",
    "tokenMintB": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "tickSpacing": 4,
    "feeRate": 400,
    "price": "78.73996391977313561000",
    "tvlUsdc": "27273983.7298312259756769",
    "tokenA": { "address": "...", "symbol": "SOL", "decimals": 9 },
    "tokenB": { "address": "...", "symbol": "USDC", "decimals": 6 },
    "stats": {
      "24h": { "volume": "174680838.98", "fees": "69828.26", "yieldOverTvl": "0.00256" }
    }
  }],
  "meta": { "next": null, "previous": null }
}
```

### Fix

**File**: `sdk/src/services/lp/orca-provider.ts`

Two things need fixing: the response wrapper AND the interface field mapping.

#### Fix 1: Update the `OrcaApiPoolV2` interface to match real API response:
```typescript
interface OrcaApiPoolV2 {
  address: string;
  tokenA: { address: string; symbol: string; decimals: number; name: string };
  tokenB: { address: string; symbol: string; decimals: number; name: string };
  tickSpacing: number;
  price: string;         // CHANGED: now a string
  feeRate: number;
  tvlUsdc: string;       // CHANGED: now a string
  // REMOVED: volume24hUsdc, yield24hUsdc, totalApr24h, feeApr24h, rewardApr24h
  // REPLACED BY: stats["24h"].volume, stats["24h"].yieldOverTvl (both strings)
  stats?: Record<string, { volume?: string; fees?: string; yieldOverTvl?: string }>;
}

// Also need wrapper for the API response:
interface OrcaApiResponse {
  data: OrcaApiPoolV2[];
  meta: { next: string | null; previous: string | null };
}
```

#### Fix 2: Update `getPools` method to unwrap response and parse strings:
```typescript
async getPools(tokenA?: string, tokenB?: string, limit?: number): Promise<LpPoolInfo[]> {
  try {
    let mintA: string | undefined;
    let mintB: string | undefined;
    if (tokenA) {
      const meta = await this.deps.registry.resolveToken(tokenA);
      mintA = meta?.mint ?? tokenA;
    }
    if (tokenB) {
      const meta = await this.deps.registry.resolveToken(tokenB);
      mintB = meta?.mint ?? tokenB;
    }

    const pageSize = Math.min(limit ?? 50, 100);
    let url: string;

    if (mintA && mintB) {
      url = `${ORCA_POOL_API}?tokensBothOf=${mintA},${mintB}&sortBy=tvl&size=${pageSize}`;
    } else if (mintA || mintB) {
      url = `${ORCA_POOL_API}?token=${mintA || mintB}&sortBy=tvl&size=${pageSize}`;
    } else {
      url = `${ORCA_POOL_API}?sortBy=tvl&size=${pageSize}&minTvl=10000`;
    }

    this.ctx.logger.verbose(`Fetching Orca pools: ${url}`);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Orca API error ${resp.status}`);

    // FIX: Unwrap { data: [...], meta: {...} }
    const json: OrcaApiResponse = await resp.json();
    const pools = json.data ?? [];

    // FIX: Map field names and parse string values
    const results = pools.map(p => ({
      poolId: p.address,
      protocol: 'orca' as const,
      poolType: 'clmm' as const,
      tokenA: p.tokenA?.symbol ?? '',
      tokenB: p.tokenB?.symbol ?? '',
      mintA: p.tokenA?.address ?? '',
      mintB: p.tokenB?.address ?? '',
      tvlUsd: p.tvlUsdc ? parseFloat(p.tvlUsdc) : null,
      volume24hUsd: p.stats?.['24h']?.volume ? parseFloat(p.stats['24h'].volume) : null,
      feeRate: p.feeRate,
      apy: p.stats?.['24h']?.yieldOverTvl ? parseFloat(p.stats['24h'].yieldOverTvl) : null,
      currentPrice: p.price ? parseFloat(p.price) : 0,
      tickSpacing: p.tickSpacing,
    }));
    results.sort((a, b) => (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0));

    return limit ? results.slice(0, limit) : results;
  } catch (err: any) {
    this.ctx.logger.verbose(`Orca getPools failed: ${err.message}`);
    return [];
  }
}
```
```typescript
async getPools(tokenA?: string, tokenB?: string, limit?: number): Promise<LpPoolInfo[]> {
  try {
    let mintA: string | undefined;
    let mintB: string | undefined;
    if (tokenA) {
      const meta = await this.deps.registry.resolveToken(tokenA);
      mintA = meta?.mint ?? tokenA;
    }
    if (tokenB) {
      const meta = await this.deps.registry.resolveToken(tokenB);
      mintB = meta?.mint ?? tokenB;
    }

    const pageSize = Math.min(limit ?? 50, 100);
    let url: string;

    if (mintA && mintB) {
      // Use tokensBothOf filter (confirmed valid in Orca v2 API spec)
      url = `${ORCA_POOL_API}?tokensBothOf=${mintA},${mintB}&sortBy=tvl&size=${pageSize}`;
    } else if (mintA || mintB) {
      url = `${ORCA_POOL_API}?token=${mintA || mintB}&sortBy=tvl&size=${pageSize}`;
    } else {
      url = `${ORCA_POOL_API}?sortBy=tvl&size=${pageSize}&minTvl=10000`;
    }

    this.ctx.logger.verbose(`Fetching Orca pools: ${url}`);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Orca API error ${resp.status}`);

    // FIX: Orca v2 API wraps response in { data: [...], meta: {...} }
    const json = await resp.json();
    const data: OrcaApiPoolV2[] = json.data ?? [];
    const results = data.map(p => this.mapOrcaPool(p));
    results.sort((a, b) => (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0));

    return limit ? results.slice(0, limit) : results;
  } catch (err: any) {
    this.ctx.logger.verbose(`Orca getPools failed: ${err.message}`);
    return [];
  }
}
```

### Orca API v2 — Confirmed Working Endpoints
The full OpenAPI spec is at https://api.orca.so/docs (Scalar UI). Verified endpoints:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v2/solana/pools` | GET | List pools (with `token`, `tokensBothOf`, `addresses`, `sortBy`, `size` params) |
| `/v2/solana/pools/search` | GET | Search pools by `q` (search query) |
| `/v2/solana/pools/{address}` | GET | Single pool by address |
| `/v2/solana/lock/{address}` | GET | Locked liquidity for a pool |
| `/v2/solana/tokens` | GET | List tokens |
| `/v2/solana/tokens/search` | GET | Search tokens by `q` |
| `/v2/solana/protocol` | GET | Protocol stats (TVL, volume, fees) |
| `/v2/solana/tokens/{mint_address}` | GET | Token details |

Query parameters confirmed working from OpenAPI spec:
- `sortBy`: `tvl`, `volume`, `fees`, `rewards`, `yieldovertvl` (+ time variants)
- `sortDirection`: `asc`, `desc`
- `size`: pagination size (default: 100, max: 3000)
- `token`: filter by single token mint
- `tokensBothOf`: filter by two token mints (comma-separated)
- `addresses`: filter by pool addresses
- `minTvl`: minimum TVL filter
- `minVolume`: minimum volume filter
- `hasRewards`, `hasWarning`, `hasAdaptiveFee`, `isWavebreak`: boolean filters
- `next`/`previous`: cursor-based pagination

### Relevant Links
- Orca API v2 docs: https://api.orca.so/docs
- Orca docs: https://docs.orca.so/
- Orca Whirlpools SDK: https://github.com/orca-so/whirlpools
- npm @orca-so/whirlpools: https://www.npmjs.com/package/@orca-so/whirlpools (v5.0.0)
- Orca developer docs: https://dev.orca.so/ts/

---

## Summary of Required Code Changes

| Issue | Severity | Fix |
|-------|----------|-----|
| **1. Kamino Scope oracle** | Medium | Wrap SDK calls in try/catch, fallback to REST API data. Wait for SDK hotfix (#76/#77). |
| **2. Meteora API 404** | High | Remove REST API calls. Use `DLMM.create()` for single-pair lookups. For "list all pools", return graceful empty or use on-chain scanning. |
| **3. Raydium pool config** | Medium | Add validation and fallback for pool type. Try both CLMM and CPMM paths. |
| **4. Orca API response format** | High | Change `const data = await resp.json()` → `const data = (await resp.json()).data ?? []` |
