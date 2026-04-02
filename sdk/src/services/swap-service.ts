import {
  getTransactionDecoder,
  getBase64EncodedWireTransaction,
} from '@solana/transactions';
import {
  getCompiledTransactionMessageDecoder,
  decompileTransactionMessageFetchingLookupTables,
  appendTransactionMessageInstructions,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { uiToTokenAmount } from '../utils/solana.js';
import type { SolContext } from '../types.js';
import type { SwapRouter, SwapQuoteRequest, SwapQuoteResult } from './swap/swap-router.js';
import type { PriceService } from './price-service.js';
import type { TokenRegistryService } from './token-registry-service.js';
import type { TransactionService } from './transaction-service.js';
import { createJupiterRouter } from './swap/jupiter-router.js';
import { createDFlowRouter } from './swap/dflow-router.js';

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

export interface SwapService {
  getQuote(
    inputSymbol: string,
    outputSymbol: string,
    amount: number,
    opts?: { slippageBps?: number; router?: string },
  ): Promise<SwapQuote>;

  executeSwap(
    inputSymbol: string,
    outputSymbol: string,
    amount: number,
    walletName: string,
    opts?: { slippageBps?: number; skipPreflight?: boolean; rewardBps?: number; router?: string },
  ): Promise<SwapResult>;
}

export function createSwapService(
  ctx: SolContext,
  deps: {
    price: PriceService;
    registry: TokenRegistryService;
    tx: TransactionService;
  },
): SwapService {
  const { logger, rpc } = ctx;

  // Instance-scoped router registry
  const routers = new Map<string, SwapRouter>();
  routers.set('jupiter', createJupiterRouter(ctx));
  routers.set('dflow', createDFlowRouter(ctx));

  function getDefaultRouterName(): string {
    return (ctx.config.get('defaults.router') as string) ?? 'best';
  }

  async function getBestQuote(req: SwapQuoteRequest): Promise<{ quote: SwapQuoteResult; router: SwapRouter }> {
    const all = [...routers.values()];
    if (all.length === 0) throw new Error('No swap routers registered');

    const results = await Promise.allSettled(
      all.map(async r => ({ quote: await r.getQuote(req), router: r }))
    );

    let best: { quote: SwapQuoteResult; router: SwapRouter } | undefined;

    for (const r of results) {
      if (r.status === 'rejected') {
        logger.verbose(`Router quote failed: ${r.reason}`);
        continue;
      }
      if (!best || BigInt(r.value.quote.outputAmount) > BigInt(best.quote.outputAmount)) {
        best = r.value;
      }
    }

    if (!best) {
      const firstError = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
      throw firstError.reason;
    }

    logger.verbose(`Best quote from ${best.router.name}: ${best.quote.outputAmount}`);
    return best;
  }

  async function getRouterQuote(req: SwapQuoteRequest, routerName?: string): Promise<{ quote: SwapQuoteResult; router: SwapRouter }> {
    const name = routerName ?? getDefaultRouterName();

    if (name === 'best') {
      return getBestQuote(req);
    }

    const router = routers.get(name);
    if (!router) throw new Error(`Unknown router: ${name}. Available: ${[...routers.keys()].join(', ')}`);

    const quote = await router.getQuote(req);
    return { quote, router };
  }

  async function getQuote(
    inputSymbol: string,
    outputSymbol: string,
    amount: number,
    opts: { slippageBps?: number; router?: string } = {}
  ): Promise<SwapQuote> {
    const inputToken = await deps.registry.resolveToken(inputSymbol);
    if (!inputToken) throw new Error(`Unknown token: ${inputSymbol}`);

    const outputToken = await deps.registry.resolveToken(outputSymbol);
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

  async function executeSwap(
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
    const signer = await ctx.signer.getSigner(walletName);

    // Get swap transaction from the router that produced the quote
    const router = routers.get(quote._routerName);
    if (!router) throw new Error(`Router ${quote._routerName} not found`);

    const swapTxBase64 = await router.getSwapTransaction(quote._raw as any, signer.address);

    // Decode and decompile the transaction
    const txBytes = new Uint8Array(Buffer.from(swapTxBase64, 'base64'));
    const rawTx = getTransactionDecoder().decode(txBytes);
    const compiledMsg = getCompiledTransactionMessageDecoder().decode(rawTx.messageBytes);
    let msg = await decompileTransactionMessageFetchingLookupTables(compiledMsg, rpc);

    // Append analytics instruction if configured
    const analyticsIx = ctx.analyticsInstruction?.();
    if (analyticsIx) {
      msg = appendTransactionMessageInstructions([analyticsIx], msg) as typeof msg;
    }

    // Sign and encode
    logger.verbose('Signing swap transaction...');
    const signedTx = await signTransactionMessageWithSigners(msg);
    const encodedTx = getBase64EncodedWireTransaction(signedTx);

    // Send, confirm, and log
    const result = await deps.tx.sendEncodedTransaction(encodedTx, {
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

  return { getQuote, executeSwap };
}
