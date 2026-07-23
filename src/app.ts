import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import swaggerUi from 'swagger-ui-express';
import { env } from './config/env.js';
import { swaggerSpec } from './config/swagger.js';
import { getAdminRouter } from './config/admin.js';
import { errorHandler } from './middleware/errorHandler.js';
import routes from './routes/index.js';
import vectorUploadRoute from "./routes/Vectorupload.route.js";

const app = express();

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors());
app.use(cookieParser());
app.use(express.json());

// console any request
app.use((req, _res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

app.use('/api', routes);
app.use("/api/vector/upload", vectorUploadRoute);

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
