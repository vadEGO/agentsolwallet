import type { SolContext } from '../types.js';

export function getDFlowApiKey(ctx: SolContext): string | undefined {
  return ctx.config.get('api.dflowApiKey') as string | undefined;
}

export function getDFlowBaseUrl(ctx: SolContext): string {
  const baseUrl = ctx.config.get('api.dflowBaseUrl') as string | undefined;
  if (baseUrl) return baseUrl;
  return 'https://quote-api.dflow.net';
}

export function getDFlowHeaders(ctx: SolContext): Record<string, string> {
  const apiKey = getDFlowApiKey(ctx);
  return apiKey ? { 'x-api-key': apiKey } : {};
}
