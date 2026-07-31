import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import {
  UnsupportedIdentificationMimeError,
  uploadIdentificationImage,
} from '../utils/upload.js';
import { identifyLandmark } from '../services/identify.service.js';

const router = Router();

const idempotencyKeySchema = z.string().uuid();

const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readIdempotencyKey(req: Request): string {
  const value = req.headers['idempotency-key'];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppError(400, 'Idempotency-Key header is required');
  }
  const parsed = idempotencyKeySchema.safeParse(value.trim());
  if (!parsed.success) {
    throw new AppError(400, 'Idempotency-Key header must be a valid UUID');
  }
  return parsed.data;
}

function requireIdempotencyKey(req: Request, _res: Response, next: NextFunction): void {
  try {
    readIdempotencyKey(req);
    next();
  } catch (err) {
    next(err);
  }
}

function parseIdentificationImage(req: Request, res: Response, next: NextFunction): void {
  uploadIdentificationImage.single('image')(req, res, (err?: unknown) => {
    if (!err) {
      next();
      return;
    }
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        next(new AppError(400, 'Image file must not exceed 5 MB'));
        return;
      }
      next(new AppError(400, 'Invalid image upload'));
      return;
    }
    if (err instanceof UnsupportedIdentificationMimeError) {
      next(new AppError(400, 'Only JPEG and PNG image files are allowed'));
      return;
    }
    next(new AppError(400, 'Invalid image upload'));
  });
}

function hasSignature(buffer: Buffer, signature: Buffer): boolean {
  if (buffer.length < signature.length) return false;
  return buffer.subarray(0, signature.length).equals(signature);
}

function validateImageSignature(buffer: Buffer, mimetype: string): boolean {
  if (mimetype === 'image/jpeg') return hasSignature(buffer, JPEG_SIGNATURE);
  if (mimetype === 'image/png') return hasSignature(buffer, PNG_SIGNATURE);
  return false;
}

router.post(
  '/',
  authenticate,
  requireIdempotencyKey,
  parseIdentificationImage,
  async (req, res, next) => {
    try {
      if (!req.file) {
        next(new AppError(400, 'Image file is required'));
        return;
      }

      if (!validateImageSignature(req.file.buffer, req.file.mimetype)) {
        next(new AppError(400, 'Invalid image file'));
        return;
      }

      const lat = req.body.lat ? Number(req.body.lat) : undefined;
      const lon = req.body.lon ? Number(req.body.lon) : undefined;
      const radius = req.body.radius ? Number(req.body.radius) : 500;

      if (lat !== undefined && (isNaN(lat) || lat < -90 || lat > 90)) {
        next(new AppError(400, 'Invalid latitude'));
        return;
      }
      if (lon !== undefined && (isNaN(lon) || lon < -180 || lon > 180)) {
        next(new AppError(400, 'Invalid longitude'));
        return;
      }
      if (isNaN(radius) || radius < 0) {
        next(new AppError(400, 'Invalid radius'));
        return;
      }

      const result = await identifyLandmark(req.file.buffer, req.file.mimetype, {
        lat,
        lon,
        radius,
        authorization: req.headers.authorization,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
