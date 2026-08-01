import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { uploadIdentificationImage } from '../utils/upload.js';
import { identifyLandmark } from '../services/identify.service.js';

const router = Router();

router.post('/', authenticate, uploadIdentificationImage.single('image'), async (req, res, next) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'Image file is required' });
      return;
    }

    const lat = req.body.lat ? Number(req.body.lat) : undefined;
    const lon = req.body.lon ? Number(req.body.lon) : undefined;
    const radius = req.body.radius ? Number(req.body.radius) : 500;

    if (lat !== undefined && (isNaN(lat) || lat < -90 || lat > 90)) {
      res.status(400).json({ error: 'Invalid latitude' });
      return;
    }
    if (lon !== undefined && (isNaN(lon) || lon < -180 || lon > 180)) {
      res.status(400).json({ error: 'Invalid longitude' });
      return;
    }
    if (isNaN(radius) || radius < 0) {
      res.status(400).json({ error: 'Invalid radius' });
      return;
    }

    const result = await identifyLandmark(req.file.buffer, req.file.mimetype, {
      userId: req.user!.userId,
      lat,
      lon,
      radius,
      authorization: req.headers.authorization,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
