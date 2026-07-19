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

export async function fetchEnvContext(lat: number, lon: number): Promise<EnvContext> {
  const base = env.CONTEXT_SERVICE_URL;

  const [weather, airQuality, prayerTimes, overview] = await Promise.all([
    get(`${base}/weather`, { lat, lon }).catch(() => null),
    get(`${base}/air-quality`, { lat, lon }).catch(() => null),
    get(`${base}/prayer-times`, { lat, lon }).catch(() => null),
    get(`${base}/overview`, { lat, lon }).catch(() => null),
  ]);

  return { weather, airQuality, prayerTimes, overview };
}
