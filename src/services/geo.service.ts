import { env } from '../config/env.js';
import { get } from '../utils/http-client.js';

export interface GeoContext {
  pois?: unknown[];
  route?: unknown;
  geocode?: unknown;
}

export async function fetchPois(lat: number, lon: number, radius?: number, categories?: string): Promise<GeoContext> {
  const base = env.GIS_SERVICE_URL;

  const pois = await get(`${base}/pois`, { lat, lon, radius, categories }).catch(() => null);

  return { pois } as GeoContext;
}

export async function searchPlaces(query: string, lat?: number, lon?: number): Promise<GeoContext> {
  const base = env.GIS_SERVICE_URL;

  const geocode = await get(`${base}/search`, { q: query, lat, lon }).catch(() => null);

  return { geocode } as GeoContext;
}
