import { env } from '../config/env.js';
import { get } from '../utils/http-client.js';

export interface GeoContext {
  pois?: unknown;
  route?: unknown;
  geocode?: unknown;
}

const blockedTypes = new Set(['infrastructure', 'restricted', 'military']);

function filterPublicPois(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.filter((item) => {
    if (!item || typeof item !== 'object') return true;
    const record = item as Record<string, unknown>;
    const type = String(record.site_type ?? record.siteType ?? record.category ?? record.type ?? '').toLowerCase();
    return !blockedTypes.has(type) && !type.includes('military') && !type.includes('restricted');
  });
}

async function fetchNearbySites(lat: number, lon: number, radius?: number, categories?: string, authorization?: string): Promise<GeoContext> {
  const base = env.GIS_SERVICE_URL;
  const pois = await get(`${base}/api/v1/nearby-sites`, { latitude: lat, longitude: lon, radius, categories }, authorization ? { Authorization: authorization } : undefined).catch(() => null);

  return { pois } as GeoContext;
}

export async function fetchPois(lat: number, lon: number, radius?: number, categories?: string, authorization?: string): Promise<GeoContext> {
  const result = await fetchNearbySites(lat, lon, radius, categories, authorization);
  return { ...result, pois: filterPublicPois(result.pois) };
}

export async function fetchFullGeoContext(lat: number, lon: number, radius?: number, categories?: string, authorization?: string): Promise<GeoContext> {
  return fetchNearbySites(lat, lon, radius, categories, authorization);
}

export async function searchPlaces(query: string, lat?: number, lon?: number, authorization?: string): Promise<GeoContext> {
  const base = env.GIS_SERVICE_URL;

  const geocode = await get(`${base}/api/v1/context`, { q: query, latitude: lat, longitude: lon }, authorization ? { Authorization: authorization } : undefined).catch(() => null);

  return { geocode } as GeoContext;
}
