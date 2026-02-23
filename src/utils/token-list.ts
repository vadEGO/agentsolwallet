export interface WellKnownToken {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
}

// Hardcoded well-known tokens for instant offline resolution
export const WELL_KNOWN_TOKENS: WellKnownToken[] = [
  { mint: 'So11111111111111111111111111111111111111112', symbol: 'SOL', name: 'Solana', decimals: 9 },
  { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', name: 'USD Coin', decimals: 6 },
  { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', symbol: 'USDT', name: 'Tether USD', decimals: 6 },
  { mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', symbol: 'JUP', name: 'Jupiter', decimals: 6 },
  { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'BONK', name: 'Bonk', decimals: 5 },
  { mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', symbol: 'mSOL', name: 'Marinade Staked SOL', decimals: 9 },
  { mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', symbol: 'jitoSOL', name: 'Jito Staked SOL', decimals: 9 },
  { mint: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', symbol: 'bSOL', name: 'BlazeStake Staked SOL', decimals: 9 },
  { mint: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', symbol: 'ETH', name: 'Wrapped Ether (Wormhole)', decimals: 8 },
  { mint: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', symbol: 'wBTC', name: 'Wrapped BTC (Wormhole)', decimals: 8 },
  { mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', symbol: 'PYTH', name: 'Pyth Network', decimals: 6 },
  { mint: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL', symbol: 'JTO', name: 'Jito', decimals: 9 },
  { mint: 'WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk', symbol: 'WEN', name: 'Wen', decimals: 5 },
  { mint: 'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof', symbol: 'RNDR', name: 'Render Token', decimals: 8 },
  { mint: '27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4', symbol: 'JLP', name: 'Jupiter Perps LP', decimals: 6 },
];

const BY_SYMBOL = new Map<string, WellKnownToken>();
const BY_MINT = new Map<string, WellKnownToken>();

for (const token of WELL_KNOWN_TOKENS) {
  BY_SYMBOL.set(token.symbol.toUpperCase(), token);
  BY_MINT.set(token.mint, token);
}

export function getWellKnownBySymbol(symbol: string): WellKnownToken | undefined {
  return BY_SYMBOL.get(symbol.toUpperCase());
}

export function getWellKnownByMint(mint: string): WellKnownToken | undefined {
  return BY_MINT.get(mint);
}
