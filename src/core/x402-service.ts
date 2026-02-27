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
import { getRpc } from './rpc.js';
import { loadSigner, getDefaultWalletName, resolveWalletName } from './wallet-manager.js';
import { logTransaction } from './transaction.js';
import { verbose } from '../output/formatter.js';

const USDC_MINT = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const USDC_DECIMALS = 6;

// CAIP-2 identifier for Solana mainnet
const SOLANA_CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

// ── Types ──────────────────────────────────────────────────

export interface PaymentRequirements {
  scheme: string;
  network: string;
  asset: string;
  amount: string;        // raw token units as string
  payTo: string;         // recipient address
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
  payment?: {
    amountUsdc: number;
    recipient: string;
    network: string;
    signature?: string;
  };
  requirements?: PaymentRequirements;
}

// ── Main fetch ─────────────────────────────────────────────

export async function x402Fetch(url: string, opts: X402FetchOptions = {}): Promise<X402FetchResult> {
  const headers = parseHeaders(opts.headers ?? []);
  const method = opts.method ?? (opts.body ? 'POST' : 'GET');

  verbose(`${method} ${url}`);

  // First request — may get 402
  const resp = await fetch(url, {
    method,
    headers,
    body: opts.body ?? undefined,
  });

  if (resp.status !== 402) {
    const contentType = resp.headers.get('content-type') ?? 'text/plain';
    const body = await resp.text();
    return { url, status: resp.status, body, contentType, paid: false };
  }

  verbose('Got 402 Payment Required — parsing requirements');

  // Parse payment requirements from header or body
  const requirementsHeader = resp.headers.get('x-payment-requirements') ?? resp.headers.get('payment-required');
  const respBody = await resp.text();

  const requirementsSource = requirementsHeader ?? respBody;
  if (!requirementsSource) {
    throw new Error('Server returned 402 but no payment requirements found (checked headers and body)');
  }

  const requirements = decodeRequirements(requirementsSource);

  verbose(`Payment: ${requirements.amount} to ${requirements.payTo} on ${requirements.network}`);

  const amountUsdc = Number(requirements.amount) / Math.pow(10, USDC_DECIMALS);

  // Check spending cap
  if (opts.maxUsdc != null && amountUsdc > opts.maxUsdc) {
    throw new Error(
      `Payment of $${amountUsdc.toFixed(6)} USDC exceeds --max cap of $${opts.maxUsdc} USDC`
    );
  }

  // Dry run — return requirements without paying
  if (opts.dryRun) {
    return {
      url,
      status: 402,
      body: '',
      contentType: 'text/plain',
      paid: false,
      requirements,
      payment: { amountUsdc, recipient: requirements.payTo, network: requirements.network },
    };
  }

  // Build and sign the payment transaction (NOT submitted — server does that)
  const walletName = opts.walletName
    ? resolveWalletName(opts.walletName)
    : getDefaultWalletName();
  const signer = await loadSigner(walletName);

  verbose(`Signing payment with wallet "${walletName}" (${signer.address})`);

  const paymentBase64 = await buildPaymentTransaction(signer, requirements);

  // Encode payment payload — adapt to server's x402 version
  const version = requirements.x402Version ?? 1;
  verbose(`Building x402 v${version} payment payload`);

  let paymentPayload: Record<string, unknown>;
  let headerName: string;

  if (version >= 2) {
    // v2: PAYMENT-SIGNATURE header, includes accepted requirements + resource
    headerName = 'PAYMENT-SIGNATURE';
    paymentPayload = {
      x402Version: 2,
      payload: { transaction: paymentBase64 },
      accepted: {
        scheme: requirements.scheme,
        network: requirements.network,
        asset: requirements.asset,
        amount: requirements.amount,
        payTo: requirements.payTo,
        maxTimeoutSeconds: 60,
        extra: requirements.extra ?? {},
      },
      resource: { url },
    };
  } else {
    // v1: X-PAYMENT header, flat scheme/network/asset at top level
    headerName = 'X-PAYMENT';
    paymentPayload = {
      x402Version: 1,
      scheme: requirements.scheme,
      network: requirements.network,
      asset: requirements.asset,
      payload: { transaction: paymentBase64 },
    };
  }

  const payloadJson = JSON.stringify(paymentPayload);
  const encodedPayment = Buffer.from(payloadJson).toString('base64');

  // Retry with payment header
  verbose(`${headerName} payload: ${payloadJson}`);
  verbose(`Retrying request with ${headerName} header`);

  const paidResp = await fetch(url, {
    method,
    headers: {
      ...headers,
      [headerName]: encodedPayment,
    },
    body: opts.body ?? undefined,
  });

  verbose(`Paid response status: ${paidResp.status}`);
  const paidBody = await paidResp.text();
  const paidContentType = paidResp.headers.get('content-type') ?? 'text/plain';

  // Parse payment response for tx signature (check both v2 and v1 header names)
  let txSignature: string | undefined;
  const paymentResponseHeader = paidResp.headers.get('payment-response')
    ?? paidResp.headers.get('x-payment-response');
  if (paymentResponseHeader) {
    try {
      const decoded = JSON.parse(Buffer.from(paymentResponseHeader, 'base64').toString());
      txSignature = decoded.txHash ?? decoded.signature ?? decoded.transactionHash;
    } catch {
      verbose('Could not decode payment response header');
    }
  }

  // Log the payment
  if (txSignature) {
    logTransaction({
      signature: txSignature,
      type: 'x402_payment',
      walletName,
      fromMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      fromAmount: String(amountUsdc),
      status: 'confirmed',
    });
  }

  // If server still returns 402, payment was rejected
  if (paidResp.status === 402) {
    throw new Error(`Payment rejected by server (still 402). Response: ${paidBody.slice(0, 200)}`);
  }

  return {
    url,
    status: paidResp.status,
    body: paidBody,
    contentType: paidContentType,
    paid: true,
    payment: {
      amountUsdc,
      recipient: requirements.payTo,
      network: requirements.network,
      signature: txSignature,
    },
  };
}

// ── Build payment transaction ──────────────────────────────

async function buildPaymentTransaction(
  signer: KeyPairSigner,
  requirements: PaymentRequirements,
): Promise<string> {
  const rpc = getRpc();
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

  const recipient = address(requirements.payTo);
  const amount = BigInt(requirements.amount);
  const mintAddress = requirements.asset && requirements.asset.length > 20
    ? address(requirements.asset)
    : USDC_MINT;

  // Server provides the fee payer — they co-sign and submit the tx
  const feePayerAddr = requirements.extra?.feePayer as string | undefined;
  const feePayer = feePayerAddr ? address(feePayerAddr) : signer.address;
  verbose(`Fee payer: ${feePayer}${feePayerAddr ? ' (server)' : ' (self)'}`);

  // Derive decimals from extra or default to USDC
  const decimals = (requirements.extra?.decimals as number) ?? USDC_DECIMALS;

  // Find ATAs for sender and recipient
  const [senderAta] = await findAssociatedTokenPda({
    owner: signer.address,
    mint: mintAddress,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const [recipientAta] = await findAssociatedTokenPda({
    owner: recipient,
    mint: mintAddress,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });

  const instructions: Instruction[] = [];

  // Compute budget instructions (no new dependency — built manually)
  const computeBudgetProgram = address('ComputeBudget111111111111111111111111111111');

  // SetComputeUnitLimit: discriminator(1) + u32 units(4)
  const limitData = new Uint8Array(5);
  limitData[0] = 2;
  new DataView(limitData.buffer).setUint32(1, 50_000, true);
  instructions.push({ programAddress: computeBudgetProgram, accounts: [], data: limitData });

  // SetComputeUnitPrice: discriminator(1) + u64 microLamports(8)
  const priceData = new Uint8Array(9);
  priceData[0] = 3;
  new DataView(priceData.buffer).setBigUint64(1, BigInt(1), true);
  instructions.push({ programAddress: computeBudgetProgram, accounts: [], data: priceData });

  // Transfer USDC (TransferChecked)
  instructions.push(
    getTransferCheckedInstruction({
      source: senderAta,
      mint: mintAddress,
      destination: recipientAta,
      authority: signer,
      amount,
      decimals,
    }),
  );

  // Build and partially sign — server co-signs as fee payer before submitting
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayer(feePayer, m),
    m => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    m => appendTransactionMessageInstructions(instructions, m),
  );

  const partiallySigned = await partiallySignTransactionMessageWithSigners(message);
  return getBase64EncodedWireTransaction(partiallySigned);
}

// ── Helpers ────────────────────────────────────────────────

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
  try {
    // Try base64 first
    parsed = JSON.parse(Buffer.from(headerValue, 'base64').toString());
  } catch {
    // Try raw JSON
    try {
      parsed = JSON.parse(headerValue);
    } catch {
      throw new Error('Could not decode payment requirements header');
    }
  }

  // x402 spec: accepts is an array of payment options
  const accepts: any[] = parsed.accepts ?? (Array.isArray(parsed) ? parsed : [parsed]);

  // Find a Solana option
  const solanaOption = accepts.find((a: any) => {
    const net = a.network ?? '';
    return net === SOLANA_CAIP2
      || net === 'solana-mainnet'
      || net === 'solana:mainnet'
      || net.startsWith('solana');
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
