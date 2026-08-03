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
  info: 'low',
  advisory: 'moderate',
  warning: 'high',
  critical: 'critical',
};

const SEVERITY_SCORE: Record<string, number> = {
  info: 18,
  advisory: 40,
  warning: 68,
  critical: 90,
};

function dedupEvents(events: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const out: Array<Record<string, unknown>> = [];
  for (const e of events) {
    const id = String(e.id ?? '').trim();
    const type = String(e.type ?? '').toLowerCase().trim();
    const location = String(e.location ?? '').toLowerCase().trim();
    const title = String(e.title ?? '').toLowerCase().trim();
    const key = id || `${type}|${location}|${title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

function normalizeEvents(state: Record<string, unknown>): unknown[] {
  const events: unknown[] = [];
  const push = (e: Record<string, unknown>) => {
    if (!e || typeof e !== 'object') return;
    const rec = e as Record<string, unknown>;
    events.push({
      id: `${rec.source ?? 'source'}:${rec.rawRef ?? Math.random().toString(36).slice(2)}`,
      type: rec.severity ?? 'info',
      title: rec.headline ?? 'Advisory',
      description: rec.detail ?? rec.headline ?? '',
      source: rec.source ?? 'unknown',
      timestamp: rec.effectiveTime ?? new Date().toISOString(),
      location: rec.city ?? null,
    });
  };
  for (const [city, cityState] of Object.entries(state)) {
    if (!cityState || typeof cityState !== 'object') continue;
    const rec = cityState as Record<string, unknown>;
    const list = Array.isArray(rec.events) ? rec.events : [];
    for (const e of list) push(e as Record<string, unknown>);
    void city;
  }
  return dedupEvents(events as Array<Record<string, unknown>>);
}

function normalizeCity(city: string, raw: Record<string, unknown> | null) {
  if (!raw) return null;
  const overallRisk = String(raw.overallRisk ?? 'info');
  const events = Array.isArray(raw.events) ? raw.events : [];
  const normalized = (events as Array<Record<string, unknown>>).map((e) => {
    const rec = e as Record<string, unknown>;
    return {
      id: `${rec.source ?? 'source'}:${rec.rawRef ?? Math.random().toString(36).slice(2)}`,
      type: rec.severity ?? 'info',
      title: rec.headline ?? 'Advisory',
      description: rec.detail ?? rec.headline ?? '',
      source: rec.source ?? 'unknown',
      timestamp: rec.effectiveTime ?? new Date().toISOString(),
      location: rec.city ?? city,
    };
  });
  return {
    city,
    level: SEVERITY_LEVEL[overallRisk] ?? 'low',
    score: SEVERITY_SCORE[overallRisk] ?? 18,
    updatedAt: raw.updatedAt ?? null,
    staticNote: raw.staticNote ?? null,
    events: dedupEvents(normalized),
  };
}

router.get('/', authenticate, validate(querySchema, 'query'), async (req, res, next) => {
  try {
    const { lat, lon } = req.query as unknown as { lat: number; lon: number };
    res.json({ safety: await fetchSafetyContext(lat, lon, req.headers.authorization) });
  } catch (error) {
    next(error);
  }
});

router.get('/city/:city', authenticate, async (req, res, next) => {
  try {
    const city = req.params.city as string;
    const riskKey = city.toLowerCase().replace(/[\s.-]+/g, '_');
    const raw = await fetchCitySafety(riskKey, req.headers.authorization);
    const result = normalizeCity(city, raw as Record<string, unknown> | null);
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
    res.json({ events: normalizeEvents(state as Record<string, unknown>) });
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
