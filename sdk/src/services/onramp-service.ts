import type { SolContext } from '../types.js';

export interface OnrampProvider {
  name: string;
  generateUrl(params: { walletAddress: string; amount?: number; currency?: string }): string;
}

export interface OnrampService {
  getUrl(params: { walletAddress: string; amount?: number; currency?: string; provider?: string }): string;
  listProviders(): string[];
}

const TRANSAK_DEFAULT_KEY = 'pk_live_placeholder';

export function createOnrampService(ctx: SolContext): OnrampService {
  const providers = new Map<string, OnrampProvider>();

  providers.set('transak', {
    name: 'transak',
    generateUrl(params) {
      const apiKey = (ctx.config.get('onramp.transakApiKey') as string) || TRANSAK_DEFAULT_KEY;
      const base = 'https://global.transak.com/';
      const urlParams = new URLSearchParams({
        apiKey, walletAddress: params.walletAddress,
        cryptoCurrencyCode: 'SOL', network: 'solana',
        defaultFiatCurrency: params.currency || 'USD',
      });
      if (params.amount) urlParams.set('fiatAmount', String(params.amount));
      return `${base}?${urlParams.toString()}`;
    },
  });

  providers.set('sphere', {
    name: 'sphere',
    generateUrl(params) {
      const key = ctx.config.get('onramp.sphereKey') as string;
      if (!key) throw new Error('Sphere API key not configured. Set it with: sol config set onramp.sphereKey sk_...');
      const base = 'https://sphere.money/pay';
      const urlParams = new URLSearchParams({
        walletAddress: params.walletAddress, chain: 'solana', currency: params.currency || 'USD',
      });
      if (params.amount) urlParams.set('amount', String(params.amount));
      return `${base}?${urlParams.toString()}`;
    },
  });

  function getUrl(params: { walletAddress: string; amount?: number; currency?: string; provider?: string }): string {
    const providerName = params.provider || (ctx.config.get('onramp.provider') as string) || 'transak';
    const provider = providers.get(providerName);
    if (!provider) throw new Error(`Unknown onramp provider: ${providerName}. Available: ${[...providers.keys()].join(', ')}`);
    return provider.generateUrl(params);
  }

  function listProviders(): string[] {
    return [...providers.keys()];
  }

  return { getUrl, listProviders };
}
