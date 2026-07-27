import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { env } from '../config/env.js';

export interface AccessTokenPayload {
  sub: string;
  role: string;
}

export interface VerifiedAccessTokenPayload extends AccessTokenPayload {
  exp: number;
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign({ sub: payload.sub, role: payload.role }, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_EXPIRY as any,
  });
}

export function verifyAccessToken(token: string): VerifiedAccessTokenPayload {
  const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET);
  if (typeof decoded !== 'object' || decoded === null) throw new Error('Invalid JWT claims');
  const claims = decoded as jwt.JwtPayload & { sub?: unknown; role?: unknown };
  if (typeof claims.sub !== 'string' || !claims.sub || typeof claims.role !== 'string' || !claims.role || typeof claims.exp !== 'number') {
    throw new Error('Invalid JWT claims');
  }
  return { sub: claims.sub, role: claims.role, exp: claims.exp };
}

export function generateOpaqueToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

export function getRefreshTokenExpiry(): Date {
  return new Date(Date.now() + env.REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
}
