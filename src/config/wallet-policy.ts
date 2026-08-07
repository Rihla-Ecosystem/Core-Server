import {
  BUSINESS_TOKEN_FEATURES,
  getBusinessTokenCost,
  isBusinessTokenFeature,
} from './business-token-features.js';
import type { BusinessTokenFeature } from './business-token-features.js';

/**
 * Phase 2G-A strict Wallet usage-based billing policy configuration.
 *
 * Denomination policy (locked):
 *  - `WALLET_TOKEN_VALUE_NANO_USD` is the only source of truth for how much one
 *    Wallet Token is worth. It is expressed in nano-USD (1 nano-USD =
 *    1e-9 USD). The default `100000` means one Wallet Token = 100,000 nano-USD
 *    = 100 micro-USD = $0.0001.
 *  - `WALLET_MARKUP_BASIS_POINTS` is the Wallet markup applied ONCE per billing
 *    operation. `10000` = 1.00x (no extra markup).
 *  - `MINIMUM_WALLET_CHARGE` is the smallest chargeable Wallet Token amount.
 *  - Denomination is never hardcoded in pricing arithmetic; every conversion
 *    reads these values.
 *
 * Billing policy (Phase 2G-B locked):
 *  - The legacy fixed billing mode (`AI_WALLET_BILLING_MODE`) was removed.
 *    Usage-based Wallet billing is the only live billing path.
 *
 * Strict parsing (locked): values that are negatives, decimals where integers
 * are required, unsafe integers, or malformed strings are REJECTED by throwing
 * `WalletPolicyConfigurationError`. No silent coercion.
 */

export const DEFAULT_SIGNUP_TOKEN_GRANT = 100;
export const DEFAULT_WALLET_TOKEN_VALUE_NANO_USD = 100_000;
export const DEFAULT_WALLET_MARKUP_BASIS_POINTS = 10_000;
export const DEFAULT_MINIMUM_WALLET_CHARGE = 1;

/** Default per-feature reservation ceiling (Wallet Tokens). */
export const DEFAULT_MAX_RESERVATION_TOKENS = 1_000;

export const WALLET_POLICY_VERSION = '1';

export const WALLET_POLICY_ENV_VARS = Object.freeze({
  signupTokenGrant: 'SIGNUP_TOKEN_GRANT',
  walletTokenValueNanoUsd: 'WALLET_TOKEN_VALUE_NANO_USD',
  markupBasisPoints: 'WALLET_MARKUP_BASIS_POINTS',
  minimumWalletTokens: 'MINIMUM_WALLET_CHARGE',
  maxReservationTokensJson: 'AI_BILLING_MAX_RESERVATION_TOKENS',
} as const);

export class WalletPolicyConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletPolicyConfigurationError';
  }
}

export interface WalletPolicyConfig {
  /** Tokens credited on the FIRST successful tourist login (never twice). */
  signupTokenGrant: number;
  /** Nano-USD value of one Wallet Token. Must be a safe positive integer. */
  walletTokenValueNanoUsd: number;
  /** Markup applied once per billing operation, in basis points. */
  markupBasisPoints: number;
  /** Smallest chargeable Wallet Token amount. */
  minimumWalletTokens: number;
  /** Per-feature reservation ceiling (Wallet Tokens). */
  maxReservationTokensByFeature: Readonly<Record<BusinessTokenFeature, number>>;
  /** Wallet policy version recorded on reservation/operation evidence. */
  version: string;
}

export type WalletPolicyEnv = Record<string, string | number | undefined>;

const DECIMAL_INTEGER_PATTERN = /^[+-]?\d+$/;

function parsePositiveInteger(
  env: WalletPolicyEnv,
  envName: string,
  field: string,
  defaultValue: number,
): number {
  const raw = env[envName];
  if (raw === undefined) return defaultValue;

  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw) || raw <= 0) {
      throw new WalletPolicyConfigurationError(
        `${field} (${envName}) must be a safe positive integer`,
      );
    }
    return raw;
  }

  if (typeof raw !== 'string') {
    throw new WalletPolicyConfigurationError(
      `${field} (${envName}) must be a decimal integer string`,
    );
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new WalletPolicyConfigurationError(
      `${field} (${envName}) must not be empty`,
    );
  }

  if (!DECIMAL_INTEGER_PATTERN.test(trimmed)) {
    throw new WalletPolicyConfigurationError(
      `${field} (${envName}) must be a decimal integer string, got "${trimmed}"`,
    );
  }

  const value = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new WalletPolicyConfigurationError(
      `${field} (${envName}) must be a safe positive integer`,
    );
  }
  return value;
}

function parseNonNegativeInteger(
  env: WalletPolicyEnv,
  envName: string,
  field: string,
  defaultValue: number,
): number {
  const raw = env[envName];
  if (raw === undefined) return defaultValue;

  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw) || raw < 0) {
      throw new WalletPolicyConfigurationError(
        `${field} (${envName}) must be a safe non-negative integer`,
      );
    }
    return raw;
  }

  if (typeof raw !== 'string') {
    throw new WalletPolicyConfigurationError(
      `${field} (${envName}) must be a decimal integer string`,
    );
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new WalletPolicyConfigurationError(
      `${field} (${envName}) must not be empty`,
    );
  }

  if (!DECIMAL_INTEGER_PATTERN.test(trimmed)) {
    throw new WalletPolicyConfigurationError(
      `${field} (${envName}) must be a decimal integer string, got "${trimmed}"`,
    );
  }

  const value = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WalletPolicyConfigurationError(
      `${field} (${envName}) must be a safe non-negative integer`,
    );
  }
  return value;
}

/**
 * Strict parser for the per-feature reservation ceiling override. Only
 * `AI_BILLING_MAX_RESERVATION_TOKENS` is consumed; the legacy fixed billing
 * mode parser was removed in Phase 2G-B.
 */
function parseMaxReservationTokens(
  env: WalletPolicyEnv,
): Readonly<Record<BusinessTokenFeature, number>> {
  const raw = env[WALLET_POLICY_ENV_VARS.maxReservationTokensJson];
  const result = {} as Record<BusinessTokenFeature, number>;

  for (const feature of BUSINESS_TOKEN_FEATURES) {
    result[feature] = DEFAULT_MAX_RESERVATION_TOKENS;
  }

  if (raw === undefined || raw === '') {
    return Object.freeze(result);
  }

  if (typeof raw !== 'string') {
    throw new WalletPolicyConfigurationError(
      `${WALLET_POLICY_ENV_VARS.maxReservationTokensJson} must be a JSON object string`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new WalletPolicyConfigurationError(
      `${WALLET_POLICY_ENV_VARS.maxReservationTokensJson} must be valid JSON`,
    );
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WalletPolicyConfigurationError(
      `${WALLET_POLICY_ENV_VARS.maxReservationTokensJson} must be a JSON object`,
    );
  }

  for (const [feature, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof feature !== 'string' || feature.trim().length === 0) continue;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      throw new WalletPolicyConfigurationError(
        `${WALLET_POLICY_ENV_VARS.maxReservationTokensJson} entry "${feature}" must be a safe positive integer`,
      );
    }
    if (!isBusinessTokenFeature(feature)) {
      throw new WalletPolicyConfigurationError(
        `${WALLET_POLICY_ENV_VARS.maxReservationTokensJson} references unknown feature "${feature}"`,
      );
    }
    const typed = feature;
    if (value < getBusinessTokenCost(typed)) {
      throw new WalletPolicyConfigurationError(
        `${WALLET_POLICY_ENV_VARS.maxReservationTokensJson} entry "${feature}" must not be below the fixed feature cost`,
      );
    }
    result[typed] = value;
  }

  return Object.freeze(result);
}

/**
 * Pure strict parser. Reads the raw environment-like object and returns a fresh,
 * frozen `WalletPolicyConfig`. Missing values fall back to the documented
 * defaults; malformed explicit values throw `WalletPolicyConfigurationError`.
 */
export function parseWalletPolicyConfig(env: WalletPolicyEnv): WalletPolicyConfig {
  const config: WalletPolicyConfig = {
    signupTokenGrant: parseNonNegativeInteger(
      env,
      WALLET_POLICY_ENV_VARS.signupTokenGrant,
      'signupTokenGrant',
      DEFAULT_SIGNUP_TOKEN_GRANT,
    ),
    walletTokenValueNanoUsd: parsePositiveInteger(
      env,
      WALLET_POLICY_ENV_VARS.walletTokenValueNanoUsd,
      'walletTokenValueNanoUsd',
      DEFAULT_WALLET_TOKEN_VALUE_NANO_USD,
    ),
    markupBasisPoints: parsePositiveInteger(
      env,
      WALLET_POLICY_ENV_VARS.markupBasisPoints,
      'markupBasisPoints',
      DEFAULT_WALLET_MARKUP_BASIS_POINTS,
    ),
    minimumWalletTokens: parsePositiveInteger(
      env,
      WALLET_POLICY_ENV_VARS.minimumWalletTokens,
      'minimumWalletTokens',
      DEFAULT_MINIMUM_WALLET_CHARGE,
    ),
    maxReservationTokensByFeature: parseMaxReservationTokens(env),
    version: WALLET_POLICY_VERSION,
  };

  return Object.freeze(config);
}
