import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import multer from 'multer';
import { ProviderRateCardAdminError } from '../types/provider-rate-card-admin.js';
import { providerRateCardAdminStatus } from '../types/provider-rate-card-admin.js';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function isPrismaError(err: Error): err is Error & { code: string } {
  return err instanceof Prisma.PrismaClientKnownRequestError;
}

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'Validation error',
      details: err.errors,
    });
    return;
  }

  if (isPrismaError(err)) {
    if (err.code === 'P2002') {
      res.status(409).json({ error: 'Resource already exists' });
      return;
    }
    if (err.code === 'P2025') {
      res.status(404).json({ error: 'Resource not found' });
      return;
    }
  }

  if (err instanceof ProviderRateCardAdminError) {
    const body: { error: string; code: string; mapperCode?: string; version?: string } = {
      error: err.message,
      code: err.code,
    };
    if (err.mapperCode !== undefined) body.mapperCode = err.mapperCode;
    if (err.version !== undefined) body.version = err.version;
    res.status(providerRateCardAdminStatus(err.code)).json(body);
    return;
  }

  if (err instanceof multer.MulterError) {
    res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.message });
    return;
  }

  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }

  const statusCode = (err as Error & { statusCode?: number }).statusCode;
  if (statusCode) {
    res.status(statusCode).json({ error: err.message });
    return;
  }

  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
}
