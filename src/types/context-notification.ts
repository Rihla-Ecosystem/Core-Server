// ---------------------------------------------------------------------------
// Context-Aware Notification System — shared types
// ---------------------------------------------------------------------------
// These types describe the single "Context Object" that the Context Engine
// (Core Backend) aggregates and sends to the AI Service for analysis. The AI
// only analyzes the received context — it never searches for information.

export interface LocationPoint {
  lat: number;
  lng: number;
  accuracy?: number;
  altitude?: number;
  speed?: number;
  heading?: number;
  timestamp?: number;
  /** Reason the frontend decided to send this update. */
  reason?: 'movement' | 'geofence_enter' | 'geofence_exit' | 'initial' | 'manual';
  /** Any GeoFences the client just entered/exited. */
  geofenceEvents?: GeofenceEvent[];
}

export interface GeofenceEvent {
  fenceId?: string;
  name?: string;
  type: 'enter' | 'exit';
  polygon: Array<{ lat: number; lng: number }>;
}

// ---- GeoContext (from the GIS service) ----

export interface NearbyPoi {
  name: string;
  nameEn?: string | null;
  nameAr?: string | null;
  categories?: string[];
  category?: string;
  details?: Record<string, unknown> | null;
  distanceMeters?: number;
  lat?: number;
  lng?: number;
  kind?: string;
}

export interface GeoContextPayload {
  inEgypt?: boolean;
  currentArea?: string;
  governorate?: string;
  city?: string;
  address?: string;
  zone?: string | null;
  polygon?: Array<{ lat: number; lng: number }>;
  atSite?: NearbyPoi | null;
  nearbyAttractions?: NearbyPoi[];
  nearbyServices?: NearbyPoi[];
  nearbyHotels?: NearbyPoi[];
  nearbyRestaurants?: NearbyPoi[];
  nearbyHospitals?: NearbyPoi[];
  nearbyPoliceStations?: NearbyPoi[];
  nearbyTransportation?: NearbyPoi[];
  historicalPlaces?: NearbyPoi[];
  photographyRestrictions?: string[];
  restrictedAreas?: Array<{
    name?: string | null;
    type?: string;
    subtype?: string;
    reason?: string | null;
    source?: string;
  }>;
  tourismInfo?: string | null;
  areaAdvisories?: Array<Record<string, unknown>>;
}

// ---- Risk Intelligence (from the Risk service) ----

export interface RiskThreat {
  source?: string;
  category?: string;
  severity?: string;
  headline?: string;
  detail?: string | null;
  lat?: number;
  lon?: number;
  effectiveTime?: string;
  expiresTime?: string | null;
}

export interface RiskContext {
  riskLevel?: string;
  safetyScore?: number;
  threats?: RiskThreat[];
  securityAlerts?: RiskThreat[];
  emergencyEvents?: RiskThreat[];
  crowdDensity?: number | null;
  overallRisk?: string;
  staticNote?: string | null;
  city?: string;
}

// ---- User Profile (from the Core DB) ----

export interface UserProfileContext {
  id?: string;
  displayName?: string;
  preferredLanguage?: string;
  travelPreferences?: string[];
  travelStyle?: string;
  gender?: string;
  nationality?: string;
  budgetLevel?: string | null;
  previousVisits?: Array<Record<string, unknown>>;
  favorites?: string[];
  tripType?: string;
  interests?: string[];
}

// ---- Aggregated Context Object ----

export interface ContextObject {
  location: LocationPoint;
  geoContext: GeoContextPayload;
  riskContext: RiskContext;
  userProfile: UserProfileContext;
  collectedAt: string;
}

// ---- AI Service analysis result ----

export const AI_REPORT_SECTIONS = [
  'executiveSummary',
  'currentSituation',
  'safetyAssessment',
  'riskAnalysis',
  'personalizedRecommendations',
  'touristTips',
  'historicalSummary',
  'interestingFacts',
  'thingsToAvoid',
  'recommendedActions',
  'emergencyInstructions',
] as const;

export type AIReportSection = (typeof AI_REPORT_SECTIONS)[number];

export interface ContextAnalysisResult {
  executiveSummary: string;
  currentSituation: string;
  safetyAssessment: string;
  riskAnalysis: string;
  personalizedRecommendations: string[];
  touristTips: string[];
  historicalSummary: string;
  interestingFacts: string[];
  thingsToAvoid: string[];
  recommendedActions: string[];
  emergencyInstructions: string[];
}

// ---- Generated Notifications ----

export type NotificationRuleName =
  | 'entering_restricted_area'
  | 'approaching_restricted_area'
  | 'photography_restricted'
  | 'entering_dangerous_area'
  | 'nearby_emergency'
  | 'nearby_tourist_attraction'
  | 'nearby_historical_site'
  | 'severe_weather'
  | 'heavy_traffic';

export interface GeneratedNotification {
  id?: string;
  title: string;
  message: string;
  type: 'INFO' | 'SUCCESS' | 'WARNING' | 'ERROR' | 'SYSTEM';
  category: 'SAFETY' | 'SECURITY' | 'WEATHER' | 'TRAFFIC' | 'TOURIST' | 'HISTORICAL' | 'EMERGENCY' | 'RESTRICTED_AREA' | 'PHOTOGRAPHY' | 'RECOMMENDATION' | 'SYSTEM';
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL';
  source: 'SYSTEM' | 'AI' | 'ADMIN' | 'CONTEXT' | 'EMERGENCY';
  cooldownKey: string;
  lat?: number;
  lng?: number;
  data?: Record<string, unknown>;
}

// ---- Smart Engine output ----

export interface ContextEngineResult {
  notifications: GeneratedNotification[];
  contextReport: {
    areaInformation: Record<string, unknown>;
    aiSummary: ContextAnalysisResult;
    safetyScore: number;
    riskLevel: string;
    historicalInformation: string;
    touristTips: string[];
    recommendations: string[];
    thingsToAvoid: string[];
    nearbyAttractions: NearbyPoi[];
    nearbyRestaurants: NearbyPoi[];
    nearbyHotels: NearbyPoi[];
    nearbyHospitals: NearbyPoi[];
    nearbyPoliceStations: NearbyPoi[];
    nearbyTransportation: NearbyPoi[];
    emergencyContacts: Array<{ type: string; name: string; phone: string }>;
    generatedAt: string;
  };
}

/** Emergency contacts exposed in the Context Report (static reference data). */
export const EGYPT_EMERGENCY_CONTACTS = [
  { type: 'police', name: 'Egyptian Police', phone: '122' },
  { type: 'ambulance', name: 'Egyptian Ambulance', phone: '123' },
  { type: 'fire', name: 'Civil Defense (Fire)', phone: '180' },
  { type: 'tourist_police', name: 'Tourist & Antiquities Police', phone: '126' },
  { type: 'general_emergency', name: 'General Emergency (Tourism)', phone: '19654' },
];