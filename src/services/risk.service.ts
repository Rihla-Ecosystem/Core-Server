import { env } from '../config/env.js';
import { get } from '../utils/http-client.js';

export interface SafetyContext {
  [key: string]: unknown;
}

export async function fetchSafetyContext(lat: number, lon: number, authorization?: string): Promise<SafetyContext | null> {
  return get<SafetyContext>(
    `${env.RISK_SERVICE_URL}/api/v1/safety`,
    { latitude: lat, longitude: lon },
    authorization ? { Authorization: authorization } : undefined,
  ).catch(() => null);
}
