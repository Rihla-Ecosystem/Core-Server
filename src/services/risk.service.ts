import { env } from '../config/env.js';
import { get } from '../utils/http-client.js';

export interface SafetyContext {
  [key: string]: unknown;
}

export async function fetchSafetyContext(lat: number, lon: number, authorization?: string): Promise<SafetyContext | null> {
  const headers: Record<string, string> = { 'X-Internal-Api-Key': env.INTERNAL_API_KEY };
  if (authorization) headers['Authorization'] = authorization;
  return get<SafetyContext>(
    `${env.RISK_SERVICE_URL}/safety/current`,
    { latitude: lat, longitude: lon },
    headers,
  ).catch(() => null);
}

export async function fetchCitySafety(city: string, authorization?: string): Promise<unknown | null> {
  const headers: Record<string, string> = { 'X-Internal-Api-Key': env.INTERNAL_API_KEY };
  if (authorization) headers['Authorization'] = authorization;
  return get<unknown>(
    `${env.RISK_SERVICE_URL}/safety/current`,
    { city },
    headers,
  ).catch(() => null);
}

export async function fetchAllSafety(authorization?: string): Promise<Record<string, unknown> | null> {
  const headers: Record<string, string> = { 'X-Internal-Api-Key': env.INTERNAL_API_KEY };
  if (authorization) headers['Authorization'] = authorization;
  return get<Record<string, unknown>>(
    `${env.RISK_SERVICE_URL}/safety/current`,
    undefined,
    headers,
  ).catch(() => null);
}

export async function fetchSafetyHealth(authorization?: string): Promise<unknown | null> {
  const headers: Record<string, string> = { 'X-Internal-Api-Key': env.INTERNAL_API_KEY };
  if (authorization) headers['Authorization'] = authorization;
  return get<unknown>(
    `${env.RISK_SERVICE_URL}/safety/health`,
    undefined,
    headers,
  ).catch(() => null);
}
