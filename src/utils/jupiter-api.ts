import { getConfigValue } from '../core/config-manager.js';

export function getJupiterApiKey(): string | undefined {
  return getConfigValue('api.jupiterApiKey') as string | undefined;
}

export function getJupiterBaseUrl(): string {
  return getJupiterApiKey() ? 'https://api.jup.ag' : 'https://lite-api.jup.ag';
}

export function getJupiterHeaders(): Record<string, string> {
  const apiKey = getJupiterApiKey();
  return apiKey ? { 'x-api-key': apiKey } : {};
}
