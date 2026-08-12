// ---------------------------------------------------------------------------
// Favorite Place controller (user-facing) — /api/places/favorites
// ---------------------------------------------------------------------------
import { Request, Response, NextFunction } from 'express';
import { AppError } from '../middleware/errorHandler.js';
import * as service from '../services/favorite-place.service.js';

function actorId(req: Request): string {
  if (!req.user) throw new AppError(401, 'Authentication required');
  return req.user.userId;
}

function placeId(req: Request): string {
  return String(req.params.placeId ?? '').trim();
}

export async function listFavorites(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ success: true, data: await service.listFavorites(actorId(req)) });
  } catch (err) {
    next(err);
  }
}

export async function checkFavorite(req: Request, res: Response, next: NextFunction) {
  try {
    const id = placeId(req);
    if (!id) throw new AppError(400, 'place_id is required');
    res.json({ success: true, data: { favorited: await service.isFavorited(actorId(req), id) } });
  } catch (err) {
    next(err);
  }
}

export async function addFavorite(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(201).json({ success: true, data: await service.addFavorite(actorId(req), req.body) });
  } catch (err) {
    next(err);
  }
}

export async function removeFavorite(req: Request, res: Response, next: NextFunction) {
  try {
    const id = placeId(req);
    if (!id) throw new AppError(400, 'place_id is required');
    res.json({ success: true, data: await service.removeFavorite(actorId(req), id) });
  } catch (err) {
    next(err);
  }
}

export async function recordEvent(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(202).json({ success: true, data: { accepted: true } });
  } catch (err) {
    next(err);
  }
}
