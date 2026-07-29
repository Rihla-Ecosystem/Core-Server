import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_ACCESS_EXPIRY: z.string().default('15m'),
  REFRESH_TOKEN_EXPIRY_DAYS: z.coerce.number().default(30),
  FRONTEND_URL: z.string().url(),
  CORS_ORIGIN: z.string().min(1),
  BCRYPT_COST: z.coerce.number().default(12),
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  SMTP_HOST: z.string().default('smtp.gmail.com'),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().min(1),
  SMTP_PASS: z.string().min(1),
  EMAIL_FROM: z.string().default('ITI Hub <noreply@itihub.com>'),

  CLOUDINARY_CLOUD_NAME: z.string().min(1),
  CLOUDINARY_API_KEY: z.string().min(1),
  CLOUDINARY_API_SECRET: z.string().min(1),

  ADMIN_SESSION_SECRET: z.string().min(32).default('change-me-to-a-long-secret-at-least-32-chars'),
  ADMIN_EMAIL: z.string().email().default('admin@itihub.com'),
  ADMIN_PASSWORD: z.string().min(8).default('Admin123!'),

  // Context service (weather, air quality, prayer times) — not yet implemented
  CONTEXT_SERVICE_URL: z.string().url().optional(),
  GIS_SERVICE_URL: z.string().url().default('http://gis-service:8000'),
  RISK_SERVICE_URL: z.string().url().default('http://risk-intelligence:3000'),
  AI_SERVICE_URL: z.string().url().default('http://ai-service:3003'),
  INTERNAL_API_KEY: z.string().min(1).default('rihla-internal-dev-key'),
});

export const env = envSchema.parse(process.env);
