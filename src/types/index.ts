import { Request } from 'express';

export interface AuthPayload {
  sub: string;
  role: string;
  exp: number;
  userId: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload;
    }
  }
}
