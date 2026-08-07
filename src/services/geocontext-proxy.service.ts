import { env } from '../config/env.js';
import { get, post, put, del } from '../utils/http-client.js';

const GIS_BASE = env.GIS_SERVICE_URL;

interface AuthHeaders {
  Authorization?: string;
}

function internalHeaders(authorization?: string): Record<string, string> {
  const headers: Record<string, string> = { 'X-Internal-Api-Key': env.INTERNAL_API_KEY };
  if (authorization) headers['Authorization'] = authorization;
  return headers;
}

interface GeoQuery {
  page?: number;
  limit?: number;
  search?: string;
  category?: string;
  governorate?: string;
  status?: string;
  risk?: string;
  hasWarnings?: boolean;
  updatedSince?: string;
  sortBy?: string;
  sortOrder?: string;
}

interface PaginatedLocations {
  data: unknown[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

interface GeoLocation {
  id: string;
  nameEn: string;
  nameAr?: string | null;
  description?: string | null;
  category: string;
  governorate?: string | null;
  city?: string | null;
  country?: string | null;
  address?: string | null;
  lat: number;
  lng: number;
  safetyScore: number;
  riskLevel: string;
  status: string;
  visibility?: string | null;
  aiSummary?: string | null;
  publishedAt?: string | null;
  createdBy?: string | null;
  updatedBy?: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  tags?: string[];
  customMetadata?: Record<string, string>;
  interestingFacts?: string[];
  ticket?: Record<string, unknown> | null;
  openingHours?: Record<string, unknown>;
  contact?: Record<string, unknown> | null;
  localLaws?: string | null;
  notes?: string | null;
  unescoStatus?: string | null;
  localTips?: string | null;
  droneRules?: string | null;
  photographyRules?: string | null;
  accessibility?: string | null;
  transportationTips?: string | null;
  emergencyInstructions?: string | null;
  bestTimeToVisit?: string | null;
  culturalInfo?: string | null;
  touristDescription?: string | null;
  history?: string | null;
  estimatedDurationMinutes?: number | null;
  documents?: Array<Record<string, unknown>>;
  attachments?: Array<Record<string, unknown>>;
  externalLinks?: Array<Record<string, unknown>>;
  warnings: Array<Record<string, unknown>>;
  nearby: Array<Record<string, unknown>>;
}

interface LocationInput {
  nameEn: string;
  nameAr?: string;
  description?: string;
  category?: string;
  governorate?: string;
  city?: string;
  country?: string;
  address?: string;
  lat: number;
  lng: number;
  safetyScore?: number;
  riskLevel?: string;
  status?: string;
  visibility?: string;
  aiSummary?: string;
  publishedAt?: string;
  tags?: string[];
  customMetadata?: Record<string, string>;
  interestingFacts?: string[];
  ticket?: Record<string, unknown>;
  openingHours?: Record<string, unknown>;
  contact?: Record<string, unknown>;
  localLaws?: string;
  notes?: string;
  unescoStatus?: string;
  localTips?: string;
  droneRules?: string;
  photographyRules?: string;
  accessibility?: string;
  transportationTips?: string;
  emergencyInstructions?: string;
  bestTimeToVisit?: string;
  culturalInfo?: string;
  touristDescription?: string;
  history?: string;
  estimatedDurationMinutes?: number;
  documents?: Array<Record<string, unknown>>;
  attachments?: Array<Record<string, unknown>>;
  externalLinks?: Array<Record<string, unknown>>;
}

interface Boundary {
  id: string;
  name: string;
  description?: string;
  type: 'governorate' | 'city' | 'custom';
  polygon: Array<{ lat: number; lng: number }>;
  createdAt: string;
}

interface RestrictedZone {
  id: string;
  name: string;
  description: string;
  restrictionType: string;
  riskLevel: string;
  allowedActivities: string[];
  forbiddenActivities: string[];
  active: boolean;
  polygon: Array<{ lat: number; lng: number }>;
  createdAt: string;
  updatedAt: string;
  source?: string;
}

interface GeoAnalytics {
  totalLocations: number;
  touristPlaces: number;
  restrictedAreas: number;
  activeWarnings: number;
  governoratesCoverage: number;
  recentlyUpdated: number;
  byCategory: { category: string; count: number }[];
  warningsBySeverity: { severity: string; count: number }[];
  topUpdated: { id: string; name: string; updatedAt: string }[];
}

interface ActivityEvent {
  id: string;
  type: 'location' | 'warning' | 'zone' | 'boundary' | 'system';
  action: string;
  actor: string;
  targetId?: string;
  targetName?: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

interface GovernorateInfo {
  name: string;
  nameEn?: string | null;
  nameAr?: string | null;
}

interface GeoJSONFeatureCollection {
  type: 'FeatureCollection';
  name?: string;
  features: Array<{
    type: 'Feature';
    geometry: { type: string; coordinates: number[] | number[][] | number[][][] };
    properties: Record<string, unknown>;
  }>;
}

function _geojsonToPolygon(geojson: unknown): Array<{ lat: number; lng: number }> {
  if (!geojson || typeof geojson !== 'object') return [];
  const geom = geojson as { type?: string; coordinates?: unknown };
  if (geom.type === 'Polygon' && Array.isArray(geom.coordinates)) {
    const ring = (geom.coordinates as number[][][])[0] || [];
    return ring.map((coord: number[]) => ({ lat: coord[1], lng: coord[0] }));
  }
  if (geom.type === 'MultiPolygon' && Array.isArray(geom.coordinates)) {
    const ring = ((geom.coordinates as number[][][][])[0]?.[0]) || [];
    return ring.map((coord: number[]) => ({ lat: coord[1], lng: coord[0] }));
  }
  return [];
}

function _isoDate(dateStr?: string | null): string {
  return dateStr && !isNaN(Date.parse(dateStr)) ? new Date(dateStr).toISOString() : new Date().toISOString();
}

/**
 * Normalize a raw location record returned by the GIS service so the dashboard
 * always receives the full camelCase shape it expects. The GIS service does not
 * emit fields like images/videos/versions/auditLog/relatedLocationIds, which
 * previously caused "Cannot read properties of undefined" crashes in the UI.
 */
function _transformLocation(raw: Record<string, unknown>): Record<string, unknown> {
  const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  const obj = (value: unknown, fallback: Record<string, unknown>): Record<string, unknown> =>
    value && typeof value === 'object' ? (value as Record<string, unknown>) : fallback;
  return {
    ...raw,
    images: arr(raw.images),
    videos: arr(raw.videos),
    versions: arr(raw.versions),
    auditLog: arr(raw.auditLog),
    relatedLocationIds: arr(raw.relatedLocationIds),
    tags: arr(raw.tags),
    warnings: arr(raw.warnings),
    nearby: arr(raw.nearby),
    documents: arr(raw.documents),
    attachments: arr(raw.attachments),
    externalLinks: arr(raw.externalLinks),
    interestingFacts: arr(raw.interestingFacts),
    customMetadata: obj(raw.customMetadata, {}),
    openingHours: obj(raw.openingHours, {}),
    ticket: raw.ticket && typeof raw.ticket === 'object' ? raw.ticket : {},
    contact: raw.contact && typeof raw.contact === 'object' ? raw.contact : {},
  };
}

function _transformLocationList(data: unknown): PaginatedLocations {
  const payload = (data ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(payload.data) ? (payload.data as Record<string, unknown>[]) : [];
  return {
    data: rows.map((row) => _transformLocation(row)) as unknown as GeoLocation[],
    total: typeof payload.total === 'number' ? payload.total : rows.length,
    page: typeof payload.page === 'number' ? payload.page : 1,
    limit: typeof payload.limit === 'number' ? payload.limit : rows.length,
    totalPages: typeof payload.totalPages === 'number' ? payload.totalPages : 1,
  };
}

function _transformBoundary(raw: Record<string, unknown>): Boundary {
  const geojson = raw.geometry_geojson || raw.geometryGeojson;
  const details = raw.details as Record<string, unknown> | undefined;
  const type = (details?.type as Boundary['type'] | undefined) ?? (raw.level as Boundary['type']) ?? 'custom';
  return {
    id: String(raw.id || ''),
    name: String(raw.nameEn || raw.name || ''),
    description: String(raw.description || details?.description || ''),
    type,
    polygon: _geojsonToPolygon(geojson),
    createdAt: _isoDate((raw.created_at || raw.createdAt) as string | null),
  };
}

/** Map a dashboard Boundary payload ({name, description, type, polygon}) to the GIS service schema. */
function _transformBoundaryInput(input: Record<string, unknown>): Record<string, unknown> {
  const { name, nameEn, nameAr, description, type, polygon, ...rest } = input;
  const out: Record<string, unknown> = { ...rest };
  if (name !== undefined) out.name = name;
  if (nameEn !== undefined) out.nameEn = nameEn;
  if (nameAr !== undefined) out.nameAr = nameAr;
  if (type !== undefined) out.type = type;
  if (description !== undefined) out.description = description;
  if (Array.isArray(polygon)) out.polygon = polygon;
  return out;
}

function _transformZone(raw: Record<string, unknown>): RestrictedZone {
  const geojson = raw.geometry_geojson || raw.geometryGeojson;
  const subtype = String(raw.subtype || 'custom');
  const zoneType = String(raw.zone_type || raw.zoneType || 'restricted');

  const restrictionTypeMap: Record<string, string> = {
    military: 'military',
    protected: 'environmental',
    manual_risk: 'security',
    informal_settlement: 'custom',
  };
  const details = raw.details as Record<string, unknown> | undefined;
  const restrictionType = String(details?.restrictionType ?? restrictionTypeMap[subtype] ?? subtype);
  const riskLevel = String(details?.riskLevel ?? raw.risk_level ?? 'medium');

  const strList = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);

  return {
    id: String(raw.id || ''),
    name: String(details?.name ?? raw.name ?? 'Unnamed Zone'),
    description: String(details?.description ?? raw.reason ?? ''),
    restrictionType: restrictionType as RestrictedZone['restrictionType'],
    riskLevel: riskLevel as RestrictedZone['riskLevel'],
    allowedActivities: strList(details?.allowedActivities),
    forbiddenActivities: strList(details?.forbiddenActivities),
    active: typeof details?.active === 'boolean' ? details.active : true,
    polygon: _geojsonToPolygon(geojson),
    createdAt: _isoDate((raw.created_at || raw.createdAt) as string | null),
    updatedAt: _isoDate((raw.updated_at || raw.updatedAt) as string | null),
    source: String(raw.source || 'manual'),
  };
}

/** Map a dashboard RestrictedZone payload to the GIS service schema. */
function _transformZoneInput(input: Record<string, unknown>): Record<string, unknown> {
  const {
    name, description, restrictionType, riskLevel,
    allowedActivities, forbiddenActivities, active, polygon,
    ...rest
  } = input;
  const out: Record<string, unknown> = { ...rest };
  if (name !== undefined) out.name = name;
  if (description !== undefined) out.description = description;
  if (restrictionType !== undefined) out.restrictionType = restrictionType;
  if (riskLevel !== undefined) out.riskLevel = riskLevel;
  if (allowedActivities !== undefined) out.allowedActivities = allowedActivities;
  if (forbiddenActivities !== undefined) out.forbiddenActivities = forbiddenActivities;
  if (active !== undefined) out.active = active;
  if (Array.isArray(polygon)) out.polygon = polygon;
  return out;
}

export const geocontextProxyApi = {
  async getLocations(params: GeoQuery, authorization?: string): Promise<PaginatedLocations> {
    const searchParams: Record<string, string | number | undefined> = {
      page: params.page,
      limit: params.limit,
      search: params.search,
      category: params.category,
      governorate: params.governorate,
      status: params.status,
      risk: params.risk,
      hasWarnings: params.hasWarnings !== undefined ? String(params.hasWarnings) : undefined,
      updatedSince: params.updatedSince,
      sortBy: params.sortBy,
      sortOrder: params.sortOrder,
    };
    const data = await get(`${GIS_BASE}/api/v1/locations`, searchParams, internalHeaders(authorization));
    return _transformLocationList(data);
  },

  async getLocation(id: string, authorization?: string): Promise<GeoLocation> {
    const data = await get(`${GIS_BASE}/api/v1/locations/${id}`, undefined, internalHeaders(authorization));
    return _transformLocation(data as Record<string, unknown>) as unknown as GeoLocation;
  },

  async createLocation(input: LocationInput, authorization?: string): Promise<GeoLocation> {
    const data = await post(`${GIS_BASE}/api/v1/locations`, input, internalHeaders(authorization));
    return _transformLocation(data as Record<string, unknown>) as unknown as GeoLocation;
  },

  async updateLocation(id: string, input: Partial<LocationInput>, authorization?: string): Promise<GeoLocation> {
    const data = await put(`${GIS_BASE}/api/v1/locations/${id}`, input, internalHeaders(authorization));
    return _transformLocation(data as Record<string, unknown>) as unknown as GeoLocation;
  },

  async deleteLocation(id: string, authorization?: string): Promise<void> {
    await del(`${GIS_BASE}/api/v1/locations/${id}`, internalHeaders(authorization));
  },

  async setLocationStatus(id: string, status: string, authorization?: string): Promise<GeoLocation> {
    const data = await put(`${GIS_BASE}/api/v1/locations/${id}/status`, { status }, internalHeaders(authorization));
    return _transformLocation(data as Record<string, unknown>) as unknown as GeoLocation;
  },

  async bulkSetLocationStatus(ids: string[], status: string, authorization?: string): Promise<{ updated: number }> {
    return await put(`${GIS_BASE}/api/v1/locations/bulk/status`, { ids, status }, internalHeaders(authorization));
  },

  async bulkDeleteLocations(ids: string[], authorization?: string): Promise<{ deleted: number }> {
    return await del(`${GIS_BASE}/api/v1/locations/bulk`, internalHeaders(authorization), undefined, { ids });
  },

  async addWarning(locationId: string, warning: Record<string, unknown>, authorization?: string): Promise<unknown> {
    return await post(`${GIS_BASE}/api/v1/locations/${locationId}/warnings`, warning, internalHeaders(authorization));
  },

  async deleteWarning(locationId: string, warningId: string, authorization?: string): Promise<void> {
    await del(`${GIS_BASE}/api/v1/locations/${locationId}/warnings/${warningId}`, internalHeaders(authorization));
  },

  async getRestrictedZones(authorization?: string): Promise<RestrictedZone[]> {
    const data = await get<Array<Record<string, unknown>>>(
      `${GIS_BASE}/api/v1/restricted-zones`, undefined, internalHeaders(authorization),
    );
    return data.map(_transformZone);
  },

  async createRestrictedZone(input: Record<string, unknown>, authorization?: string): Promise<RestrictedZone> {
    const data = await post<Record<string, unknown>>(
      `${GIS_BASE}/api/v1/restricted-zones`, _transformZoneInput(input), internalHeaders(authorization),
    );
    return _transformZone(data);
  },

  async updateRestrictedZone(id: string, input: Partial<RestrictedZone>, authorization?: string): Promise<RestrictedZone> {
    const data = await put<Record<string, unknown>>(
      `${GIS_BASE}/api/v1/restricted-zones/${id}`, _transformZoneInput(input), internalHeaders(authorization),
    );
    return _transformZone(data);
  },

  async deleteRestrictedZone(id: string, authorization?: string): Promise<void> {
    await del(`${GIS_BASE}/api/v1/restricted-zones/${id}`, internalHeaders(authorization));
  },

  async getBoundaries(authorization?: string): Promise<Boundary[]> {
    const data = await get<Array<Record<string, unknown>>>(
      `${GIS_BASE}/api/v1/boundaries`, undefined, internalHeaders(authorization),
    );
    return data.map(_transformBoundary);
  },

  async getBoundary(id: string, authorization?: string): Promise<Boundary> {
    const data = await get<Record<string, unknown>>(
      `${GIS_BASE}/api/v1/boundaries/${id}`, undefined, internalHeaders(authorization),
    );
    return _transformBoundary(data);
  },

  async createBoundary(input: Record<string, unknown>, authorization?: string): Promise<Boundary> {
    const data = await post<Record<string, unknown>>(
      `${GIS_BASE}/api/v1/boundaries`, _transformBoundaryInput(input), internalHeaders(authorization),
    );
    return _transformBoundary(data);
  },

  async updateBoundary(id: string, input: Record<string, unknown>, authorization?: string): Promise<Boundary> {
    const data = await put<Record<string, unknown>>(
      `${GIS_BASE}/api/v1/boundaries/${id}`, _transformBoundaryInput(input), internalHeaders(authorization),
    );
    return _transformBoundary(data);
  },

  async deleteBoundary(id: string, authorization?: string): Promise<void> {
    await del(`${GIS_BASE}/api/v1/boundaries/${id}`, internalHeaders(authorization));
  },

  async getGovernorates(authorization?: string): Promise<GovernorateInfo[]> {
    const data = await get(`${GIS_BASE}/api/v1/locations/governorates`, undefined, internalHeaders(authorization));
    return data as GovernorateInfo[];
  },

  async getAnalytics(authorization?: string): Promise<GeoAnalytics> {
    return await get(`${GIS_BASE}/api/v1/locations/analytics`, undefined, internalHeaders(authorization));
  },

  async getActivity(authorization?: string): Promise<ActivityEvent[]> {
    return await get(`${GIS_BASE}/api/v1/locations/activity`, undefined, internalHeaders(authorization));
  },

  async importGeoJSON(fc: GeoJSONFeatureCollection, authorization?: string): Promise<{ imported: number }> {
    return await post(`${GIS_BASE}/api/v1/locations/import/geojson`, fc, internalHeaders(authorization));
  },

  async exportGeoJSON(authorization?: string): Promise<GeoJSONFeatureCollection> {
    return await get(`${GIS_BASE}/api/v1/locations/export/geojson`, undefined, internalHeaders(authorization));
  },

  async getNearbyServices(locationId: string, authorization?: string): Promise<unknown[]> {
    return await get<unknown[]>(`${GIS_BASE}/api/v1/locations/${locationId}/nearby-services`, undefined, internalHeaders(authorization));
  },

  async addNearbyService(locationId: string, input: Record<string, unknown>, authorization?: string): Promise<unknown> {
    return await post(`${GIS_BASE}/api/v1/locations/${locationId}/nearby-services`, input, internalHeaders(authorization));
  },

  async deleteNearbyService(locationId: string, serviceId: string, authorization?: string): Promise<void> {
    await del(`${GIS_BASE}/api/v1/locations/${locationId}/nearby-services/${serviceId}`, internalHeaders(authorization));
  },
};
