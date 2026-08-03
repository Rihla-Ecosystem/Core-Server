import { Request, Response } from 'express';

export interface ApiLogEntry {
  id: string;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  userId: string | null;
  ip: string | null;
  userAgent: string | null;
  timestamp: string;
}

const MAX_ENTRIES = 5000;
const buffer: ApiLogEntry[] = [];

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function recordRequest(req: Request, res: Response, durationMs: number): void {
  const entry: ApiLogEntry = {
    id: generateId(),
    method: req.method,
    path: req.originalUrl ?? req.url,
    statusCode: res.statusCode,
    durationMs,
    userId: req.user?.userId ?? null,
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
    timestamp: new Date().toISOString(),
  };

  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) {
    buffer.splice(0, buffer.length - MAX_ENTRIES);
  }
}

export interface ApiMonitoringFilters {
  page?: number;
  limit?: number;
  method?: string;
  status?: string;
  search?: string;
  userId?: string;
  from?: Date;
  to?: Date;
}

export function getApiMonitoring(filters: ApiMonitoringFilters = {}) {
  const { page = 1, limit = 20, method, status, search, userId, from, to } = filters;

  let filtered = buffer;
  if (method) filtered = filtered.filter((entry) => entry.method === method.toUpperCase());
  if (status) filtered = filtered.filter((entry) => String(entry.statusCode) === status);
  if (userId) filtered = filtered.filter((entry) => entry.userId === userId);
  if (from) filtered = filtered.filter((entry) => new Date(entry.timestamp) >= from);
  if (to) filtered = filtered.filter((entry) => new Date(entry.timestamp) <= to);
  if (search) {
    const needle = search.toLowerCase();
    filtered = filtered.filter(
      (entry) => entry.path.toLowerCase().includes(needle) || (entry.userId ?? '').includes(needle),
    );
  }

  const total = filtered.length;
  const start = (page - 1) * limit;
  const logs = filtered.slice(start, start + limit);

  return {
    logs,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export function getApiMonitoringSummary() {
  const total = buffer.length;
  const byStatus: Record<string, number> = {};
  const byMethod: Record<string, number> = {};
  let errorCount = 0;
  let totalDuration = 0;

  for (const entry of buffer) {
    byStatus[entry.statusCode] = (byStatus[entry.statusCode] ?? 0) + 1;
    byMethod[entry.method] = (byMethod[entry.method] ?? 0) + 1;
    if (entry.statusCode >= 400) errorCount += 1;
    totalDuration += entry.durationMs;
  }

  const success = total - errorCount;
  return {
    totalRequests: total,
    errors: errorCount,
    successRate: total > 0 ? Math.round((success / total) * 10000) / 100 : 100,
    averageResponseTimeMs: total > 0 ? Math.round((totalDuration / total) * 10) / 10 : 0,
    byStatus,
    byMethod,
  };
}

export function clearApiMonitoring(): void {
  buffer.length = 0;
}
