import { z } from 'zod';
import dotenv from 'dotenv';
import { parseWalletPolicyConfig } from './wallet-policy.js';

dotenv.config();

/** Phase 2F-E strict parser for PROVIDER_RATE_CARD_PRICING_SOURCE. */
export function parseProviderRateCardPricingSource(
  value: unknown,
): 'STATIC' | 'DATABASE_SHADOW' | 'DATABASE_PRIMARY' {
  if (typeof value === 'string') {
    const v = value.trim().toUpperCase();
    if (v === 'STATIC' || v === 'DATABASE_SHADOW' || v === 'DATABASE_PRIMARY') return v;
    return 'STATIC';
  }
  return 'STATIC';
}

/**
 * Phase 2G-A strict parser for positive integer Wallet policy values.
 * Missing/empty values fall back to the caller-provided default; explicit
 * negatives, decimals, unsafe integers, and malformed strings are REJECTED by
 * throwing (never silently coerced).
 */
function parseStrictPositiveIntValue(
  value: unknown,
  defaultValue: number,
  name: string,
): number {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a safe positive integer`);
    }
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) return defaultValue;
    if (!/^[+-]?\d+$/.test(trimmed)) {
      throw new Error(`${name} must be a decimal integer string, got "${trimmed}"`);
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error(`${name} must be a safe positive integer`);
    }
    return parsed;
  }
  throw new Error(`${name} must be a decimal integer string`);
}

/**
 * Phase 2G-A strict parser for non-negative integer Wallet policy values
 * (e.g. SIGNUP_TOKEN_GRANT). Same rejection discipline as the positive parser.
 */
function parseStrictNonNegativeIntValue(
  value: unknown,
  defaultValue: number,
  name: string,
): number {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${name} must be a safe non-negative integer`);
    }
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) return defaultValue;
    if (!/^[+-]?\d+$/.test(trimmed)) {
      throw new Error(`${name} must be a decimal integer string, got "${trimmed}"`);
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new Error(`${name} must be a safe non-negative integer`);
    }
    return parsed;
  }
  throw new Error(`${name} must be a decimal integer string`);
}

function parseStrictBooleanValue(value: unknown, defaultValue: boolean, name: string): boolean {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  throw new Error(`${name} must be true or false`);
}

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
  AUTO_VERIFY_EMAIL: z.coerce.boolean().default(false),

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
  EXCHANGE_RATES_API_URL: z.string().url().default('https://v6.exchangerate-api.com/v6'),
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

  // Optional JSON override for AI pricing, e.g. '{"gemini-3.6-flash":{"input":0.3,"output":2.5}}'
  AI_PRICING_JSON: z.string().optional(),

  // Database Rate Card Shadow Pricing comparison (Phase 2F-D)
  // unset/false → disabled, true → comparison enabled
  // Accepted explicit strings: "true" (case-insensitive) → true, "false" → false.
  // Any other value (including "0", "1", "garbage", empty) → false (safe disabled).
  PROVIDER_RATE_CARD_DB_SHADOW_ENABLED: z.preprocess(
    (value) => {
      if (value === undefined || value === '' || value === null) return false;
      if (typeof value === 'string') {
        const v = value.trim().toLowerCase();
        if (v === 'true') return true;
        if (v === 'false') return false;
        return false;
      }
      if (typeof value === 'boolean') return value;
      return false;
    },
    z.boolean(),
  ).default(false),

  // Optional timeout (ms) for the DB shadow branch. Must be a positive integer.
  // unset/empty/invalid → safe default 150 ms.
  PROVIDER_RATE_CARD_DB_SHADOW_TIMEOUT_MS: z.preprocess(
    (value) => {
      if (value === undefined || value === '' || value === null) return 150;
      if (typeof value === 'string') {
        const n = parseInt(value.trim(), 10);
        if (Number.isInteger(n) && n > 0) return n;
        return 150;
      }
      if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
      return 150;
    },
    z.number().int().positive(),
  ).default(150),

  // Database Rate Card Pricing Source (Phase 2F-E)
  // Controls whether the database rate card is the authoritative pricing source.
  // Allowed values (case-insensitive, trimmed):
  //   STATIC           (default) — static PROVIDER_RATE_CARD is authoritative;
  //                   the database rate card is used only when the 2F-D shadow
  //                   flag PROVIDER_RATE_CARD_DB_SHADOW_ENABLED is enabled, and
  //                   then only for comparison (never for billing).
  //   DATABASE_SHADOW  — the database rate card is loaded for shadow comparison
  //                   (equivalent to enabling PROVIDER_RATE_CARD_DB_SHADOW_ENABLED);
  //                   static remains authoritative.
  //   DATABASE_PRIMARY — the database rate card is the authoritative pricing source.
  // Malformed / empty / unknown values resolve to STATIC (safe disabled); a typo
  // can never silently enable the database as the pricing source.
  PROVIDER_RATE_CARD_PRICING_SOURCE: z.preprocess(
    (value) => {
      if (value === undefined || value === '' || value === null) return 'STATIC';
      return parseProviderRateCardPricingSource(value);
    },
    z.enum(['STATIC', 'DATABASE_SHADOW', 'DATABASE_PRIMARY']),
  ).default('STATIC'),

  // Free tier: tokens granted on a new tourist's first successful login.
  SIGNUP_TOKEN_GRANT: z.preprocess(
    (value) => parseStrictNonNegativeIntValue(value, 400, 'SIGNUP_TOKEN_GRANT'),
    z.number(),
  ).default(400),

  // Phase 2G-A Wallet usage-based billing policy.
  // Denomination: one Wallet Token = WALLET_TOKEN_VALUE_NANO_USD nano-USD
  // (default 100000 nano-USD = 100 micro-USD = $0.0001).
  // Markup: WALLET_MARKUP_BASIS_POINTS applied once per billing operation
  // (default 10000 = 1.00x, no extra markup).
  // Minimum charge: MINIMUM_WALLET_CHARGE (default 1 token), applied ONLY for
  // fully-priced positive-cost zero-round results.
  // Reservation ceiling: AI_BILLING_MAX_RESERVATION_TOKENS is an optional JSON
  // map of { feature: positive int } overriding the default per-feature cap.
  // The legacy FIXED billing mode (AI_WALLET_BILLING_MODE) was removed in
  // Phase 2G-B; usage-based Wallet billing is the only live billing path.
  WALLET_TOKEN_VALUE_NANO_USD: z.preprocess(
    (value) => parseStrictPositiveIntValue(value, 100000, 'WALLET_TOKEN_VALUE_NANO_USD'),
    z.number(),
  ).default(100000),

  WALLET_MARKUP_BASIS_POINTS: z.preprocess(
    (value) => parseStrictPositiveIntValue(value, 10000, 'WALLET_MARKUP_BASIS_POINTS'),
    z.number(),
  ).default(10000),

  MINIMUM_WALLET_CHARGE: z.preprocess(
    (value) => parseStrictPositiveIntValue(value, 1, 'MINIMUM_WALLET_CHARGE'),
    z.number(),
  ).default(1),

  AI_BILLING_MAX_RESERVATION_TOKENS: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().optional(),
  ),

  // Phase 1 automatic stale-reservation recovery. Expiry remains the
  // reservation service's existing TTL; these settings only control polling.
  AI_BILLING_RECOVERY_ENABLED: z.preprocess(
    (value) => parseStrictBooleanValue(value, true, 'AI_BILLING_RECOVERY_ENABLED'),
    z.boolean(),
  ).default(true),
  AI_BILLING_RECOVERY_POLL_INTERVAL_MS: z.preprocess(
    (value) => parseStrictPositiveIntValue(value, 60_000, 'AI_BILLING_RECOVERY_POLL_INTERVAL_MS'),
    z.number().int().positive(),
  ).default(60_000),
  AI_BILLING_RECOVERY_BATCH_SIZE: z.preprocess(
    (value) => parseStrictPositiveIntValue(value, 25, 'AI_BILLING_RECOVERY_BATCH_SIZE'),
    z.number().int().min(1).max(100),
  ).default(25),
});

export const env = envSchema.parse(process.env);

/**
 * Phase 2G-A strict Wallet policy snapshot derived from the validated
 * environment. This is the single runtime source of Wallet denomination,
 * markup, minimum charge, first-login grant, and billing mode.
 */
export const walletPolicyConfig = parseWalletPolicyConfig({
  SIGNUP_TOKEN_GRANT: env.SIGNUP_TOKEN_GRANT,
  WALLET_TOKEN_VALUE_NANO_USD: env.WALLET_TOKEN_VALUE_NANO_USD,
  WALLET_MARKUP_BASIS_POINTS: env.WALLET_MARKUP_BASIS_POINTS,
  MINIMUM_WALLET_CHARGE: env.MINIMUM_WALLET_CHARGE,
  AI_BILLING_MAX_RESERVATION_TOKENS: env.AI_BILLING_MAX_RESERVATION_TOKENS,
});
