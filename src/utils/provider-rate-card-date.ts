/**
 * Phase 2F-B pricing-date safety helpers.
 *
 * The Pricing Engine consumes a canonical date-only `YYYY-MM-DD` string
 * (`requireIsoDate` in `src/utils/provider-pricing/rate-card.ts`). The
 * repository/loader boundary uses the exact same canonical representation, so
 * there is exactly one way to express a pricing date. JavaScript `Date` is not
 * accepted: timestamps, ambiguous locale dates, and invalid calendar dates are
 * rejected with `RATE_CARD_INVALID_PRICING_DATE` instead of being silently
 * shifted to a machine-local midnight.
 *
 * For Prisma `@db.Date` comparisons the canonical string is converted to a
 * UTC-midnight `Date`; PostgreSQL `DATE` has no timezone, so a UTC midnight
 * represents exactly the requested calendar day.
 */

import { ProviderRateCardLoadError } from '../types/provider-rate-card-load.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidDate(message: string): ProviderRateCardLoadError {
  return new ProviderRateCardLoadError(
    'RATE_CARD_INVALID_PRICING_DATE',
    message,
  );
}

/**
 * Strictly validate a canonical pricing date.
 *
 * Accepts exactly an ISO `YYYY-MM-DD` string that is a real calendar date.
 * Rejects timestamps, non-strings, and locale/ambiguous formats. Returns the
 * trimmed normalized string.
 */
export function normalizePricingDate(value: unknown): string {
  if (typeof value !== 'string') {
    throw invalidDate('pricingDate must be an ISO date string (YYYY-MM-DD)');
  }
  const trimmed = value.trim();
  if (!ISO_DATE.test(trimmed)) {
    throw invalidDate('pricingDate must be an ISO date string (YYYY-MM-DD)');
  }
  const asDate = new Date(`${trimmed}T00:00:00Z`);
  if (Number.isNaN(asDate.getTime())) {
    throw invalidDate(`pricingDate "${trimmed}" is not a valid calendar date`);
  }
  // Guard against regex-accepted but calendar-invalid dates (e.g. 2026-02-31).
  if (asDate.toISOString().slice(0, 10) !== trimmed) {
    throw invalidDate(`pricingDate "${trimmed}" is not a valid calendar date`);
  }
  return trimmed;
}

/**
 * Convert a canonical pricing date (already normalized) to a UTC-midnight
 * `Date` for Prisma `@db.Date` comparisons. Assumes the input is valid.
 */
export function pricingDateToUtcDate(pricingDate: string): Date {
  return new Date(`${pricingDate}T00:00:00Z`);
}

/** True when `value` is a `ProviderRateCardSnapshotRow`-compatible object. */
export function isSnapshotRow(value: unknown): boolean {
  return isRecord(value) && Array.isArray(value['entries']);
}
