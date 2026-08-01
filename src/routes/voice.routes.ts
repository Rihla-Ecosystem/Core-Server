import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { uploadAudio } from '../utils/upload.js';
import { processVoice } from '../services/voice.service.js';
import { env } from '../config/env.js';

const router = Router();

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

router.post('/', authenticate, uploadAudio.single('audio'), async (req, res, next) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'Audio file is required' });
      return;
    }

    const lat = req.body.lat ? Number(req.body.lat) : undefined;
    const lon = req.body.lon ? Number(req.body.lon) : undefined;
    const conversationId = req.body.conversation_id;

    if (lat !== undefined && (isNaN(lat) || lat < -90 || lat > 90)) {
      res.status(400).json({ error: 'Invalid latitude' });
      return;
    }
    if (lon !== undefined && (isNaN(lon) || lon < -180 || lon > 180)) {
      res.status(400).json({ error: 'Invalid longitude' });
      return;
    }

    const result = await processVoice(req.file.buffer, req.file.mimetype, {
      userId: req.user!.userId,
      lat,
      lon,
      conversationId,
      authorization: req.headers.authorization,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
