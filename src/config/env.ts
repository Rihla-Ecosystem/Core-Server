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

  ADMIN_SESSION_SECRET: z.string().min(32),
  ADMIN_EMAIL: z.string().email(),
  ADMIN_PASSWORD: z.string().min(8),

  CONTEXT_SERVICE_URL: z.string().url().default('http://context-service:3001'),
  GIS_SERVICE_URL: z.string().url().default('http://gis-service:3002'),
  RISK_SERVICE_URL: z.string().url().default('http://risk-intelligence:3004'),
  AI_SERVICE_URL: z.string().url().default('http://ai-service:3003'),
  INTERNAL_API_KEY: z.string().min(32),
  // Treat an explicitly empty value in local/test env files as unset.
  EXCHANGE_RATES_API_KEY: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(1).optional(),
  ),
  EXCHANGE_RATES_API_URL: z.string().url().default('https://api.exchangerate.host/latest'),
  EXCHANGE_RATES_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  WEATHER_SERVICE_URL: z.string().url().optional(),
  AIR_QUALITY_SERVICE_URL: z.string().url().optional(),
  PRAYER_TIMES_SERVICE_URL: z.string().url().optional(),

  PAYMOB_SECRET_KEY: z.string().min(1),
  PAYMOB_PUBLIC_KEY: z.string().min(1),
  PAYMOB_HMAC_SECRET: z.string().min(1),
  PAYMOB_CARD_INTEGRATION_ID: z.coerce.number().int().positive(),
  PAYMOB_REDIRECTION_URL: z.string().url(),
  PAYMOB_NOTIFICATION_URL: z.string().url(),
  PAYMOB_API_BASE_URL: z.string().url().default('https://accept.paymob.com'),
});

export const env = envSchema.parse(process.env);
