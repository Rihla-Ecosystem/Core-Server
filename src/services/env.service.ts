import { env } from '../config/env.js';
import { get } from '../utils/http-client.js';

export interface EnvContext {
  weather?: unknown;
  airQuality?: unknown;
  prayerTimes?: unknown;
  holidays?: unknown;
  currency?: unknown;
  overview?: unknown;
}

export async function fetchEnvContext(lat: number, lon: number, authorization?: string): Promise<EnvContext> {
  const base = env.CONTEXT_SERVICE_URL;
  const headers = authorization ? { Authorization: authorization } : undefined;

  const [weather, airQuality, prayerTimes, overview] = await Promise.all([
    get(`${base}/weather`, { lat, lon }, headers).catch(() => null),
    get(`${base}/air-quality`, { lat, lon }, headers).catch(() => null),
    get(`${base}/prayer-times`, { lat, lon }, headers).catch(() => null),
    get(`${base}/overview`, { lat, lon }, headers).catch(() => null),
  ]);

  return { weather, airQuality, prayerTimes, overview };
}
