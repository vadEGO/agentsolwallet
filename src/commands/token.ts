import { Command } from 'commander';
import { resolveToken, resolveTokens, syncTokenCache } from '../core/token-registry.js';
import { getPrices, getPrice } from '../core/price-service.js';
import { getTokenBalances } from '../core/token-service.js';
import { getQuote, executeSwap } from '../core/swap-service.js';
import { getDefaultWalletName, loadSigner } from '../core/wallet-manager.js';
import { output, success, failure, isJsonMode, timed } from '../output/formatter.js';
import { table } from '../output/table.js';
import { isValidAddress, solToLamports, uiToTokenAmount, SOL_MINT } from '../utils/solana.js';
import { buildAndSendTransaction } from '../core/transaction.js';
import { address } from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import * as walletRepo from '../db/repos/wallet-repo.js';

export function registerTokenCommand(program: Command): void {
  const token = program.command('token').description('Token operations');

  token
    .command('price <symbols...>')
    .description('Get current USD price for one or more tokens')
    .action(async (symbols: string[]) => {
      try {
        const { result: data, elapsed_ms } = await timed(async () => {
          const resolved = await resolveTokens(symbols);
          const mints = [...resolved.values()].map(t => t.mint);
          const prices = await getPrices(mints);

          return symbols.map(sym => {
            const token = resolved.get(sym);
            if (!token) return { symbol: sym, mint: null, priceUsd: null, error: 'Unknown token' };
            const price = prices.get(token.mint);
            return {
              symbol: token.symbol,
              name: token.name,
              mint: token.mint,
              priceUsd: price?.priceUsd ?? null,
            };
          });
        });

        if (isJsonMode()) {
          output(success(data, { elapsed_ms }));
        } else {
          for (const p of data) {
            if (p.priceUsd !== null) {
              console.log(`${p.symbol}: $${p.priceUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`);
            } else {
              console.log(`${p.symbol}: ${p.error || 'price unavailable'}`);
            }
          }
        }
      } catch (err: any) {
        output(failure('PRICE_FETCH_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  token
    .command('info <symbol>')
    .description('Show token metadata (decimals, supply, authorities)')
    .action(async (symbol: string) => {
      try {
        const { result: data, elapsed_ms } = await timed(async () => {
          const token = await resolveToken(symbol);
          if (!token) throw new Error(`Unknown token: ${symbol}`);
          return token;
        });

        if (isJsonMode()) {
          output(success(data, { elapsed_ms }));
        } else {
          console.log(`${data.symbol} — ${data.name}`);
          console.log(`  Mint:     ${data.mint}`);
          console.log(`  Decimals: ${data.decimals}`);
          if (data.logoUri) console.log(`  Logo:     ${data.logoUri}`);
        }
      } catch (err: any) {
        output(failure('TOKEN_INFO_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  token
    .command('list')
    .description('List all tokens in default wallet')
    .action(async () => {
      try {
        const walletName = getDefaultWalletName();
        const wallet = walletRepo.getWallet(walletName);
        if (!wallet) throw new Error(`Wallet "${walletName}" not found`);

        const { result: balances, elapsed_ms } = await timed(() => getTokenBalances(wallet.address));

        if (isJsonMode()) {
          output(success({ wallet: walletName, tokens: balances }, { elapsed_ms }));
        } else {
          console.log(`Tokens in wallet "${walletName}":\n`);
          if (balances.length === 0) {
            console.log('  No tokens found.');
          } else {
            console.log(table(
              balances.map(b => ({
                symbol: b.symbol,
                balance: b.uiBalance.toFixed(6),
                mint: b.mint.length > 20 ? b.mint.slice(0, 8) + '...' + b.mint.slice(-4) : b.mint,
              })),
              [
                { key: 'symbol', header: 'Token' },
                { key: 'balance', header: 'Balance', align: 'right' },
                { key: 'mint', header: 'Mint' },
              ]
            ));
          }
        }
      } catch (err: any) {
        output(failure('TOKEN_LIST_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  token
    .command('sync')
    .description('Refresh token metadata cache from Jupiter')
    .action(async () => {
      try {
        const { result: count, elapsed_ms } = await timed(() => syncTokenCache());

        if (isJsonMode()) {
          output(success({ tokensCached: count }, { elapsed_ms }));
        } else {
          console.log(`Synced ${count} tokens to cache.`);
        }
      } catch (err: any) {
        output(failure('TOKEN_SYNC_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  token
    .command('swap <amount> <from> <to>')
    .description('Swap tokens via Jupiter (e.g., sol token swap 1.5 SOL USDC)')
    .option('--slippage <bps>', 'Slippage tolerance in basis points', parseInt)
    .option('--quote-only', 'Show quote without executing')
    .option('--wallet <name>', 'Wallet to use')
    .option('--yes', 'Skip confirmation')
    .action(async (amountStr: string, from: string, to: string, opts) => {
      try {
        const amount = parseFloat(amountStr);
        if (isNaN(amount) || amount <= 0) throw new Error('Invalid amount');

        const { result: quote, elapsed_ms } = await timed(() =>
          getQuote(from, to, amount, { slippageBps: opts.slippage })
        );

        if (opts.quoteOnly) {
          if (isJsonMode()) {
            const { _raw, ...quoteData } = quote;
            output(success(quoteData, { elapsed_ms }));
          } else {
            console.log(`Swap Quote:`);
            console.log(`  ${quote.inputUiAmount} ${quote.inputSymbol} → ${quote.outputUiAmount.toFixed(6)} ${quote.outputSymbol}`);
            console.log(`  Price impact: ${quote.priceImpactPct.toFixed(4)}%`);
            console.log(`  Route: ${quote.routePlan}`);
            console.log(`  Slippage: ${quote.slippageBps / 100}%`);
          }
          return;
        }

        // Show quote before executing (unless --yes)
        if (!opts.yes && !isJsonMode()) {
          console.log(`Swap: ${quote.inputUiAmount} ${quote.inputSymbol} → ${quote.outputUiAmount.toFixed(6)} ${quote.outputSymbol}`);
          console.log(`  Price impact: ${quote.priceImpactPct.toFixed(4)}%`);
          console.log(`  Route: ${quote.routePlan}`);
        }

        const walletName = opts.wallet || getDefaultWalletName();
        const result = await executeSwap(from, to, amount, walletName, { slippageBps: opts.slippage });

        if (isJsonMode()) {
          output(success(result, { elapsed_ms }));
        } else {
          console.log(`\nSwap executed!`);
          console.log(`  ${result.inputAmount} ${result.inputSymbol} → ${result.outputAmount.toFixed(6)} ${result.outputSymbol}`);
          console.log(`  Signature: ${result.signature}`);
          console.log(`  Explorer: ${result.explorerUrl}`);
        }
      } catch (err: any) {
        output(failure('SWAP_FAILED', err.message));
        process.exitCode = 1;
      }
    });

  token
    .command('send <amount> <tokenSymbol> <recipient>')
    .description('Send SOL or SPL tokens to an address')
    .option('--wallet <name>', 'Wallet to send from')
    .option('--yes', 'Skip confirmation')
    .action(async (amountStr: string, tokenSymbol: string, recipient: string, opts) => {
      try {
        const amount = parseFloat(amountStr);
        if (isNaN(amount) || amount <= 0) throw new Error('Invalid amount');
        if (!isValidAddress(recipient)) throw new Error('Invalid recipient address');

        const walletName = opts.wallet || getDefaultWalletName();
        const signer = await loadSigner(walletName);

        const tokenMeta = await resolveToken(tokenSymbol);
        if (!tokenMeta) throw new Error(`Unknown token: ${tokenSymbol}`);

        if (!opts.yes && !isJsonMode()) {
          console.log(`Send ${amount} ${tokenMeta.symbol} from "${walletName}" to ${recipient}`);
        }

        if (tokenMeta.mint === SOL_MINT) {
          const ix = getTransferSolInstruction({
            source: signer,
            destination: address(recipient),
            amount: solToLamports(amount),
          });

          const result = await buildAndSendTransaction([ix], signer, {
            txType: 'transfer',
            walletName,
            fromMint: SOL_MINT,
            fromAmount: String(solToLamports(amount)),
          });

          if (isJsonMode()) {
            output(success({
              signature: result.signature,
              from: signer.address,
              to: recipient,
              amount,
              token: tokenMeta.symbol,
              status: result.status,
              explorerUrl: result.explorerUrl,
            }));
          } else {
            console.log(`\nSent ${amount} SOL`);
            console.log(`  Signature: ${result.signature}`);
            console.log(`  Explorer: ${result.explorerUrl}`);
          }
        } else {
          // SPL token transfer — requires token program instructions
          // TODO: Implement SPL token transfer using @solana-program/token
          throw new Error('SPL token transfers coming soon. Use SOL transfers for now.');
        }
      } catch (err: any) {
        output(failure('SEND_FAILED', err.message));
        process.exitCode = 1;
      }
    });
}
