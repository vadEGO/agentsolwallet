import type { SolContext } from '../types.js';

export function getJupiterBaseUrl(ctx: SolContext): string {
  const baseUrl = ctx.config.get('api.jupiterBaseUrl') as string | undefined;
  if (baseUrl) return baseUrl;
  const apiKey = ctx.config.get('api.jupiterApiKey') as string | undefined;
  return apiKey ? 'https://api.jup.ag' : 'https://lite-api.jup.ag';
}

export function getJupiterHeaders(ctx: SolContext): Record<string, string> {
  const apiKey = ctx.config.get('api.jupiterApiKey') as string | undefined;
  return apiKey ? { 'x-api-key': apiKey } : {};
}
