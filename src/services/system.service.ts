import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';

const GEO_URL = env.GIS_SERVICE_URL;

async function probe(url: string, timeoutMs = 3000): Promise<{ status: string; latencyMs: number; detail?: unknown }> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    const latencyMs = Date.now() - start;
    const body = await res.json().catch(() => null);
    const status = res.ok ? 'ok' : `error`;
    return { status, latencyMs, detail: body };
  } catch {
    return { status: 'down', latencyMs: Date.now() - start };
  }
}

async function getCoreModels() {
  const rows = await prisma.$queryRawUnsafe<{ table_name: string; approx_rows: number }[]>(
    `SELECT c.relname AS table_name, c.reltuples::bigint AS approx_rows
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> '_prisma_migrations'
     ORDER BY c.relname`,
  );
  return rows.map((r: { table_name: string; approx_rows: number }) => ({
    name: r.table_name,
    table: r.table_name,
    count: Number(r.approx_rows),
  }));
}

async function getGeoModels() {
  const res = await fetch(`${GEO_URL}/api/v1/health/models`, {
    headers: { 'X-Internal-Api-Key': env.INTERNAL_API_KEY },
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { models: Array<{ name: string; table: string; count: number }> };
  return body.models ?? [];
}

async function getAiCollections() {
  const res = await fetch(`${env.AI_SERVICE_URL}/health/collections`, {
    headers: { 'X-Internal-Api-Key': env.INTERNAL_API_KEY },
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { collections: Array<{ name: string; count: number }> };
  return body.collections ?? [];
}

let cache: { at: number; data: unknown } | null = null;
const CACHE_TTL_MS = 10_000;

export async function getSystemHealth() {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;

  const [coreHealth, geoLiveness, geoReadiness, riskHealth, aiHealth, coreModels, geoModels, aiCollections] =
    await Promise.all([
      probe(`http://localhost:${env.PORT}/health`),
      probe(`${GEO_URL}/healthz`),
      probe(`${GEO_URL}/readyz`),
      probe(`${env.RISK_SERVICE_URL}/safety/health`),
      probe(`${env.AI_SERVICE_URL}/health`),
      getCoreModels().catch(() => []),
      getGeoModels().catch(() => null),
      getAiCollections().catch(() => null),
    ]);

  const data = {
    generatedAt: new Date().toISOString(),
    services: [
      {
        name: 'core-server',
        url: `http://localhost:${env.PORT}`,
        status: coreHealth.status,
        latencyMs: coreHealth.latencyMs,
        health: coreHealth.detail,
      },
      {
        name: 'geocontext',
        url: GEO_URL,
        status: geoLiveness.status === 'ok' && geoReadiness.status === 'ok' ? 'ok' : 'degraded',
        latencyMs: geoLiveness.latencyMs + geoReadiness.latencyMs,
        liveness: geoLiveness.detail,
        readiness: geoReadiness.detail,
      },
      {
        name: 'risk-intelligence',
        url: env.RISK_SERVICE_URL,
        status: riskHealth.status,
        latencyMs: riskHealth.latencyMs,
        detail: riskHealth.detail,
      },
      {
        name: 'ai-service',
        url: env.AI_SERVICE_URL,
        status: aiHealth.status,
        latencyMs: aiHealth.latencyMs,
        health: aiHealth.detail,
      },
    ],
    models: [
      { service: 'core-server', kind: 'database', models: coreModels },
      { service: 'geocontext', kind: 'database', models: geoModels ?? [], available: geoModels !== null },
      {
        service: 'ai-service',
        kind: 'vector',
        models: (aiCollections ?? []).map((c: { name: string; count: number }) => ({ name: c.name, table: c.name, count: c.count })),
        available: aiCollections !== null,
      },
      {
        service: 'risk-intelligence',
        kind: 'file-based',
        models: [
          { name: 'current_state.json', table: 'data/', count: null },
          { name: 'event_log.json', table: 'data/', count: null },
          { name: 'checkpoints', table: 'data/', count: null },
          { name: 'static_safety_notes.json', table: 'data/', count: null },
        ],
      },
    ],
  };

  cache = { at: Date.now(), data };
  return data;
}
