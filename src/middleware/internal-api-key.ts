import { timingSafeEqual } from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';
import { AppError } from './errorHandler.js';

export function requireInternalApiKey(req: Request, _res: Response, next: NextFunction): void {
  const supplied = req.header('X-Internal-Api-Key');
  if (!supplied) return next(new AppError(401, 'Missing internal API key'));
  const expected = Buffer.from(env.INTERNAL_API_KEY);
  const actual = Buffer.from(supplied);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return next(new AppError(403, 'Invalid internal API key'));
  }
  next();
}
