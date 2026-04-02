import { verbose } from '../output/formatter.js';
import { resolveToken } from './token-registry.js';
import { uiToTokenAmount } from '../utils/solana.js';
import { loadSigner, loadSignerRawBytes } from './wallet-manager.js';
import { getRpc } from './rpc.js';
import { getRouterQuote, getRouter } from './swap-router.js';
import { sendEncodedTransaction } from './transaction.js';
import { getBase64EncodedWireTransaction } from '@solana/transactions';
import { Transaction, VersionedTransaction } from '@solana/web3.js';
import { createKeyPairSignerFromBytes } from '@solana/kit';

// Import routers so they self-register
import './jupiter-router.js';
import './dflow-router.js';

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
  routerName: string;
  platformFee?: string;
  // Router-specific data kept for swap execution
  _raw: unknown;
  _routerName: string;
}

export interface SwapResult {
  signature: string;
  inputSymbol: string;
  outputSymbol: string;
  inputAmount: number;
  outputAmount: number;
  explorerUrl: string;
  routerName: string;
}

export async function getQuote(
  inputSymbol: string,
  outputSymbol: string,
  amount: number,
  opts: { slippageBps?: number; router?: string } = {}
): Promise<SwapQuote> {
  const inputToken = await resolveToken(inputSymbol);
  if (!inputToken) throw new Error(`Unknown token: ${inputSymbol}`);

  const outputToken = await resolveToken(outputSymbol);
  if (!outputToken) throw new Error(`Unknown token: ${outputSymbol}`);

  const inputAmount = uiToTokenAmount(amount, inputToken.decimals);
  const slippageBps = opts.slippageBps ?? 50;

  const { quote, router } = await getRouterQuote({
    inputMint: inputToken.mint,
    outputMint: outputToken.mint,
    amount: String(inputAmount),
    slippageBps,
  }, opts.router);

  const outputUiAmount = Number(BigInt(quote.outputAmount)) / Math.pow(10, outputToken.decimals);

  return {
    inputMint: inputToken.mint,
    outputMint: outputToken.mint,
    inputAmount: String(inputAmount),
    outputAmount: quote.outputAmount,
    inputSymbol: inputToken.symbol,
    outputSymbol: outputToken.symbol,
    inputUiAmount: amount,
    outputUiAmount,
    priceImpactPct: quote.priceImpactPct,
    slippageBps,
    routePlan: quote.routePlan,
    routerName: router.name,
    _raw: quote,
    _routerName: router.name,
  };
}

export async function executeSwap(
  inputSymbol: string,
  outputSymbol: string,
  amount: number,
  walletName: string,
  opts: { slippageBps?: number; skipPreflight?: boolean; router?: string } = {}
): Promise<SwapResult> {
  const quote = await getQuote(inputSymbol, outputSymbol, amount, {
    slippageBps: opts.slippageBps,
    router: opts.router,
  });
  const signer = await loadSigner(walletName);
  const rawBytes = loadSignerRawBytes(walletName);
  const rpc = getRpc();

  // Get swap transaction from the router that produced the quote
  const router = getRouter(quote._routerName);
  if (!router) throw new Error(`Router ${quote._routerName} not found`);

  const swapTxBase64 = await router.getSwapTransaction(quote._raw as any, signer.address);

  // Use web3.js to sign and send the transaction to avoid v2 kit signer mapping issues
  verbose('Deserializing Jupiter transaction...');
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTxBase64, 'base64'));
  
  // Create a web3.js Keypair from the raw bytes
  const { Keypair } = await import('@solana/web3.js');
  const keypair = Keypair.fromSecretKey(rawBytes);
  
  // Sign the transaction
  verbose('Signing with web3.js keypair...');
  tx.sign([keypair]);
  verbose('Transaction signed successfully.');
  
  // Encode back to base64 for our v2 sendEncodedTransaction
  const signedBase64 = Buffer.from(tx.serialize()).toString('base64');

  // Send, confirm, and log
  verbose('Sending transaction via v2 RPC...');
  const result = await sendEncodedTransaction(signedBase64, {
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
    routerName: quote.routerName,
  };
}
