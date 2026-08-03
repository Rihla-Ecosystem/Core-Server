import { prisma } from '../config/prisma.js';
import { computeAiCost } from '../config/ai-pricing.js';
import { normalizeProviderCalls } from '../utils/ai-usage.js';
import type { ProviderCallUsage } from '../types/ai.js';

export interface AiUsage {
  model?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

type Sums = {
  _sum: {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    cost: number | null;
  };
  _count: number;
};

export async function recordAiUsage(params: {
  userId: string;
  conversationId?: string | null;
  source?: string;
  usage?: AiUsage | null;
  providerCalls?: unknown;
}) {
  if (!params.userId) return;

  const providerCalls = normalizeProviderCalls(params.providerCalls);

  if (providerCalls && providerCalls.length > 0) {
    // Prefer per-provider-call telemetry rows. Each row is written only when a
    // real provider call reported a totalTokens > 0; calls without reported
    // usage produce no fabricated row, and totalTokens is never derived. The
    // current AiUsageLog schema has no operation/providerCallId column, so that
    // identity is not persisted yet (documented limitation).
    const rows = providerCalls
      .filter((call: ProviderCallUsage) => typeof call.totalTokens === 'number' && call.totalTokens > 0)
      .map((call: ProviderCallUsage) => {
        const inputTokens = call.inputTokens ?? 0;
        const outputTokens = call.outputTokens ?? 0;
        const model = call.actualModel ?? call.requestedModel ?? null;
        const cost = computeAiCost(model, inputTokens, outputTokens);
        return {
          userId: params.userId,
          conversationId: params.conversationId ?? null,
          source: params.source ?? 'chat',
          model,
          inputTokens,
          outputTokens,
          totalTokens: call.totalTokens!,
          cost,
        };
      });
    if (rows.length > 0) {
      const created = await prisma.aiUsageLog.createMany({ data: rows });
      return created.count;
    }
    return null;
  }

  const usage = params.usage;
  if (!usage || !usage.totalTokens || usage.totalTokens <= 0) return null;

  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const cost = computeAiCost(usage.model, inputTokens, outputTokens);

  await prisma.aiUsageLog.create({
    data: {
      userId: params.userId,
      conversationId: params.conversationId ?? null,
      source: params.source ?? 'chat',
      model: usage.model ?? null,
      inputTokens,
      outputTokens,
      totalTokens: usage.totalTokens,
      cost,
    },
  });
  return 1;
}

export async function getAiUsageSummary() {
  const [total, perDay, perUser, perModel, recent] = await Promise.all([
    prisma.aiUsageLog.aggregate({
      _sum: { inputTokens: true, outputTokens: true, totalTokens: true, cost: true },
      _count: true,
    }),
    prisma.aiUsageLog.groupBy({
      by: ['createdAt'],
      _sum: { inputTokens: true, outputTokens: true, totalTokens: true, cost: true },
      _count: true,
    }),
    prisma.aiUsageLog.groupBy({
      by: ['userId'],
      _sum: { inputTokens: true, outputTokens: true, totalTokens: true, cost: true },
      _count: true,
      orderBy: { _sum: { totalTokens: 'desc' } },
      take: 25,
    }),
    prisma.aiUsageLog.groupBy({
      by: ['model', 'source'],
      _sum: { inputTokens: true, outputTokens: true, totalTokens: true, cost: true },
      _count: true,
      orderBy: { _sum: { totalTokens: 'desc' } },
    }),
    prisma.aiUsageLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { user: { select: { displayName: true, email: true } } },
    }),
  ]);

  const perDayTyped = perDay as unknown as Array<
    { createdAt: Date } & Sums
  >;
  const perUserTyped = perUser as unknown as Array<
    { userId: string } & Sums
  >;
  const perModelTyped = perModel as unknown as Array<
    { model: string | null; source: string } & Sums
  >;

  const users = await prisma.user.findMany({
    where: { id: { in: perUserTyped.map((u) => u.userId) } },
    select: { id: true, displayName: true, email: true },
  });
  const userMap = new Map(users.map((u: { id: string; displayName: string | null; email: string | null }) => [u.id, u]));

  return {
    summary: {
      totalCalls: total._count,
      inputTokens: total._sum.inputTokens ?? 0,
      outputTokens: total._sum.outputTokens ?? 0,
      totalTokens: total._sum.totalTokens ?? 0,
      cost: Number(total._sum.cost ?? 0),
    },
    daily: perDayTyped.map((d) => ({
      day: d.createdAt.toISOString().slice(0, 10),
      inputTokens: d._sum.inputTokens ?? 0,
      outputTokens: d._sum.outputTokens ?? 0,
      totalTokens: d._sum.totalTokens ?? 0,
      cost: Number(d._sum.cost ?? 0),
      calls: d._count,
    })),
    perUser: perUserTyped.map((u) => ({
      user: userMap.get(u.userId) ?? { id: u.userId, displayName: 'Unknown', email: null },
      calls: u._count,
      inputTokens: u._sum.inputTokens ?? 0,
      outputTokens: u._sum.outputTokens ?? 0,
      totalTokens: u._sum.totalTokens ?? 0,
      cost: Number(u._sum.cost ?? 0),
    })),
    perModel: perModelTyped.map((m) => ({
      model: m.model ?? 'unknown',
      source: m.source,
      calls: m._count,
      inputTokens: m._sum.inputTokens ?? 0,
      outputTokens: m._sum.outputTokens ?? 0,
      totalTokens: m._sum.totalTokens ?? 0,
      cost: Number(m._sum.cost ?? 0),
    })),
    recent: recent.map((r) => ({
      id: r.id,
      user: r.user ? { displayName: r.user.displayName, email: r.user.email } : null,
      source: r.source,
      model: r.model,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      totalTokens: r.totalTokens,
      cost: Number(r.cost),
      createdAt: r.createdAt,
    })),
  };
}
