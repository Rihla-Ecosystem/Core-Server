import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { uploadAudio } from '../utils/upload.js';
import { processVoiceWithTokens } from '../services/voice.service.js';
import { env } from '../config/env.js';
import { AppError } from '../middleware/errorHandler.js';
import { userRateLimit } from '../utils/rate-limit.js';

const router = Router();

const idempotencyKeySchema = z.string().uuid();

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

router.get('/audio', async (req, res, next) => {
  const token = req.query.token;
  if (typeof token !== 'string' || !token) {
    res.status(400).json({ error: 'Missing token' });
    return;
  }
  try {
    const upstream = await fetch(
      `${env.AI_SERVICE_URL}/voice/audio?token=${encodeURIComponent(token)}`,
      {
        headers: { 'X-Internal-Api-Key': env.INTERNAL_API_KEY },
      },
    );
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: 'Audio unavailable' });
      return;
    }
    const mime = upstream.headers.get('content-type') || 'audio/wav';
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'no-store');
    const reader = upstream.body?.getReader();
    if (!reader) {
      res.status(502).json({ error: 'Upstream body unavailable' });
      return;
    }
    res.on('close', () => {
      void reader.cancel().catch(() => {});
    });
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    next(err);
  }
});

router.post(
  '/',
  authenticate,
  userRateLimit({ windowMs: 60 * 1000, max: 30 }),
  requireIdempotencyKey,
  uploadAudio.single('audio'),
  async (req, res, next) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'Audio file is required' });
        return;
      }

      const lat = req.body.lat ? Number(req.body.lat) : undefined;
      const lon = req.body.lon ? Number(req.body.lon) : undefined;
      const conversationId = req.body.conversation_id;
      const persona = typeof req.body.persona === 'string' ? req.body.persona : undefined;
      const title = typeof req.body.title === 'string' ? req.body.title : undefined;
      const transcript = typeof req.body.transcript === 'string' ? req.body.transcript : undefined;
      let context: Record<string, unknown> | undefined;
      if (typeof req.body.context === 'string' && req.body.context.trim()) {
        try {
          const parsed = JSON.parse(req.body.context);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            context = parsed;
          }
        } catch {
          context = undefined;
        }
      }

      if (lat !== undefined && (isNaN(lat) || lat < -90 || lat > 90)) {
        res.status(400).json({ error: 'Invalid latitude' });
        return;
      }
      if (lon !== undefined && (isNaN(lon) || lon < -180 || lon > 180)) {
        res.status(400).json({ error: 'Invalid longitude' });
        return;
      }

      const userId = req.user?.userId;
      if (!userId) {
        throw new AppError(401, 'Unauthorized');
      }

      const result = await processVoiceWithTokens({
        userId,
        businessRequestId: readIdempotencyKey(req),
        audioBuffer: req.file.buffer,
        audioMimeType: req.file.mimetype,
        lat,
        lon,
        conversationId,
        authorization: req.headers.authorization,
        persona,
        context,
        title,
        transcript,
        user: req.user,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
