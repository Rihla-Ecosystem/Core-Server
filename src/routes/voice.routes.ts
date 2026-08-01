import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { uploadAudio } from '../utils/upload.js';
import { processVoice } from '../services/voice.service.js';

const router = Router();

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
