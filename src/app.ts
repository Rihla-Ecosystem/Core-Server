import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import swaggerUi from 'swagger-ui-express';
import { env } from './config/env.js';
import { swaggerSpec } from './config/swagger.js';
import { getAdminRouter } from './config/admin.js';
import { errorHandler } from './middleware/errorHandler.js';
import { apiLogMiddleware } from './middleware/api-log.js';
import routes from './routes/index.js';

const app = express();

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
const corsOrigins = env.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean);
const isLocalhostOrigin = (origin: string | undefined): boolean => {
  if (!origin) return false;
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
};
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

app.use(cookieParser());
app.use(express.json());
app.use(apiLogMiddleware);

app.use('/api', routes);

app.get('/api/docs.json', (_req, res) => {
  res.json(swaggerSpec);
});
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

let adminInitialized = false;
app.use('/admin-panel', async (req, res, next) => {
  if (!adminInitialized) {
    try {
      const router = await getAdminRouter();
      app.use('/admin-panel', router);
      adminInitialized = true;
    } catch (err) {
      return next(err);
    }
  }
  next();
});

app.use(errorHandler);

export default app;
