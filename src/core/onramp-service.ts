import { getConfigValue } from './config-manager.js';

export interface OnrampProvider {
  name: string;
  generateUrl(params: { walletAddress: string; amount?: number; currency?: string }): string;
}

// Transak — publishable API key, safe for OSS
const TRANSAK_DEFAULT_KEY = 'pk_live_placeholder'; // Replace with actual publishable key

class TransakProvider implements OnrampProvider {
  name = 'transak';

  generateUrl(params: { walletAddress: string; amount?: number; currency?: string }): string {
    const apiKey = (getConfigValue('onramp.transakApiKey') as string) || TRANSAK_DEFAULT_KEY;
    const base = 'https://global.transak.com/';
    const urlParams = new URLSearchParams({
      apiKey,
      walletAddress: params.walletAddress,
      cryptoCurrencyCode: 'SOL',
      network: 'solana',
      defaultFiatCurrency: params.currency || 'USD',
    });

    if (params.amount) {
      urlParams.set('fiatAmount', String(params.amount));
    }

    return `${base}?${urlParams.toString()}`;
  }
}

class SphereProvider implements OnrampProvider {
  name = 'sphere';

  generateUrl(params: { walletAddress: string; amount?: number; currency?: string }): string {
    const key = getConfigValue('onramp.sphereKey') as string;
    if (!key) {
      throw new Error('Sphere API key not configured. Set it with: sol config set onramp.sphereKey sk_...');
    }

    // Sphere uses a different URL structure
    const base = 'https://sphere.money/pay';
    const urlParams = new URLSearchParams({
      walletAddress: params.walletAddress,
      chain: 'solana',
      currency: params.currency || 'USD',
    });

    if (params.amount) {
      urlParams.set('amount', String(params.amount));
    }

    return `${base}?${urlParams.toString()}`;
  }
}

const providers: Map<string, OnrampProvider> = new Map([
  ['transak', new TransakProvider()],
  ['sphere', new SphereProvider()],
]);

export function getOnrampUrl(params: {
  walletAddress: string;
  amount?: number;
  currency?: string;
  provider?: string;
}): string {
  const providerName = params.provider || (getConfigValue('onramp.provider') as string) || 'transak';
  const provider = providers.get(providerName);
  if (!provider) {
    throw new Error(`Unknown onramp provider: ${providerName}. Available: ${[...providers.keys()].join(', ')}`);
  }
  return provider.generateUrl(params);
}

export function listProviders(): string[] {
  return [...providers.keys()];
}
