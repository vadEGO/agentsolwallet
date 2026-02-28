export interface PredictionEvent {
  id: string;
  provider: string;
  title: string;
  category: string;
  subcategory?: string;
  imageUrl?: string;
  status: 'active' | 'closed' | 'resolved';
  markets: PredictionMarket[];
  volume: number;
  beginAt?: string;
  endAt?: string;
  createdAt?: string;
}

export interface PredictionMarket {
  id: string;
  eventId: string;
  provider: string;
  title: string;
  yesPrice: number;
  noPrice: number;
  volume: number;
  status: 'active' | 'closed' | 'resolved';
  resolution?: 'yes' | 'no' | null;
  settlementMint?: string;
}

export interface PredictionOrderbook {
  yes: OrderbookLevel[];
  no: OrderbookLevel[];
}

export interface OrderbookLevel {
  price: number;
  quantity: number;
}

export interface PredictionPosition {
  pubkey: string;
  provider: string;
  marketId: string;
  eventId: string;
  marketTitle: string;
  eventTitle: string;
  isYes: boolean;
  contracts: number;
  costBasisUsd: number;
  currentValueUsd: number | null;
  avgPriceUsd: number;
  markPriceUsd: number | null;
  unrealizedPnlUsd: number | null;
  unrealizedPnlPct: number | null;
  feesPaidUsd: number;
  claimable: boolean;
  payoutUsd: number;
  openedAt: number;
  status: 'open' | 'claimable' | 'closed' | 'lost';
}

export interface PredictionHistoryEntry {
  id: string;
  eventType: string;
  marketId: string;
  eventTitle: string;
  marketTitle: string;
  isYes: boolean;
  contracts: number;
  priceUsd: number;
  feeUsd: number;
  timestamp: number;
  signature?: string;
}

export interface PredictionOrderResult {
  orderPubkey: string;
  positionPubkey: string;
  contracts: number;
  priceUsd: number;
  costUsd: number;
  estimatedFeeUsd: number;
  signature: string;
  explorerUrl: string;
}

export interface PredictionCloseResult {
  positionPubkey: string;
  contracts: number;
  proceedsUsd: number;
  realizedPnlUsd: number;
  signature: string;
  explorerUrl: string;
}

export interface PredictionClaimResult {
  positionPubkey: string;
  contracts: number;
  payoutUsd: number;
  signature: string;
  explorerUrl: string;
}

export interface PredictProvider {
  name: string;
  listEvents(opts?: {
    category?: string;
    filter?: 'new' | 'live' | 'trending' | 'upcoming';
    sortBy?: 'volume' | 'beginAt';
    limit?: number;
  }): Promise<PredictionEvent[]>;
  searchEvents(query: string, limit?: number): Promise<PredictionEvent[]>;
  getEvent(eventId: string): Promise<PredictionEvent>;
  getMarket(marketId: string): Promise<PredictionMarket>;
  getOrderbook(marketId: string): Promise<PredictionOrderbook | null>;
  buy(walletName: string, marketId: string, isYes: boolean, amountUsd: number, maxPrice?: number): Promise<PredictionOrderResult>;
  sell(walletName: string, positionPubkey: string, minPrice?: number): Promise<PredictionCloseResult>;
  claim(walletName: string, positionPubkey: string): Promise<PredictionClaimResult>;
  getPositions(walletAddress: string): Promise<PredictionPosition[]>;
  getHistory(walletAddress: string, limit?: number): Promise<PredictionHistoryEntry[]>;
}

export const PREDICT_CATEGORIES = [
  'crypto', 'sports', 'politics', 'esports', 'culture',
  'economics', 'tech', 'finance', 'climate & science',
] as const;
export type PredictCategory = typeof PREDICT_CATEGORIES[number];

export const PROVIDER_NAMES = ['jupiter'] as const;
export type PredictProviderName = typeof PROVIDER_NAMES[number];
