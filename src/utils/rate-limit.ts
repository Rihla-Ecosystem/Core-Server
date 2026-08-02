import rateLimit from 'express-rate-limit';
import type { Request } from 'express';
import type { AuthPayload } from '../types/index.js';

/**
 * Per-user sliding-window rate limiter for business endpoints.
 * Keys on the authenticated user id (falling back to IP) and skips admins.
 */
export function userRateLimit({ windowMs, max }: { windowMs: number; max: number }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later' },
    skip: (req) => {
      const user = (req as Request).user as AuthPayload | undefined;
      return user?.role === 'admin';
    },
    keyGenerator: (req) => {
      const user = (req as Request).user as AuthPayload | undefined;
      return user?.userId ?? req.ip ?? 'unknown';
    },
  });
}
