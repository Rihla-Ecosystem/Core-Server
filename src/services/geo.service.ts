import { env } from '../config/env.js';
import { get } from '../utils/http-client.js';

/* ── Types ────────────────────────────────────────────────────── */

export interface NearbySite {
  id: string;
  name: string;
  name_en: string | null;
  name_ar: string | null;
  categories: string[];
  details: Record<string, unknown> | null;
  governorate: string | null;
  distance_meters: number;
  lat: number;
  lon: number;
}

export interface SpatialContext {
  is_within_egypt: boolean;
  governorate: string | null;
  current_site: unknown | null;
  nearby_sites: NearbySite[];
  restricted_zones: unknown[];
}

/* ── Internal auth header ─────────────────────────────────────── */

function internalHeaders(): Record<string, string> {
  return { 'X-Internal-Api-Key': env.INTERNAL_API_KEY };
}

/* ── Service functions ────────────────────────────────────────── */

/**
 * GET /api/v1/nearby-sites?lat=&lon=&radius=&category=
 * Returns nearby archaeological/tourist sites within a radius.
 */
export async function fetchNearbySites(
  lat: number,
  lon: number,
  radius?: number,
  category?: string,
): Promise<NearbySite[]> {
  const base = env.GIS_SERVICE_URL;
  return get<NearbySite[]>(
    `${base}/api/v1/nearby-sites`,
    { lat, lon, radius, category },
    internalHeaders(),
  ).catch(() => []);
}

/**
 * GET /api/v1/context?lat=&lon=&radius=
 * Returns full spatial context (governorate, current site, nearby, restricted zones).
 */
export async function fetchSpatialContext(
  lat: number,
  lon: number,
  radius?: number,
): Promise<SpatialContext | null> {
  const base = env.GIS_SERVICE_URL;
  return get<SpatialContext>(
    `${base}/api/v1/context`,
    { lat, lon, radius },
    internalHeaders(),
  ).catch(() => null);
}

/**
 * GET /api/v1/nearby-sites/by-governorate?governorate_name=&category=
 * Returns sites filtered by governorate name.
 */
export async function fetchSitesByGovernorate(
  governorateName: string,
  category?: string,
): Promise<NearbySite[]> {
  const base = env.GIS_SERVICE_URL;
  return get<NearbySite[]>(
    `${base}/api/v1/nearby-sites/by-governorate`,
    { governorate_name: governorateName, category },
    internalHeaders(),
  ).catch(() => []);
}
