// ---------------------------------------------------------------------------
// Context Aggregator
// ---------------------------------------------------------------------------
// Collects contextual information from GeoContext (GIS service), Risk
// Intelligence, and the user profile, then builds ONE complete Context Object
// that is handed to the AI Service for analysis. The AI never searches — it
// only analyzes the aggregated context.
import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { get } from '../utils/http-client.js';
import type {
  ContextObject,
  GeoContextPayload,
  NearbyPoi,
  RiskContext,
  RiskThreat,
  UserProfileContext,
  LocationPoint,
} from '../types/context-notification.js';

const GIS_BASE = env.GIS_SERVICE_URL;
const RISK_BASE = env.RISK_SERVICE_URL;

function internalHeaders(): Record<string, string> {
  return { 'X-Internal-Api-Key': env.INTERNAL_API_KEY };
}

// ---------------------------------------------------------------------------
// GeoContext
// ---------------------------------------------------------------------------

function toPoi(raw: Record<string, unknown>, kind: string): NearbyPoi {
  const details = (raw.details && typeof raw.details === 'object' ? raw.details : {}) as Record<string, unknown>;
  const categories = Array.isArray(raw.categories) ? (raw.categories as string[]) : [];
  const distance =
    typeof raw.distance_meters === 'number'
      ? raw.distance_meters
      : typeof raw.distanceMeters === 'number'
        ? raw.distanceMeters
        : undefined;
  return {
    name: String(raw.name ?? ''),
    nameEn: raw.name_en != null ? String(raw.name_en) : raw.nameEn != null ? String(raw.nameEn) : undefined,
    nameAr: raw.name_ar != null ? String(raw.name_ar) : raw.nameAr != null ? String(raw.nameAr) : undefined,
    categories,
    category: categories[0] ?? String(raw.category ?? kind),
    details,
    distanceMeters: distance,
    lat: typeof raw.lat === 'number' ? raw.lat : typeof raw.lat_ === 'number' ? raw.lat_ : undefined,
    lng: typeof raw.lon === 'number' ? raw.lon : typeof raw.lng === 'number' ? raw.lng : undefined,
    kind,
  };
}

const HOTEL_KEYWORDS = ['hotel', 'lodge', 'resort', 'inn', 'lodging', 'فندق'];
const RESTAURANT_KEYWORDS = ['restaurant', 'cafe', 'coffee', 'food', 'diner', 'مطعم', 'كافيه', 'قهوة'];
const HOSPITAL_KEYWORDS = ['hospital', 'clinic', 'medical', 'pharmacy', 'health', 'مستشفى', 'عيادة', 'صيدلية'];
const POLICE_KEYWORDS = ['police', 'security', 'military', 'شرطة', 'أمن'];
const TRANSPORT_KEYWORDS = ['station', 'transport', 'metro', 'bus', 'airport', 'terminal', 'stop', 'taxi', 'محطة', 'مواصلات', 'مترو', 'مطار'];
const HISTORICAL_KEYWORDS = ['historical', 'historic', 'temple', 'pyramid', 'mosque', 'church', 'museum', 'monument', 'castle', 'معبد', 'هرم', 'مسجد', 'كنيسة', 'متحف', 'قلعة', 'أثر'];

function matchesKeywords(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((k) => lower.includes(k.toLowerCase()));
}

function classifyPoi(poi: NearbyPoi): string {
  const haystack = [
    poi.name,
    poi.nameEn ?? '',
    poi.nameAr ?? '',
    ...(poi.categories ?? []),
    poi.category ?? '',
    poi.details && typeof poi.details === 'object'
      ? JSON.stringify(poi.details)
      : '',
  ].join(' ');
  if (matchesKeywords(haystack, POLICE_KEYWORDS)) return 'police';
  if (matchesKeywords(haystack, HOSPITAL_KEYWORDS)) return 'hospital';
  if (matchesKeywords(haystack, HOTEL_KEYWORDS)) return 'hotel';
  if (matchesKeywords(haystack, RESTAURANT_KEYWORDS)) return 'restaurant';
  if (matchesKeywords(haystack, TRANSPORT_KEYWORDS)) return 'transportation';
  if (matchesKeywords(haystack, HISTORICAL_KEYWORDS)) return 'historical';
  return 'attraction';
}

async function fetchGeoContext(lat: number, lng: number): Promise<GeoContextPayload> {
  try {
    const raw = await get<Record<string, unknown>>(
      `${GIS_BASE}/api/v1/context`,
      { lat, lon: lng, radius: 1500 },
      internalHeaders(),
    );

    const atSiteRaw = raw.at_site && typeof raw.at_site === 'object' ? (raw.at_site as Record<string, unknown>) : null;
    const nearbyRaw = Array.isArray(raw.nearby_sites) ? (raw.nearby_sites as Record<string, unknown>[]) : [];
    const servicesRaw = Array.isArray(raw.nearby_services) ? (raw.nearby_services as Record<string, unknown>[]) : [];
    const advisories = Array.isArray(raw.area_advisories) ? (raw.area_advisories as Record<string, unknown>[]) : [];

    const allPois = [
      ...(atSiteRaw ? [toPoi(atSiteRaw, 'attraction')] : []),
      ...nearbyRaw.map((n) => toPoi(n, 'attraction')),
      ...servicesRaw.map((n) => toPoi(n, 'service')),
    ];

    const hotels: NearbyPoi[] = [];
    const restaurants: NearbyPoi[] = [];
    const hospitals: NearbyPoi[] = [];
    const police: NearbyPoi[] = [];
    const transport: NearbyPoi[] = [];
    const historical: NearbyPoi[] = [];
    const attractions: NearbyPoi[] = [];

    for (const poi of allPois) {
      switch (classifyPoi(poi)) {
        case 'hotel': hotels.push(poi); break;
        case 'restaurant': restaurants.push(poi); break;
        case 'hospital': hospitals.push(poi); break;
        case 'police': police.push(poi); break;
        case 'transportation': transport.push(poi); break;
        case 'historical': historical.push(poi); break;
        default: attractions.push(poi); break;
      }
    }

    const restrictedAreas = advisories.map((a) => ({
      name: a.name != null ? String(a.name) : undefined,
      type: a.advisory_type != null ? String(a.advisory_type) : undefined,
      subtype: a.subtype != null ? String(a.subtype) : undefined,
      reason: a.reason != null ? String(a.reason) : undefined,
      source: a.source != null ? String(a.source) : undefined,
    }));

    const photographyRestrictions = [
      ...advisories
        .filter((a) => {
          const t = String(a.subtype ?? a.advisory_type ?? '').toLowerCase();
          return t.includes('photo') || t.includes('photography');
        })
        .map((a) => String(a.name ?? a.reason ?? 'Photography restricted in this area')),
    ];

    const atSite = atSiteRaw ? toPoi(atSiteRaw, 'attraction') : null;

    return {
      inEgypt: typeof raw.in_egypt === 'boolean' ? raw.in_egypt : true,
      currentArea: raw.governorate != null ? String(raw.governorate) : undefined,
      governorate: raw.governorate != null ? String(raw.governorate) : undefined,
      atSite,
      nearbyAttractions: attractions,
      nearbyServices: servicesRaw.map((n) => toPoi(n, 'service')),
      nearbyHotels: hotels,
      nearbyRestaurants: restaurants,
      nearbyHospitals: hospitals,
      nearbyPoliceStations: police,
      nearbyTransportation: transport,
      historicalPlaces: historical,
      photographyRestrictions,
      restrictedAreas,
      tourismInfo:
        atSite?.details && typeof atSite.details === 'object'
          ? (() => {
              const d = atSite.details as Record<string, unknown>;
              const v = d.tourist_description ?? d.tourism_info;
              return typeof v === 'string' ? v : null;
            })()
          : null,
      areaAdvisories: advisories,
    };
  } catch (err) {
    // GeoContext is a best-effort upstream; never fail the whole context.
    return {
      inEgypt: true,
      nearbyAttractions: [],
      nearbyServices: [],
      nearbyHotels: [],
      nearbyRestaurants: [],
      nearbyHospitals: [],
      nearbyPoliceStations: [],
      nearbyTransportation: [],
      historicalPlaces: [],
      photographyRestrictions: [],
      restrictedAreas: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Risk Intelligence
// ---------------------------------------------------------------------------

function nearestCityKey(lat: number, lng: number): string {
  const cities: Record<string, { lat: number; lng: number }> = {
    cairo: { lat: 30.0444, lng: 31.2357 },
    giza: { lat: 29.9773, lng: 31.1325 },
    alexandria: { lat: 31.2001, lng: 29.9187 },
    luxor: { lat: 25.6872, lng: 32.6396 },
    aswan: { lat: 24.0889, lng: 32.8998 },
    hurghada: { lat: 27.2579, lng: 33.8116 },
    sharm_el_sheikh: { lat: 27.9158, lng: 34.33 },
    dahab: { lat: 28.5091, lng: 34.5136 },
    marsa_alam: { lat: 25.0676, lng: 34.879 },
    el_gouna: { lat: 27.3942, lng: 33.6783 },
    siwa_oasis: { lat: 29.2032, lng: 25.5197 },
  };
  let best = 'cairo';
  let bestDist = Number.POSITIVE_INFINITY;
  for (const [key, coords] of Object.entries(cities)) {
    const d = Math.hypot(coords.lat - lat, coords.lng - lng);
    if (d < bestDist) {
      bestDist = d;
      best = key;
    }
  }
  return best;
}

function deriveRiskLevel(overall: string | undefined, threats: RiskThreat[]): string {
  if (overall) return overall;
  const ranks: Record<string, number> = { info: 0, advisory: 1, warning: 2, critical: 3 };
  let worst = 0;
  for (const t of threats) {
    const r = ranks[t.severity ?? ''] ?? 0;
    if (r > worst) worst = r;
  }
  return worst === 0 ? 'info' : worst === 1 ? 'advisory' : worst === 2 ? 'warning' : 'critical';
}

function safetyScoreFromRisk(riskLevel: string): number {
  const map: Record<string, number> = {
    info: 92,
    advisory: 78,
    warning: 58,
    critical: 32,
  };
  return map[riskLevel] ?? 70;
}

function normalizeThreat(raw: Record<string, unknown>): RiskThreat {
  return {
    source: raw.source != null ? String(raw.source) : undefined,
    category: raw.category != null ? String(raw.category) : undefined,
    severity: raw.severity != null ? String(raw.severity) : undefined,
    headline: raw.headline != null ? String(raw.headline) : undefined,
    detail: raw.detail != null ? String(raw.detail) : undefined,
    lat: typeof raw.lat === 'number' ? raw.lat : undefined,
    lon: typeof raw.lon === 'number' ? raw.lon : undefined,
    effectiveTime: raw.effectiveTime != null ? String(raw.effectiveTime) : undefined,
    expiresTime: raw.expiresTime != null ? String(raw.expiresTime) : undefined,
  };
}

async function fetchRiskContext(lat: number, lng: number): Promise<RiskContext> {
  try {
    const city = nearestCityKey(lat, lng);
    const raw = await get<Record<string, unknown>>(
      `${RISK_BASE}/safety/current`,
      { city },
      internalHeaders(),
    );

    const events = Array.isArray(raw.events) ? (raw.events as Record<string, unknown>[]).map(normalizeThreat) : [];
    const overall = typeof raw.overallRisk === 'string' ? raw.overallRisk : undefined;
    const riskLevel = deriveRiskLevel(overall, events);

    const emergencyCategories = ['seismic', 'flood', 'fire', 'unrest', 'tsunami', 'crime'];
    const weatherCategories = ['weather'];

    return {
      riskLevel,
      safetyScore: safetyScoreFromRisk(riskLevel),
      threats: events,
      securityAlerts: events.filter((e) => (e.category ?? '').toLowerCase() === 'unrest' || (e.category ?? '').toLowerCase() === 'crime'),
      emergencyEvents: events.filter((e) => emergencyCategories.includes((e.category ?? '').toLowerCase())),
      crowdDensity: null,
      overallRisk: overall,
      staticNote: raw.staticNote != null ? String(raw.staticNote) : null,
      city,
    };
  } catch {
    return {
      riskLevel: 'info',
      safetyScore: 92,
      threats: [],
      securityAlerts: [],
      emergencyEvents: [],
      crowdDensity: null,
    };
  }
}

// ---------------------------------------------------------------------------
// User profile (from Core DB)
// ---------------------------------------------------------------------------

async function fetchUserProfile(userId: string): Promise<UserProfileContext> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      displayName: true,
      language: true,
      travelStyle: true,
      gender: true,
      nationality: true,
      budgetLevel: true,
      interests: true,
      tripHistories: { select: { destination: true, startDate: true, endDate: true } },
      userPreferences: { select: { key: true, value: true } },
      userFeedbacks: { select: { targetId: true, rating: true } },
    },
  });

  if (!user) {
    return { id: userId };
  }

  const languages = Array.isArray(user.language) ? (user.language as string[]) : [];
  const prefs = user.userPreferences.map((p) => ({ key: p.key, value: p.value }));

  return {
    id: user.id,
    displayName: user.displayName,
    preferredLanguage: languages[0] ?? 'en',
    travelPreferences: user.interests != null && Array.isArray(user.interests) ? (user.interests as string[]) : [],
    travelStyle: user.travelStyle ?? undefined,
    gender: user.gender ?? undefined,
    nationality: user.nationality,
    budgetLevel: user.budgetLevel,
    previousVisits: user.tripHistories.map((t) => ({
      destination: t.destination,
      startDate: t.startDate,
      endDate: t.endDate,
    })),
    favorites: user.userFeedbacks
      .filter((f) => f.targetId && f.rating && f.rating >= 4)
      .map((f) => String(f.targetId)),
    tripType: (prefs.find((p) => p.key === 'trip_type')?.value as string | undefined) ?? user.travelStyle ?? undefined,
    interests: user.interests != null && Array.isArray(user.interests) ? (user.interests as string[]) : [],
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function buildContextObject(
  userId: string,
  location: LocationPoint,
): Promise<ContextObject> {
  const [geoContext, riskContext, userProfile] = await Promise.all([
    fetchGeoContext(location.lat, location.lng),
    fetchRiskContext(location.lat, location.lng),
    fetchUserProfile(userId),
  ]);

  return {
    location,
    geoContext,
    riskContext,
    userProfile,
    collectedAt: new Date().toISOString(),
  };
}

export function contextSnapshot(context: ContextObject): Record<string, unknown> {
  return {
    location: context.location,
    geoContext: context.geoContext,
    riskContext: context.riskContext,
    userProfile: context.userProfile,
    collectedAt: context.collectedAt,
  };
}

export { classifyPoi };
