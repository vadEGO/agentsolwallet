import { withRetry, isRetryableHttpError, RateLimiter } from '../utils/retry.js';
import { verbose } from '../output/formatter.js';
import { resolveToken } from './token-registry.js';
import { uiToTokenAmount, explorerUrl } from '../utils/solana.js';
import { loadSigner } from './wallet-manager.js';
import { getTransactionDecoder, getBase64EncodedWireTransaction } from '@solana/transactions';
import { sendEncodedTransaction } from './transaction.js';

const JUPITER_API = 'https://lite-api.jup.ag/swap/v1';
const jupiterLimiter = new RateLimiter(30, 60_000);

export interface SwapQuote {
  inputMint: string;
  outputMint: string;
  inputAmount: string;
  outputAmount: string;
  inputSymbol: string;
  outputSymbol: string;
  inputUiAmount: number;
  outputUiAmount: number;
  priceImpactPct: number;
  slippageBps: number;
  routePlan: string;
  platformFee?: string;
  // Raw Jupiter response kept for the swap endpoint
  _raw: any;
}

export interface SwapResult {
  signature: string;
  inputSymbol: string;
  outputSymbol: string;
  inputAmount: number;
  outputAmount: number;
  explorerUrl: string;
}

export async function getQuote(
  inputSymbol: string,
  outputSymbol: string,
  amount: number,
  opts: { slippageBps?: number } = {}
): Promise<SwapQuote> {
  const inputToken = await resolveToken(inputSymbol);
  if (!inputToken) throw new Error(`Unknown token: ${inputSymbol}`);

  const outputToken = await resolveToken(outputSymbol);
  if (!outputToken) throw new Error(`Unknown token: ${outputSymbol}`);

  const inputAmount = uiToTokenAmount(amount, inputToken.decimals);
  const slippageBps = opts.slippageBps ?? 50; // 0.5% default

  await jupiterLimiter.acquire();

  const url = `${JUPITER_API}/quote?inputMint=${inputToken.mint}&outputMint=${outputToken.mint}&amount=${inputAmount}&slippageBps=${slippageBps}`;
  verbose(`Fetching Jupiter quote: ${url}`);

  const res = await withRetry(() => fetch(url), {
    maxRetries: 2,
    shouldRetry: isRetryableHttpError,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jupiter quote failed (${res.status}): ${body}`);
  }

  const data = await res.json() as any;

  const outputUiAmount = Number(BigInt(data.outAmount)) / Math.pow(10, outputToken.decimals);

  return {
    inputMint: inputToken.mint,
    outputMint: outputToken.mint,
    inputAmount: String(inputAmount),
    outputAmount: data.outAmount,
    inputSymbol: inputToken.symbol,
    outputSymbol: outputToken.symbol,
    inputUiAmount: amount,
    outputUiAmount,
    priceImpactPct: parseFloat(data.priceImpactPct || '0'),
    slippageBps,
    routePlan: data.routePlan?.map((r: any) => r.swapInfo?.label || 'unknown').join(' → ') || 'direct',
    _raw: data,
  };
}

export async function executeSwap(
  inputSymbol: string,
  outputSymbol: string,
  amount: number,
  walletName: string,
  opts: { slippageBps?: number; skipPreflight?: boolean } = {}
): Promise<SwapResult> {
  const quote = await getQuote(inputSymbol, outputSymbol, amount, opts);
  const signer = await loadSigner(walletName);

  await jupiterLimiter.acquire();

  // Get swap transaction from Jupiter — pass the raw quote response
  const swapRes = await withRetry(
    () => fetch(`${JUPITER_API}/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote._raw,
        userPublicKey: signer.address,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto',
      }),
    }),
    { maxRetries: 2, shouldRetry: isRetryableHttpError }
  );

  if (!swapRes.ok) {
    const body = await swapRes.text();
    throw new Error(`Jupiter swap failed (${swapRes.status}): ${body}`);
  }

  const swapData = await swapRes.json() as any;
  const swapTxBase64 = swapData.swapTransaction;

  if (!swapTxBase64) throw new Error('No swap transaction returned from Jupiter');

  // 1. Decode base64 string → bytes
  const txBytes = new Uint8Array(Buffer.from(swapTxBase64, 'base64'));

  // 2. Deserialize into Transaction object
  const transaction = getTransactionDecoder().decode(txBytes);

  // 3. Sign with our keypair
  verbose('Signing swap transaction...');
  const [signatures] = await signer.signTransactions([transaction]);

  // 4. Merge signatures into transaction
  const signedTransaction = {
    ...transaction,
    signatures: { ...transaction.signatures, ...signatures },
  };

  // 5. Encode back to base64 wire format
  const encodedTx = getBase64EncodedWireTransaction(signedTransaction);

  // 6. Send, confirm, and log via central transaction handler
  const result = await sendEncodedTransaction(encodedTx, {
    skipPreflight: opts.skipPreflight,
    txType: 'swap',
    walletName,
    fromMint: quote.inputMint,
    toMint: quote.outputMint,
    fromAmount: quote.inputAmount,
    toAmount: quote.outputAmount,
  });

  return {
    signature: result.signature,
    inputSymbol: quote.inputSymbol,
    outputSymbol: quote.outputSymbol,
    inputAmount: quote.inputUiAmount,
    outputAmount: quote.outputUiAmount,
    explorerUrl: result.explorerUrl,
  };
}
