import type { Request, Response, NextFunction } from 'express';
import { DEFAULT_OBSERVATION_BUFFER } from '../services/ai-shadow-pricing.service.js';
import { computeShadowPricingMetrics } from '../services/ai-shadow-pricing-metrics.service.js';
import {
  queryShadowPricingObservations,
  type ObservationQueryOptions,
} from '../services/ai-shadow-pricing-observation-query.service.js';
import {
  recomputePreview as recomputePreviewService,
  toHistoricalPricingRow,
  type RecomputeRepository,
} from '../services/ai-shadow-pricing-recompute.service.js';
import { prisma } from '../config/prisma.js';
import type { AdminObservationsQuery, AdminRecomputeBody } from '../schemas/admin-shadow-pricing.schema.js';

/**
 * Read-only Prisma-backed repository for the recompute preview.
 *
 * Retrieves a bounded, deterministic (createdAt desc + id desc), date-ranged
 * selection of AiUsageLog rows without the legacy `model not null` filter and
 * without any write path. Rows are mapped explicitly into the typed historical
 * row contract via `toHistoricalPricingRow`.
 */
export function createAiUsageLogRecomputeRepository(prismaClient: typeof prisma): RecomputeRepository {
  return {
    fetchRows: async (opts) => {
      const rows = await prismaClient.aiUsageLog.findMany({
        where: {
          createdAt: { gte: opts.from, lte: opts.to },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: opts.limit,
        select: {
          id: true,
          source: true,
          createdAt: true,
          model: true,
          inputTokens: true,
          outputTokens: true,
        },
      });
      return rows.map(toHistoricalPricingRow);
    },
  };
}

/** GET /api/admin/ai-shadow-pricing/summary */
export async function getShadowPricingSummary(req: Request, res: Response, next: NextFunction) {
  try {
    const snapshot = DEFAULT_OBSERVATION_BUFFER;
    const metrics = computeShadowPricingMetrics(snapshot.snapshot(), {
      capacity: snapshot.maxCapacity,
    });
    res.json(metrics);
  } catch (err) {
    next(err);
  }
}

/** GET /api/admin/ai-shadow-pricing/observations */
export async function getShadowPricingObservations(req: Request, res: Response, next: NextFunction) {
  try {
    const query = req.query as unknown as AdminObservationsQuery;
    const options: ObservationQueryOptions = {
      limit: query.limit,
      source: query.source,
      status: query.status,
      noProviderCalls: query.noProviderCalls,
      capacity: DEFAULT_OBSERVATION_BUFFER.maxCapacity,
    };
    const snapshot = DEFAULT_OBSERVATION_BUFFER.snapshot();
    res.json(queryShadowPricingObservations(snapshot, options));
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/admin/ai-shadow-pricing/recompute-preview
 *
 * Produced via a factory so focused tests can inject a fake repository without
 * requiring the core_server_test database.
 */
export function recomputePreviewHandler(deps: { repository: RecomputeRepository }) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as AdminRecomputeBody;
      const result = await recomputePreviewService(deps, body);
      res.json(result);
    } catch (err) {
      next(err);
    }
  };
}

/** Route-bound handler backed by the real Prisma repository. */
export const recomputePreview = recomputePreviewHandler({
  repository: createAiUsageLogRecomputeRepository(prisma),
});