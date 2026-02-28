import {
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  partiallySignTransactionMessageWithSigners,
  getBase64EncodedWireTransaction,
  type KeyPairSigner,
  type Instruction,
  address,
} from '@solana/kit';
import {
  findAssociatedTokenPda,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import type { SolContext } from '../types.js';

const USDC_MINT = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const USDC_DECIMALS = 6;
const SOLANA_CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

export interface PaymentRequirements {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxAmountRequired?: string;
  extra?: Record<string, unknown>;
  x402Version?: number;
}

export interface X402FetchOptions {
  method?: string;
  body?: string;
  headers?: string[];
  maxUsdc?: number;
  dryRun?: boolean;
  walletName?: string;
}

export interface X402FetchResult {
  url: string;
  status: number;
  body: string;
  contentType: string;
  paid: boolean;
  payment?: { amountUsdc: number; recipient: string; network: string; signature?: string };
  requirements?: PaymentRequirements;
}

export interface X402Service {
  fetch(url: string, opts?: X402FetchOptions): Promise<X402FetchResult>;
}

export function createX402Service(ctx: SolContext): X402Service {
  const { rpc, logger, signer, txLogger } = ctx;

  function parseHeaders(headerStrings: string[]): Record<string, string> {
    const result: Record<string, string> = {};
    for (const h of headerStrings) {
      const idx = h.indexOf(':');
      if (idx === -1) continue;
      const key = h.slice(0, idx).trim();
      const value = h.slice(idx + 1).trim();
      if (key) result[key] = value;
    }
    return result;
  }

  function decodeRequirements(headerValue: string): PaymentRequirements {
    let parsed: any;
    try { parsed = JSON.parse(Buffer.from(headerValue, 'base64').toString()); }
    catch { try { parsed = JSON.parse(headerValue); } catch { throw new Error('Could not decode payment requirements header'); } }

    const accepts: any[] = parsed.accepts ?? (Array.isArray(parsed) ? parsed : [parsed]);
    const solanaOption = accepts.find((a: any) => {
      const net = a.network ?? '';
      return net === SOLANA_CAIP2 || net === 'solana-mainnet' || net === 'solana:mainnet' || net.startsWith('solana');
    });

    if (!solanaOption) {
      const networks = accepts.map((a: any) => a.network).join(', ');
      throw new Error(`No Solana payment option found. Available networks: ${networks}`);
    }

    return {
      scheme: solanaOption.scheme ?? parsed.scheme ?? 'exact',
      network: solanaOption.network,
      asset: solanaOption.asset ?? solanaOption.currency ?? 'USDC',
      amount: String(solanaOption.maxAmountRequired ?? solanaOption.amount ?? solanaOption.maxAmount),
      payTo: solanaOption.payTo ?? solanaOption.recipient ?? solanaOption.address,
      maxAmountRequired: solanaOption.maxAmountRequired ? String(solanaOption.maxAmountRequired) : undefined,
      extra: solanaOption.extra,
      x402Version: parsed.x402Version ?? 1,
    };
  }

  async function buildPaymentTransaction(signerObj: any, requirements: PaymentRequirements): Promise<string> {
    const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

    const recipient = address(requirements.payTo);
    const amount = BigInt(requirements.amount);
    const mintAddress = requirements.asset && requirements.asset.length > 20 ? address(requirements.asset) : USDC_MINT;

    const feePayerAddr = requirements.extra?.feePayer as string | undefined;
    const feePayer = feePayerAddr ? address(feePayerAddr) : signerObj.address;
    logger.verbose(`Fee payer: ${feePayer}${feePayerAddr ? ' (server)' : ' (self)'}`);

    const decimals = (requirements.extra?.decimals as number) ?? USDC_DECIMALS;

    const [senderAta] = await findAssociatedTokenPda({ owner: signerObj.address, mint: mintAddress, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const [recipientAta] = await findAssociatedTokenPda({ owner: recipient, mint: mintAddress, tokenProgram: TOKEN_PROGRAM_ADDRESS });

    const instructions: Instruction[] = [];
    const computeBudgetProgram = address('ComputeBudget111111111111111111111111111111');

    const limitData = new Uint8Array(5);
    limitData[0] = 2;
    new DataView(limitData.buffer).setUint32(1, 50_000, true);
    instructions.push({ programAddress: computeBudgetProgram, accounts: [], data: limitData });

    const priceData = new Uint8Array(9);
    priceData[0] = 3;
    new DataView(priceData.buffer).setBigUint64(1, BigInt(1), true);
    instructions.push({ programAddress: computeBudgetProgram, accounts: [], data: priceData });

    instructions.push(getTransferCheckedInstruction({ source: senderAta, mint: mintAddress, destination: recipientAta, authority: signerObj, amount, decimals }));

    const message = pipe(
      createTransactionMessage({ version: 0 }),
      m => setTransactionMessageFeePayer(feePayer, m),
      m => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
      m => appendTransactionMessageInstructions(instructions, m),
    );

    const partiallySigned = await partiallySignTransactionMessageWithSigners(message);
    return getBase64EncodedWireTransaction(partiallySigned);
  }

  async function x402Fetch(url: string, opts: X402FetchOptions = {}): Promise<X402FetchResult> {
    const headers = parseHeaders(opts.headers ?? []);
    const method = opts.method ?? (opts.body ? 'POST' : 'GET');

    logger.verbose(`${method} ${url}`);

    const resp = await globalThis.fetch(url, { method, headers, body: opts.body ?? undefined });

    if (resp.status !== 402) {
      const contentType = resp.headers.get('content-type') ?? 'text/plain';
      const body = await resp.text();
      return { url, status: resp.status, body, contentType, paid: false };
    }

    logger.verbose('Got 402 Payment Required — parsing requirements');

    const requirementsHeader = resp.headers.get('x-payment-requirements') ?? resp.headers.get('payment-required');
    const respBody = await resp.text();
    const requirementsSource = requirementsHeader ?? respBody;
    if (!requirementsSource) throw new Error('Server returned 402 but no payment requirements found');

    const requirements = decodeRequirements(requirementsSource);
    logger.verbose(`Payment: ${requirements.amount} to ${requirements.payTo} on ${requirements.network}`);

    const amountUsdc = Number(requirements.amount) / Math.pow(10, USDC_DECIMALS);

    if (opts.maxUsdc != null && amountUsdc > opts.maxUsdc) {
      throw new Error(`Payment of $${amountUsdc.toFixed(6)} USDC exceeds --max cap of $${opts.maxUsdc} USDC`);
    }

    if (opts.dryRun) {
      return { url, status: 402, body: '', contentType: 'text/plain', paid: false, requirements, payment: { amountUsdc, recipient: requirements.payTo, network: requirements.network } };
    }

    const walletName = opts.walletName ?? 'default';
    const signerObj = await signer.getSigner(walletName);
    logger.verbose(`Signing payment with wallet "${walletName}" (${signerObj.address})`);

    const paymentBase64 = await buildPaymentTransaction(signerObj, requirements);

    const version = requirements.x402Version ?? 1;
    logger.verbose(`Building x402 v${version} payment payload`);

    let paymentPayload: Record<string, unknown>;
    let headerName: string;

    if (version >= 2) {
      headerName = 'PAYMENT-SIGNATURE';
      paymentPayload = {
        x402Version: 2, payload: { transaction: paymentBase64 },
        accepted: { scheme: requirements.scheme, network: requirements.network, asset: requirements.asset, amount: requirements.amount, payTo: requirements.payTo, maxTimeoutSeconds: 60, extra: requirements.extra ?? {} },
        resource: { url },
      };
    } else {
      headerName = 'X-PAYMENT';
      paymentPayload = { x402Version: 1, scheme: requirements.scheme, network: requirements.network, asset: requirements.asset, payload: { transaction: paymentBase64 } };
    }

    const payloadJson = JSON.stringify(paymentPayload);
    const encodedPayment = Buffer.from(payloadJson).toString('base64');

    logger.verbose(`Retrying request with ${headerName} header`);

    const paidResp = await globalThis.fetch(url, { method, headers: { ...headers, [headerName]: encodedPayment }, body: opts.body ?? undefined });

    logger.verbose(`Paid response status: ${paidResp.status}`);
    const paidBody = await paidResp.text();
    const paidContentType = paidResp.headers.get('content-type') ?? 'text/plain';

    let txSignature: string | undefined;
    const paymentResponseHeader = paidResp.headers.get('payment-response') ?? paidResp.headers.get('x-payment-response');
    if (paymentResponseHeader) {
      try {
        const decoded = JSON.parse(Buffer.from(paymentResponseHeader, 'base64').toString());
        txSignature = decoded.txHash ?? decoded.signature ?? decoded.transactionHash;
      } catch { logger.verbose('Could not decode payment response header'); }
    }

    if (txSignature) {
      txLogger.log({ signature: txSignature, type: 'x402_payment', walletName, fromMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', fromAmount: String(amountUsdc), status: 'confirmed' });
    }

    if (paidResp.status === 402) {
      throw new Error(`Payment rejected by server (still 402). Response: ${paidBody.slice(0, 200)}`);
    }

    return { url, status: paidResp.status, body: paidBody, contentType: paidContentType, paid: true, payment: { amountUsdc, recipient: requirements.payTo, network: requirements.network, signature: txSignature } };
  }

  return { fetch: x402Fetch };
}
