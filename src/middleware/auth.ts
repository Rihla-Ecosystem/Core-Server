import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../utils/token.js';
import { prisma } from '../config/prisma.js';
import { AppError } from './errorHandler.js';

export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return next(new AppError(401, 'Missing or invalid authorization header'));
  }

  const token = header.slice(7);
  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    return next(new AppError(401, 'Invalid or expired token'));
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: { id: true, role: { select: { name: true } }, isActive: true, isBanned: true, isDeleted: true },
  });

  if (!user || user.isDeleted) {
    return next(new AppError(401, 'Authenticated user not found'));
  }

  if (!user.isActive || user.isBanned) {
    return next(new AppError(403, 'Account suspended'));
  }

  req.user = { ...payload, userId: payload.sub, role: user.role.name };
  next();
}
