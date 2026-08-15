import { env } from '../config/env.js';
import { get } from '../utils/http-client.js';

export interface GeoContext {
  pois?: unknown;
  route?: unknown;
  geocode?: unknown;
}

export interface AreaNotice {
  active: boolean;
  class?: 'restricted' | 'caution' | 'protected';
  severity?: 'critical' | 'warning' | 'info';
  distance_meters?: number;
  guide_key: string;
  /** Legal-guide reference keys the client can resolve via GET /geo/law. */
  legal_keys?: Array<'drone' | 'photography' | 'entry' | 'safety'>;
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
  // `categories` arrives comma-joined (e.g. the frontend's heritage default
  // "archaeological,islamic,christian"). GeoContext only supports a SINGLE
  // category per query (`Site.categories.contains([category])`), so forwarding
  // a comma-joined string matches nothing. When more than one category is
  // requested, omit the filter entirely and let GeoContext return all public
  // sites within radius (filterPublicPois already strips restricted/military).
  const categoryList = categories?.split(',').map((c) => c.trim()).filter(Boolean);
  if (categoryList && categoryList.length === 1) params.category = categoryList[0];
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

interface GisContextZone {
  advisory_type?: string | null;
  zone_type?: string | null;
  distance_meters?: number | null;
}

interface GisContextResponse {
  in_egypt?: boolean;
  area_advisories?: GisContextZone[];
  nearby_zone_guidance?: GisContextZone[];
}

const ZONE_SEVERITY: Record<string, AreaNotice['severity']> = {
  restricted: 'critical',
  caution: 'warning',
  protected: 'info',
};

/** Legal topics per zone class — resolved client-side via GET /geo/law. */
const ZONE_LEGAL: Record<NonNullable<AreaNotice['class']>, AreaNotice['legal_keys']> = {
  restricted: ['drone', 'photography', 'entry'],
  caution: ['drone', 'photography', 'safety'],
  protected: ['photography', 'entry', 'safety'],
};

function normalizeZoneClass(value: unknown): NonNullable<AreaNotice['class']> {
  const raw = String(value || '').toLowerCase();
  if (raw === 'caution') return 'caution';
  if (raw === 'protected') return 'protected';
  return 'restricted';
}

function mapAreaNotice(context: GisContextResponse): AreaNotice {
  const advisories = context?.area_advisories ?? [];
  if (advisories.length > 0) {
    const zone = advisories[0];
    const zoneClass = normalizeZoneClass(zone.advisory_type);
    return {
      active: true,
      class: zoneClass,
      severity: ZONE_SEVERITY[zoneClass] ?? 'warning',
      distance_meters: 0,
      guide_key: zoneClass,
      legal_keys: ZONE_LEGAL[zoneClass],
    };
  }
  const guidance = context?.nearby_zone_guidance ?? [];
  if (guidance.length > 0) {
    const nearest = guidance
      .filter((z) => typeof z.distance_meters === 'number')
      .sort((a, b) => (a.distance_meters ?? Infinity) - (b.distance_meters ?? Infinity))[0];
    const zoneClass = normalizeZoneClass(nearest.zone_type);
    return {
      active: true,
      class: zoneClass,
      severity: ZONE_SEVERITY[zoneClass] ?? 'warning',
      distance_meters: nearest.distance_meters ?? 0,
      guide_key: zoneClass,
      legal_keys: ZONE_LEGAL[zoneClass],
    };
  }
  return { active: false, guide_key: '' };
}

export async function fetchAreaNotice(lat: number, lon: number, radius?: number, authorization?: string): Promise<AreaNotice> {
  const base = env.GIS_SERVICE_URL;
  const headers: Record<string, string> = { 'X-Internal-Api-Key': env.INTERNAL_API_KEY };
  if (authorization) headers['Authorization'] = authorization;
  const params: Record<string, string | number> = { lat, lon };
  if (radius !== undefined) params.radius = radius;
  const context = await get<GisContextResponse>(`${base}/api/v1/context`, params, headers).catch(() => null);
  return mapAreaNotice(context ?? {});
}

export interface ZonePolygon {
  zone_type: 'restricted' | 'caution' | 'protected';
  severity: 'critical' | 'warning' | 'info';
  geometry: { type: string; coordinates: unknown };
}

export interface ZonesResult {
  lat: number;
  lon: number;
  radius_meters: number;
  zones: ZonePolygon[];
}

/** Anonymous polygons for the map overlay. Never exposes zone identity. */
export async function fetchZonePolygons(lat: number, lon: number, radius?: number, authorization?: string): Promise<ZonesResult> {
  const base = env.GIS_SERVICE_URL;
  const headers: Record<string, string> = { 'X-Internal-Api-Key': env.INTERNAL_API_KEY };
  if (authorization) headers['Authorization'] = authorization;
  const params: Record<string, string | number> = { lat, lon };
  if (radius !== undefined) params.radius = radius;
  const zones = await get<ZonesResult>(`${base}/api/v1/context/zones`, params, headers).catch(() => ({ zones: [] }));
  return { lat, lon, radius_meters: radius ?? 0, zones: zones?.zones ?? [] };
}

export interface LegalRule {
  heading: string;
  points: string[];
}

export interface LegalGuide {
  source: 'rag' | 'ai';
  class_name: 'restricted' | 'caution' | 'protected';
  title: string;
  summary: string;
  rules: LegalRule[];
  citations: string[];
  advice?: string | null;
}

/** Egyptian laws/guides for a zone class from ai-service RAG (+ optional AI advice). */
export async function fetchLegalGuide(class_name: NonNullable<AreaNotice['class']>, synthesize = true): Promise<LegalGuide | null> {
  const base = env.AI_SERVICE_URL;
  const headers: Record<string, string> = { 'X-Internal-Api-Key': env.INTERNAL_API_KEY };
  const guide = await get<LegalGuide>(
    `${base}/legal`,
    { class_name, synthesize: synthesize ? '1' : '0' },
    headers,
    15000,
  ).catch(() => null);
  return guide;
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
