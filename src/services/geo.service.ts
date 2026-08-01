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
  const headers: Record<string, string> = { 'X-Internal-Api-Key': env.INTERNAL_API_KEY };
  if (authorization) headers['Authorization'] = authorization;
  const params: Record<string, string | number> = { lat, lon };
  if (radius !== undefined) params.radius = radius;
  if (categories) params.category = categories;
  const pois = await get(`${base}/api/v1/nearby-sites`, params, headers).catch(() => null);

  return { pois } as GeoContext;
}

export async function fetchPois(lat: number, lon: number, radius?: number, categories?: string, authorization?: string): Promise<GeoContext> {
  const result = await fetchNearbySites(lat, lon, radius, categories, authorization);
  return { ...result, pois: filterPublicPois(result.pois) };
}

export async function fetchFullGeoContext(lat: number, lon: number, radius?: number, categories?: string, authorization?: string): Promise<GeoContext> {
  return fetchNearbySites(lat, lon, radius, categories, authorization);
}

export async function searchPlaces(
  query: string,
  category?: string,
  governorate?: string,
  limit?: number,
  authorization?: string
): Promise<GeoContext> {
  const base = env.GIS_SERVICE_URL;
  const headers: Record<string, string> = { 'X-Internal-Api-Key': env.INTERNAL_API_KEY };
  if (authorization) headers['Authorization'] = authorization;
  const params: Record<string, string | number> = { q: query };
  if (category) params.category = category;
  if (governorate) params.governorate = governorate;
  if (limit !== undefined) params.limit = limit;
  const pois = await get(`${base}/api/v1/search`, params, headers).catch(() => null);

  return { pois } as GeoContext;
}

export async function fetchSitesByGovernorate(governorateName: string, category?: string, limit?: number, authorization?: string): Promise<GeoContext> {
  const base = env.GIS_SERVICE_URL;
  const headers: Record<string, string> = { 'X-Internal-Api-Key': env.INTERNAL_API_KEY };
  if (authorization) headers['Authorization'] = authorization;
  const params: Record<string, string | number> = { governorate_name: governorateName };
  if (category) params.category = category;
  if (limit !== undefined) params.limit = limit;
  const pois = await get(`${base}/api/v1/nearby-sites/by-governorate`, params, headers).catch(() => null);

  return { pois } as GeoContext;
}

export async function fetchGovernorates(authorization?: string): Promise<unknown> {
  const base = env.GIS_SERVICE_URL;
  const headers: Record<string, string> = { 'X-Internal-Api-Key': env.INTERNAL_API_KEY };
  if (authorization) headers['Authorization'] = authorization;
  return get(`${base}/api/v1/boundaries`, { level: 'governorate' }, headers);
}

export async function fetchCountryBoundary(authorization?: string): Promise<unknown> {
  const base = env.GIS_SERVICE_URL;
  const headers: Record<string, string> = { 'X-Internal-Api-Key': env.INTERNAL_API_KEY };
  if (authorization) headers['Authorization'] = authorization;
  return get(`${base}/api/v1/boundaries`, { level: 'country' }, headers);
}

export async function fetchSiteById(id: string, authorization?: string): Promise<unknown> {
  const base = env.GIS_SERVICE_URL;
  const headers: Record<string, string> = { 'X-Internal-Api-Key': env.INTERNAL_API_KEY };
  if (authorization) headers['Authorization'] = authorization;
  return get(`${base}/api/v1/sites/${id}`, undefined, headers);
}
