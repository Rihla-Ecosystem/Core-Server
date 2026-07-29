import { env } from '../config/env.js';
import { get, post } from '../utils/http-client.js';

/* ── Types ────────────────────────────────────────────────────── */

export interface CityRiskState {
  city: string;
  severity?: string;
  sources?: string[];
  alerts?: unknown[];
  staticNote?: string | null;
  [key: string]: unknown;
}

export interface SafetyChangeEvent {
  city: string;
  source: string;
  severity: string;
  timestamp: string;
  [key: string]: unknown;
}

export interface SafetyChangesResponse {
  events: SafetyChangeEvent[];
  count: number;
}

export interface SourceHealth {
  name: string;
  status: string;
  lastRun?: string;
  lastError?: string | null;
}

export interface RiskHealthResponse {
  status: string;
  time: string;
  sources: SourceHealth[];
}

/* ── Internal auth header ─────────────────────────────────────── */

function internalHeaders(): Record<string, string> {
  return { 'X-Internal-Api-Key': env.INTERNAL_API_KEY };
}

/* ── Service functions ────────────────────────────────────────── */

/**
 * GET /safety/current?city=
 * Returns current risk state for a specific city, or all cities if omitted.
 */
export async function fetchSafetyData(city?: string): Promise<CityRiskState | Record<string, CityRiskState> | null> {
  const base = env.RISK_SERVICE_URL;
  return get<CityRiskState | Record<string, CityRiskState>>(
    `${base}/safety/current`,
    city ? { city } : undefined,
    internalHeaders(),
  ).catch(() => null);
}

/**
 * GET /safety/changes?since=&city=
 * Returns safety change events since a given ISO timestamp.
 */
export async function fetchSafetyChanges(since: string, city?: string): Promise<SafetyChangesResponse> {
  const base = env.RISK_SERVICE_URL;
  return get<SafetyChangesResponse>(
    `${base}/safety/changes`,
    { since, ...(city && { city }) },
    internalHeaders(),
  ).catch(() => ({ events: [], count: 0 }));
}

/**
 * GET /safety/health
 * Returns health status of all Risk Intelligence source adapters.
 */
export async function fetchRiskHealth(): Promise<RiskHealthResponse | null> {
  const base = env.RISK_SERVICE_URL;
  return get<RiskHealthResponse>(
    `${base}/safety/health`,
    undefined,
    internalHeaders(),
  ).catch(() => null);
}

/**
 * POST /safety/refresh?source=
 * Triggers a manual data refresh (admin only). No-op if Risk service is unreachable.
 */
export async function triggerRiskRefresh(source?: string): Promise<unknown> {
  const base = env.RISK_SERVICE_URL;
  const url = source
    ? `${base}/safety/refresh?source=${encodeURIComponent(source)}`
    : `${base}/safety/refresh`;
  return post<unknown>(url, undefined, internalHeaders()).catch(() => null);
}
