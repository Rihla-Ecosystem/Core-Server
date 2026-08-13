/**
 * Phase 2G-B authoritative billing rate-card resolver.
 *
 * Resolves the single rate card used to bill one Wallet usage-based AI
 * operation from the configured `PROVIDER_RATE_CARD_PRICING_SOURCE`:
 *  - STATIC:          the static `PROVIDER_RATE_CARD` is authoritative.
 *  - DATABASE_SHADOW: static remains authoritative for billing; the database
 *                     card is used only for observation (admin-driven
 *                     comparison), never for billing.
 *  - DATABASE_PRIMARY: the ACTIVE database rate card is authoritative. The
 *                     card is loaded exactly once per operation and its exact
 *                     snapshot version flows into the AIBillingOperation
 *                     pricing evidence. A missing / invalid / conflicting /
 *                     failed load NEVER falls back to static pricing and NEVER
 *                     bills zero: it surfaces `BillingRateCardUnavailableError`
 *                     and the caller fails the operation closed (AI is not
 *                     executed).
 *
 * The module reads environment configuration through injected dependencies so
 * tests can substitute a fake loader/clock/static card.
 */

import { env } from '../config/env.js';
import { PROVIDER_RATE_CARD } from '../config/provider-rate-card/index.js';
import { prisma } from '../config/prisma.js';
import { createPrismaProviderRateCardRepository } from '../repositories/provider-rate-card.repository.js';
import {
  createDefaultProviderRateCardLoaderDependencies,
  loadActiveRateCardForDate,
} from './provider-rate-card-loader.service.js';
import type { ProviderRateCardLoadResult } from './provider-rate-card-loader.service.js';
import type { ProviderRateCardPricingSource } from './shadow-pricing-deps.js';
import type { ProviderRateCard } from '../types/provider-pricing.js';
import { ProviderRateCardLoadError } from '../types/provider-rate-card-load.js';

/** The authoritative billing rate-card source (Phase 2F-E). */
export type BillingRateCardPricingSource = ProviderRateCardPricingSource;

/** Resolved billing card: the engine card plus the source that produced it. */
export interface BillingRateCardResolution {
  card: ProviderRateCard;
  source: BillingRateCardPricingSource;
  /** Snapshot metadata when the card came from the database, else null. */
  snapshot: ProviderRateCardLoadResult['snapshot'] | null;
}

/**
 * Raised when the authoritative database rate card cannot be resolved. The
 * caller must fail the operation closed: never execute AI, never bill zero,
 * never fall back to static pricing.
 */
export class BillingRateCardUnavailableError extends Error {
  readonly code: string;
  readonly pricingDate?: string;
  readonly version?: string;

  constructor(code: string, message: string, options: { pricingDate?: string; version?: string } = {}) {
    super(message);
    this.name = 'BillingRateCardUnavailableError';
    this.code = code;
    this.pricingDate = options.pricingDate;
    this.version = options.version;
  }
}

/** Injected dependencies for the resolver (test seams). */
export interface BillingRateCardDependencies {
  pricingSource: BillingRateCardPricingSource;
  staticCard: ProviderRateCard;
  loadActiveRateCardForDate?: (pricingDate: string) => Promise<ProviderRateCardLoadResult>;
  now?: () => Date;
}

/** Build the default resolver dependencies from the environment + Prisma. */
export function createDefaultBillingRateCardDependencies(): BillingRateCardDependencies {
  const loaderDeps = createDefaultProviderRateCardLoaderDependencies(
    createPrismaProviderRateCardRepository(prisma),
  );
  return {
    // Dynamic reservation and settlement are database-rate-card-only. The
    // legacy environment selector remains for explicit test dependency seams,
    // but production resolution never permits a static authoritative card.
    pricingSource: 'DATABASE_PRIMARY',
    staticCard: PROVIDER_RATE_CARD,
    loadActiveRateCardForDate: (pricingDate) => loadActiveRateCardForDate(loaderDeps, pricingDate),
    now: () => new Date(),
  };
}

/** Canonical UTC pricing date for a clock instant (`YYYY-MM-DD`). */
export function todayPricingDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function mapLoadFailure(
  err: unknown,
  pricingDate: string,
): BillingRateCardUnavailableError {
  if (err instanceof ProviderRateCardLoadError) {
    return new BillingRateCardUnavailableError(err.code, err.message, {
      pricingDate: err.pricingDate ?? pricingDate,
      version: err.version,
    });
  }
  return new BillingRateCardUnavailableError(
    'RATE_CARD_DATABASE_ERROR',
    'could not load the active database rate card',
    { pricingDate },
  );
}

/**
 * Resolve the rate card for one billing operation. Call exactly once per
 * operation and thread the resolved card through the whole billing lifecycle
 * (reservation, pricing, settlement) — never re-resolve per provider call.
 */
export async function resolveBillingRateCard(
  deps: BillingRateCardDependencies = createDefaultBillingRateCardDependencies(),
  pricingDate?: string,
): Promise<BillingRateCardResolution> {
  if (deps.pricingSource === 'DATABASE_PRIMARY') {
    if (!deps.loadActiveRateCardForDate) {
      throw new BillingRateCardUnavailableError(
        'RATE_CARD_DATABASE_ERROR',
        'database rate card loader is unavailable',
      );
    }
    const date = pricingDate ?? todayPricingDate(deps.now ? deps.now() : new Date());
    let loaded: ProviderRateCardLoadResult;
    try {
      loaded = await deps.loadActiveRateCardForDate(date);
    } catch (err) {
      throw mapLoadFailure(err, date);
    }
    return { card: loaded.card, source: 'DATABASE_PRIMARY', snapshot: loaded.snapshot };
  }
  return { card: deps.staticCard, source: deps.pricingSource, snapshot: null };
}
