import { env } from '../config/env.js';
import { HttpClientError } from '../utils/http-client.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

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

interface RateCache {
  expiresAt: number;
  rates: Record<string, number>;
  retrievedAt: string | null;
  source: string;
  nextUpdateAt: string | null;
}

const cacheFile = path.join(process.cwd(), 'data', 'currency-rates.json');
const cache = new Map<CurrencyCode, RateCache>();

async function loadCacheFromDisk(): Promise<void> {
  try {
    const raw = await readFile(cacheFile, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, RateCache>;
    for (const [key, entry] of Object.entries(parsed)) {
      if (supportedCurrencies.includes(key as CurrencyCode) && entry?.rates) {
        cache.set(key as CurrencyCode, entry);
      }
    }
  } catch {
    // No persisted cache yet.
  }
}

async function persistCache(): Promise<void> {
  try {
    await mkdir(path.dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, JSON.stringify(Object.fromEntries(cache), null, 2));
  } catch {
    // Non-fatal: cache stays in memory.
  }
}

await loadCacheFromDisk();

export function isSupportedCurrency(value: string): value is CurrencyCode {
  return supportedCurrencies.includes(value.toUpperCase() as CurrencyCode);
}

export function getCurrencyInfo() {
  return { code: 'EGP', name: 'Egyptian pound', symbol: 'E£', minorUnit: 'piastre', denominations, supportedCurrencies };
}

function buildApiUrl(base: CurrencyCode): string {
  const baseUrl = env.EXCHANGE_RATES_API_URL.replace(/\/+$/, '');
  if (!env.EXCHANGE_RATES_API_KEY) {
    throw new Error('EXCHANGE_RATES_API_KEY is not configured');
  }
  return `${baseUrl}/${env.EXCHANGE_RATES_API_KEY}/latest/${base}`;
}

async function fetchRates(base: CurrencyCode): Promise<RateCache> {
  const cached = cache.get(base);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const url = buildApiUrl(base);
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new HttpClientError(response.status, `Exchange-rate provider failed with ${response.status}`);
  const body = await response.json() as {
    result?: string;
    base_code?: string;
    conversion_rates?: Record<string, number>;
    time_last_update_utc?: string | null;
    time_next_update_unix?: number | null;
  };
  if (body.result !== 'success' || !body.conversion_rates || typeof body.conversion_rates.EGP !== 'number') {
    throw new Error('Exchange-rate provider returned no conversion rates');
  }

  const entry: RateCache = {
    rates: body.conversion_rates,
    retrievedAt: body.time_last_update_utc ?? new Date().toISOString(),
    source: url,
    nextUpdateAt: body.time_next_update_unix
      ? new Date(body.time_next_update_unix * 1000).toISOString()
      : null,
    expiresAt: body.time_next_update_unix
      ? body.time_next_update_unix * 1000
      : Date.now() + env.EXCHANGE_RATES_CACHE_TTL_SECONDS * 1000,
  };
  cache.set(base, entry);
  await persistCache();
  return entry;
}

export async function getExchangeRates(base: CurrencyCode) {
  try {
    const result = await fetchRates(base);
    return {
      base,
      rates: result.rates,
      retrievedAt: result.retrievedAt,
      source: result.source,
      nextUpdateAt: result.nextUpdateAt,
      available: true,
    };
  } catch {
    const cached = cache.get(base);
    if (cached) {
      return {
        base,
        rates: cached.rates,
        retrievedAt: cached.retrievedAt,
        source: cached.source,
        nextUpdateAt: cached.nextUpdateAt,
        available: false,
        stale: true,
      };
    }
    return { base, rates: null, retrievedAt: null, source: null, nextUpdateAt: null, available: false, stale: false };
  }
}
