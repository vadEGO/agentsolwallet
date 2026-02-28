export interface SwapQuoteRequest {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps: number;
}

export interface SwapQuoteResult {
  outputAmount: string;
  priceImpactPct: number;
  routePlan: string;
  raw: unknown;
}

export interface SwapRouter {
  name: string;
  getQuote(req: SwapQuoteRequest): Promise<SwapQuoteResult>;
  getSwapTransaction(quote: SwapQuoteResult, userPublicKey: string): Promise<string>;
}
