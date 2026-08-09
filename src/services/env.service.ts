import { env } from '../config/env.js';

export interface EnvContext {
  weather?: unknown;
  airQuality?: unknown;
  prayerTimes?: unknown;
  holidays?: unknown;
  currency?: unknown;
  overview?: unknown;
}

function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseEvent(raw: Record<string, unknown>): {
  source: string;
  headline: string;
  category: string;
  severity: string;
  lat: number | null;
  lon: number | null;
} | null {
  if (!raw || typeof raw !== 'object') return null;
  const headline = String(raw.headline ?? raw.title ?? '');
  if (!headline) return null;
  return {
    source: String(raw.source ?? 'unknown'),
    headline,
    category: String(raw.category ?? 'advisory'),
    severity: String(raw.severity ?? 'info'),
    lat: typeof raw.lat === 'number' ? raw.lat : null,
    lon: typeof raw.lon === 'number' ? raw.lon : null,
  };
}

function extractWeatherFromCity(city: Record<string, unknown>): {
  weather: Record<string, unknown>;
  airQuality: Record<string, unknown>;
  overview: Record<string, unknown>;
} {
  const events = Array.isArray(city.events) ? city.events : [];
  let temperature: number | null = null;
  let uvIndex: number | null = null;
  let condition: string | null = null;
  let description: string | null = null;
  let aqi: number | null = null;

  for (const rawEvent of events) {
    if (!rawEvent || typeof rawEvent !== 'object') continue;
    const event = parseEvent(rawEvent as Record<string, unknown>);
    if (!event) continue;
    const headline = event.headline.toLowerCase();

    if (event.category === 'weather') {
      const tempMatch = headline.match(/(-?\d+(?:\.\d+)?)\s*°c\s*in/);
      if (tempMatch) {
        temperature = Number(tempMatch[1]);
        condition = condition ?? 'Clear';
        description = description ?? 'clear sky';
        continue;
      }
      const uvMatch = headline.match(/uv index\s+(\d+(?:\.\d+)?)/);
      if (uvMatch) {
        uvIndex = Number(uvMatch[1]);
        continue;
      }
    }

    if (event.source === 'openweather_air' || event.category === 'weather' || event.category === 'air_quality') {
      const aqiMatch = headline.match(/aqi\s+(\d+(?:\.\d+)?)/);
      if (aqiMatch) {
        aqi = Number(aqiMatch[1]);
      }
    }
  }

  const weather: Record<string, unknown> = {};
  if (temperature !== null) {
    weather.temperature = temperature;
    weather.temp = temperature;
  }
  if (uvIndex !== null) {
    weather.uvIndex = uvIndex;
    weather.uv_index = uvIndex;
  }
  if (condition) {
    weather.condition = condition;
    weather.summary = condition;
  }
  if (description) weather.description = description;

  const airQuality: Record<string, unknown> = {};
  if (aqi !== null) {
    airQuality.aqi = aqi;
    airQuality.index = aqi;
    airQuality.us_aqi = aqi;
  }

  const overview: Record<string, unknown> = {};
  if (temperature !== null) overview.temperature = temperature;
  if (uvIndex !== null) overview.uvIndex = uvIndex;
  if (aqi !== null) overview.aqi = aqi;
  if (condition) overview.summary = condition;

  return { weather, airQuality, overview };
}

export async function fetchEnvContext(
  lat: number,
  lon: number,
  authorization?: string,
): Promise<EnvContext> {
  const headers: Record<string, string> = { 'X-Internal-Api-Key': env.INTERNAL_API_KEY };
  if (authorization) headers['Authorization'] = authorization;

  try {
    const res = await fetch(`${env.RISK_SERVICE_URL}/safety/current`, {
      headers,
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return {};

    const payload = (await res.json()) as Record<string, unknown>;
    const cityMap = (payload?.safety ?? payload) as Record<string, unknown>;
    if (!cityMap || typeof cityMap !== 'object') return {};

    // Pick the closest city to the requested coordinates.
    let bestCity: Record<string, unknown> | null = null;
    let bestDist = Infinity;
    for (const v of Object.values(cityMap)) {
      if (!v || typeof v !== 'object') continue;
      const city = v as Record<string, unknown>;
      const cLat = typeof city.lat === 'number' ? city.lat : null;
      const cLon = typeof city.lon === 'number' ? city.lon : null;
      if (cLat === null || cLon === null) {
        bestCity = bestCity ?? city;
        continue;
      }
      const dist = distanceKm(lat, lon, cLat, cLon);
      if (dist < bestDist) {
        bestDist = dist;
        bestCity = city;
      }
    }
    if (!bestCity) return {};

    const { weather, airQuality, overview } = extractWeatherFromCity(bestCity);
    const updatedAt =
      typeof bestCity.updatedAt === 'string' ? bestCity.updatedAt : new Date().toISOString();

    return {
      weather,
      airQuality,
      overview: { ...overview, updatedAt },
      prayerTimes: {},
      holidays: {},
      currency: {},
    };
  } catch {
    return {};
  }
}
