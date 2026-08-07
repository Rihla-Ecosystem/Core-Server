// ---------------------------------------------------------------------------
// Realtime Notification Delivery (SSE)
// ---------------------------------------------------------------------------
// A lightweight in-memory SSE bus for pushing notifications immediately to
// online users. When a user is offline, notifications are persisted to the
// NotificationInbox table and later synchronized on reconnect. No external
// provider is used.
import { Response } from 'express';
import type { GeneratedNotification } from '../types/context-notification.js';

interface Subscriber {
  userId: string;
  res: Response;
}

const subscribers = new Map<string, Set<Subscriber>>();

function safeWrite(res: Response, payload: string): boolean {
  try {
    res.write(`data: ${payload}\n\n`);
    return true;
  } catch {
    return false;
  }
}

export function subscribeToNotifications(res: Response, userId: string): () => void {
  const headers = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  };
  res.writeHead(200, headers);
  res.write('retry: 10000\n\n');
  res.write(`event: ready\ndata: {}\n\n`);

  const sub: Subscriber = { userId, res };
  const set = subscribers.get(userId) ?? new Set<Subscriber>();
  set.add(sub);
  subscribers.set(userId, set);

  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, 25000);

  const cleanup = () => {
    clearInterval(heartbeat);
    const s = subscribers.get(userId);
    s?.delete(sub);
    if (s && s.size === 0) subscribers.delete(userId);
    res.end();
  };

  reqCleanup(res, cleanup);
  return cleanup;
}

function reqCleanup(res: Response, cleanup: () => void): void {
  res.on('close', cleanup);
  res.on('finish', cleanup);
  res.on('error', cleanup);
}

export function publishToUser(userId: string, notification: Record<string, unknown>): number {
  const set = subscribers.get(userId);
  if (!set || set.size === 0) return 0;
  const payload = JSON.stringify({ type: 'notification', notification });
  let delivered = 0;
  for (const sub of set) {
    if (safeWrite(sub.res, payload)) delivered++;
  }
  return delivered;
}

export function publishContextEvent(userId: string, event: { kind: string; data: unknown }): void {
  const set = subscribers.get(userId);
  if (!set) return;
  const payload = JSON.stringify({ type: 'context', ...event });
  for (const sub of set) safeWrite(sub.res, payload);
}

export function publishEvent(userId: string, type: string, data: unknown): void {
  const set = subscribers.get(userId);
  if (!set) return;
  const payload = JSON.stringify({ type, data });
  for (const sub of set) safeWrite(sub.res, payload);
}

export function isUserOnline(userId: string): boolean {
  const set = subscribers.get(userId);
  return !!set && set.size > 0;
}

export function countSubscribers(): number {
  let total = 0;
  for (const set of subscribers.values()) total += set.size;
  return total;
}

export function clearSubscribersForTest(): void {
  subscribers.clear();
}