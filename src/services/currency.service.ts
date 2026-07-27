import { env } from '../config/env.js';
import { HttpClientError } from '../utils/http-client.js';

const supportedCurrencies = ['EGP', 'USD', 'EUR', 'GBP', 'SAR', 'AED'] as const;
type CurrencyCode = (typeof supportedCurrencies)[number];

const denominations = [
  { value: 0.25, unit: 'EGP', type: 'coin' },
  { value: 0.5, unit: 'EGP', type: 'coin' },
  { value: 1, unit: 'EGP', type: 'coin_or_note' },
  { value: 5, unit: 'EGP', type: 'note' },
  { value: 10, unit: 'EGP', type: 'note' },
  { value: 20, unit: 'EGP', type: 'note' },
  { value: 50, unit: 'EGP', type: 'note' },
  { value: 100, unit: 'EGP', type: 'note' },
  { value: 200, unit: 'EGP', type: 'note' },
];

interface RateCache { expiresAt: number; rates: Record<string, number>; retrievedAt: string; source: string; }
const cache = new Map<CurrencyCode, RateCache>();

export function isSupportedCurrency(value: string): value is CurrencyCode {
  return supportedCurrencies.includes(value.toUpperCase() as CurrencyCode);
}

export function getCurrencyInfo() {
  return { code: 'EGP', name: 'Egyptian pound', symbol: 'E£', minorUnit: 'piastre', denominations, supportedCurrencies };
}

async function fetchRates(base: CurrencyCode): Promise<RateCache> {
  const cached = cache.get(base);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const url = new URL(env.EXCHANGE_RATES_API_URL);
  url.searchParams.set('base', base);
  if (env.EXCHANGE_RATES_API_KEY) url.searchParams.set('access_key', env.EXCHANGE_RATES_API_KEY);
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new HttpClientError(response.status, `Exchange-rate provider failed with ${response.status}`);
  const body = await response.json() as { rates?: Record<string, number>; base?: string; date?: string };
  if (!body.rates || typeof body.rates.EGP !== 'number') throw new Error('Exchange-rate provider returned no EGP rate');
  const entry = { rates: body.rates, retrievedAt: body.date ?? new Date().toISOString(), source: env.EXCHANGE_RATES_API_URL, expiresAt: Date.now() + env.EXCHANGE_RATES_CACHE_TTL_SECONDS * 1000 };
  cache.set(base, entry);
  return entry;
}

export async function getExchangeRates(base: CurrencyCode) {
  try {
    const result = await fetchRates(base);
    return { base, rates: result.rates, retrievedAt: result.retrievedAt, source: result.source, available: true };
  } catch {
    const cached = cache.get(base);
    if (cached) return { base, rates: cached.rates, retrievedAt: cached.retrievedAt, source: cached.source, available: false, stale: true };
    return { base, rates: null, retrievedAt: null, source: null, available: false, stale: false };
  }
}
