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
import { identifyLandmarkWithTokens } from '../services/identify.service.js';
import { userRateLimit } from '../utils/rate-limit.js';

const router = Router();

const idempotencyKeySchema = z.string().uuid();

const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GIF_SIGNATURE = Buffer.from([0x47, 0x49, 0x46, 0x38]); // "GIF8"
const BMP_SIGNATURE = Buffer.from([0x42, 0x4d]); // "BM"
const TIFF_LE_SIGNATURE = Buffer.from([0x49, 0x49, 0x2a, 0x00]); // "II*\0"
const TIFF_BE_SIGNATURE = Buffer.from([0x4d, 0x4d, 0x00, 0x2a]); // "MM\0*"
const RIFF_SIGNATURE = Buffer.from([0x52, 0x49, 0x46, 0x46]); // "RIFF"
const WEBP_BRAND = Buffer.from([0x57, 0x45, 0x42, 0x50]); // "WEBP" at offset 8
const FTYP_SIGNATURE = Buffer.from([0x66, 0x74, 0x79, 0x70]); // "ftyp" at offset 4

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
      next(new AppError(400, 'Only JPEG, PNG, WebP, HEIC, GIF, BMP, AVIF and TIFF image files are allowed'));
      return;
    }
    next(new AppError(400, err instanceof Error ? err.message : 'Invalid image upload'));
  });
}

function hasSignature(buffer: Buffer, offset: number, signature: Buffer): boolean {
  if (buffer.length < offset + signature.length) return false;
  return buffer.subarray(offset, offset + signature.length).equals(signature);
}

function validateImageSignature(buffer: Buffer, mimetype: string): boolean {
  switch (mimetype) {
    case 'image/jpeg':
      return hasSignature(buffer, 0, JPEG_SIGNATURE);
    case 'image/png':
      return hasSignature(buffer, 0, PNG_SIGNATURE);
    case 'image/gif':
      return hasSignature(buffer, 0, GIF_SIGNATURE);
    case 'image/bmp':
      return hasSignature(buffer, 0, BMP_SIGNATURE);
    case 'image/tiff':
      return hasSignature(buffer, 0, TIFF_LE_SIGNATURE) || hasSignature(buffer, 0, TIFF_BE_SIGNATURE);
    case 'image/webp':
      return hasSignature(buffer, 0, RIFF_SIGNATURE) && hasSignature(buffer, 8, WEBP_BRAND);
    case 'image/heic':
    case 'image/heif':
    case 'image/avif':
      return hasSignature(buffer, 4, FTYP_SIGNATURE);
    default:
      return false;
  }
}

router.post(
  '/',
  authenticate,
  userRateLimit({ windowMs: 60 * 1000, max: 30 }),
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

      const userId = req.user?.userId;
      if (!userId) {
        throw new AppError(401, 'Unauthorized');
      }

      const businessRequestId = readIdempotencyKey(req);

      const result = await identifyLandmarkWithTokens({
        userId,
        businessRequestId,
        image: req.file.buffer,
        mimeType: req.file.mimetype,
        lat,
        lon,
        radius,
        authorization: req.headers.authorization,
        user: req.user,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
