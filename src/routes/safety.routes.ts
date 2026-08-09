import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  fetchSafetyContext,
  fetchCitySafety,
  fetchAllSafety,
  fetchSafetyHealth,
} from '../services/risk.service.js';

const router = Router();

const querySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
});

const SEVERITY_LEVEL: Record<string, string> = {
  info: 'Low Risk',
  advisory: 'Moderate Risk',
  warning: 'High Risk',
  critical: 'Critical Risk',
};

const SEVERITY_SCORE: Record<string, number> = {
  info: 92,
  advisory: 78,
  warning: 58,
  critical: 42,
};

function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

const CITY_META: Record<string, { lat: number; lon: number }> = {
  cairo: { lat: 30.0444, lon: 31.2357 },
  giza: { lat: 29.9773, lon: 31.1325 },
  alexandria: { lat: 31.2001, lon: 29.9187 },
  luxor: { lat: 25.6872, lon: 32.6396 },
  aswan: { lat: 24.0889, lon: 32.8998 },
  hurghada: { lat: 27.2579, lon: 33.8116 },
  sharm_el_sheikh: { lat: 27.9158, lon: 34.3300 },
  dahab: { lat: 28.5091, lon: 34.5136 },
  marsa_alam: { lat: 25.0676, lon: 34.8790 },
  el_gouna: { lat: 27.3942, lon: 33.6783 },
  siwa_oasis: { lat: 29.2032, lon: 25.5197 },
};

function normalizeEvent(raw: Record<string, unknown>) {
  const rec = raw as Record<string, unknown>;
  return {
    source: String(rec.source ?? 'unknown'),
    category: String(rec.category ?? 'advisory'),
    severity: String(rec.severity ?? 'info'),
    city: rec.city ? String(rec.city) : null,
    lat: typeof rec.lat === 'number' ? rec.lat : null,
    lon: typeof rec.lon === 'number' ? rec.lon : null,
    headline: String(rec.headline ?? rec.title ?? 'Advisory'),
    detail: rec.detail ? String(rec.detail) : (rec.description ? String(rec.description) : undefined),
    effectiveTime: rec.effectiveTime ? String(rec.effectiveTime) : (rec.timestamp ? String(rec.timestamp) : null),
    expiresTime: rec.expiresTime ? String(rec.expiresTime) : undefined,
    rawRef: rec.rawRef ? String(rec.rawRef) : undefined,
  };
}

function dedupEvents(events: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const out: Array<Record<string, unknown>> = [];
  for (const e of events) {
    const key = `${String(e.source)}|${String(e.category)}|${String(e.severity)}|${String(e.headline)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

function normalizeCityMap(rawMap: Record<string, unknown> | null, refLat?: number, refLon?: number) {
  if (!rawMap || typeof rawMap !== 'object') return {};
  const result: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(rawMap)) {
    if (!v || typeof v !== 'object') continue;
    const cityRaw = v as Record<string, unknown>;
    const overallRisk = String(cityRaw.overallRisk ?? 'info');
    const rawEvents = Array.isArray(cityRaw.events) ? cityRaw.events : [];
    const events = rawEvents.map(normalizeEvent);
    const alertEvents = events.filter((e: any) => e.severity !== 'info');
    const cityMeta = CITY_META[key.toLowerCase()] ?? { lat: NaN, lon: NaN };
    let dist: number | null = null;
    if (refLat != null && refLon != null && !Number.isNaN(cityMeta.lat)) {
      dist = distanceKm(refLat, refLon, cityMeta.lat, cityMeta.lon);
    }
    const score = SEVERITY_SCORE[overallRisk] ?? 92;
    result[key] = {
      key,
      name: key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' '),
      gov: key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' '),
      lat: cityMeta.lat,
      lon: cityMeta.lon,
      overallRisk,
      events,
      updatedAt: cityRaw.updatedAt ?? new Date().toISOString(),
      score,
      status: score >= 90 ? 'safe' : score >= 78 ? 'caution' : 'warning',
      level: SEVERITY_LEVEL[overallRisk] ?? 'Low Risk',
      distanceKm: dist,
      scamRiskLevel: cityRaw.scamRiskLevel ?? 'low',
      activeAlertsCount: alertEvents.length,
      totalSignals: events.length,
    };
  }
  return result;
}

router.get('/', authenticate, validate(querySchema, 'query'), async (req, res, next) => {
  try {
    const { lat, lon } = req.query as unknown as { lat: number; lon: number };
    const rawMap = (await fetchAllSafety(req.headers.authorization)) ?? {};
    const cityMap = normalizeCityMap(rawMap as Record<string, unknown>, lat, lon);
    res.json({ safety: cityMap });
  } catch (error) {
    next(error);
  }
});

router.get('/city/:city', authenticate, async (req, res, next) => {
  try {
    const city = req.params.city as string;
    const riskKey = city.toLowerCase().replace(/[\s.-]+/g, '_');
    const raw = await fetchCitySafety(riskKey, req.headers.authorization);
    const cityMap = normalizeCityMap({ [riskKey]: raw } as Record<string, unknown>);
    const result = cityMap[riskKey] ?? null;
    if (!result) {
      res.status(404).json({ error: `No safety data for city: ${city}` });
      return;
    }
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get('/events', authenticate, async (req, res, next) => {
  try {
    const state = (await fetchAllSafety(req.headers.authorization)) ?? {};
    const allEvents: any[] = [];
    for (const [, cityState] of Object.entries(state as Record<string, unknown>)) {
      if (!cityState || typeof cityState !== 'object') continue;
      const rec = cityState as Record<string, unknown>;
      const list = Array.isArray(rec.events) ? rec.events : [];
      for (const e of list) {
        allEvents.push(normalizeEvent(e as Record<string, unknown>));
      }
    }
    res.json({ events: dedupEvents(allEvents) });
  } catch (error) {
    next(error);
  }
});

router.get('/sources', authenticate, async (req, res, next) => {
  try {
    const raw = (await fetchSafetyHealth(req.headers.authorization)) as {
      sources?: Array<{
        name: string;
        lastSuccessAt?: string | null;
        lastError?: string | null;
        consecutiveFailures?: number;
        autoDisabled?: boolean;
      }>;
    } | null;
    const sources = (raw?.sources ?? []).map((s) => {
      const down = !!s.autoDisabled || (s.consecutiveFailures ?? 0) >= 3;
      const degraded = !down && (!!s.lastError || (s.consecutiveFailures ?? 0) > 0);
      return {
        name: s.name,
        status: down ? 'down' : degraded ? 'degraded' : 'healthy',
        lastUpdate: s.lastSuccessAt ? new Date(s.lastSuccessAt).toISOString() : 'Never',
        category: s.name,
      };
    });
    res.json({ sources });
  } catch (error) {
    next(error);
  }
});

export default router;
