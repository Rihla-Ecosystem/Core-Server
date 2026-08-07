import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { env } from '../config/env.js';
import { authenticate } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';

const router = Router();

const PREFIX = '/api/ai-service';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

function upstreamPath(req: Request): string {
  return req.originalUrl.startsWith(PREFIX)
    ? req.originalUrl.slice(PREFIX.length)
    : req.path;
}

async function proxyJson(req: Request, res: Response) {
  const targetUrl = `${env.AI_SERVICE_URL}${upstreamPath(req)}`;

  try {
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Api-Key': env.INTERNAL_API_KEY,
        ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}),
      },
      body: req.method !== 'GET' && req.method !== 'HEAD' ? JSON.stringify(req.body) : undefined,
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    res.status(503).json({ error: 'AI service unavailable' });
  }
}

async function proxyUpload(req: Request, res: Response) {
  const targetUrl = `${env.AI_SERVICE_URL}${req.path}`;

  const formData = new FormData();
  if (req.file) {
    const copy = new Uint8Array(req.file.buffer);
    formData.append('file', new Blob([copy.buffer as ArrayBuffer], { type: req.file.mimetype }), req.file.originalname);
  }
  for (const [key, value] of Object.entries(req.body ?? {})) {
    formData.append(key, String(value));
  }

  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'X-Internal-Api-Key': env.INTERNAL_API_KEY,
        ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}),
      },
      body: formData,
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    res.status(503).json({ error: 'AI service unavailable' });
  }
}

router.use('/ingest', authenticate, requireRole('admin'));
router.post('/ingest', upload.single('file'), proxyUpload);
router.use('/ingest', proxyJson);

export default router;
