import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { ProviderRateCard } from '../src/types/provider-pricing.js';
import { ProviderRateCardLoadError } from '../src/types/provider-rate-card-load.js';
import {
  BillingRateCardUnavailableError,
  resolveBillingRateCard,
  todayPricingDate,
} from '../src/services/billing-rate-card.service.js';
import type { BillingRateCardDependencies } from '../src/services/billing-rate-card.service.js';
import type { ProviderRateCardLoadResult } from '../src/services/provider-rate-card-loader.service.js';

const FAKE_CARD = { version: 'static-v1', entries: [] } as unknown as ProviderRateCard;
const FAKE_SNAPSHOT = {
  version: 'db-v1',
  effectiveFrom: null,
  effectiveTo: null,
} as ProviderRateCardLoadResult['snapshot'];
const FAKE_LOADED_CARD = { version: 'db-v1', entries: [] } as unknown as ProviderRateCard;

function depsWith(
  source: BillingRateCardDependencies['pricingSource'],
  overrides: Partial<BillingRateCardDependencies> = {},
): BillingRateCardDependencies {
  return { pricingSource: source, staticCard: FAKE_CARD, ...overrides };
}

describe('Phase 2G-B authoritative billing rate card (billing-rate-card.service)', () => {
  test('1. todayPricingDate returns the UTC calendar date', () => {
    const now = new Date('2026-08-07T00:30:00Z');
    assert.equal(todayPricingDate(now), '2026-08-07');
    const late = new Date('2026-08-07T23:59:59.999Z');
    assert.equal(todayPricingDate(late), '2026-08-07');
  });

  test('2. STATIC resolves the static card with snapshot null', async () => {
    const result = await resolveBillingRateCard(depsWith('STATIC'), '2026-08-07');
    assert.equal(result.card, FAKE_CARD);
    assert.equal(result.source, 'STATIC');
    assert.equal(result.snapshot, null);
  });

  test('3. DATABASE_SHADOW resolves the static card (observation only)', async () => {
    let loaderCalled = false;
    const result = await resolveBillingRateCard(
      depsWith('DATABASE_SHADOW', {
        loadActiveRateCardForDate: async () => {
          loaderCalled = true;
          throw new ProviderRateCardLoadError('RATE_CARD_NOT_FOUND', 'not found');
        },
      }),
      '2026-08-07',
    );
    assert.equal(result.card, FAKE_CARD);
    assert.equal(result.source, 'DATABASE_SHADOW');
    assert.equal(result.snapshot, null);
    assert.equal(loaderCalled, false, 'shadow mode never loads from the database');
  });

  test('4. DATABASE_PRIMARY loads the active DB card exactly once and propagates snapshot', async () => {
    let calls = 0;
    const result = await resolveBillingRateCard(
      depsWith('DATABASE_PRIMARY', {
        loadActiveRateCardForDate: async (pricingDate) => {
          calls += 1;
          assert.equal(pricingDate, '2026-08-07');
          return { card: FAKE_LOADED_CARD, snapshot: FAKE_SNAPSHOT };
        },
      }),
      '2026-08-07',
    );
    assert.equal(calls, 1);
    assert.equal(result.card, FAKE_LOADED_CARD);
    assert.equal(result.source, 'DATABASE_PRIMARY');
    assert.equal(result.snapshot, FAKE_SNAPSHOT);
  });

  test('5. DATABASE_PRIMARY load failure never falls back to static; maps loader error code', async () => {
    await assert.rejects(
      resolveBillingRateCard(
        depsWith('DATABASE_PRIMARY', {
          loadActiveRateCardForDate: async () => {
            throw new ProviderRateCardLoadError('RATE_CARD_NOT_FOUND', 'no active card', {
              pricingDate: '2026-08-07',
            });
          },
        }),
        '2026-08-07',
      ),
      (err: unknown) => {
        assert.ok(err instanceof BillingRateCardUnavailableError);
        assert.equal(err.code, 'RATE_CARD_NOT_FOUND');
        assert.equal(err.pricingDate, '2026-08-07');
        return true;
      },
    );
  });

  test('6. DATABASE_PRIMARY unexpected loader error maps to RATE_CARD_DATABASE_ERROR', async () => {
    await assert.rejects(
      resolveBillingRateCard(
        depsWith('DATABASE_PRIMARY', {
          loadActiveRateCardForDate: async () => {
            throw new Error('prisma down');
          },
        }),
        '2026-08-07',
      ),
      (err: unknown) => {
        assert.ok(err instanceof BillingRateCardUnavailableError);
        assert.equal(err.code, 'RATE_CARD_DATABASE_ERROR');
        return true;
      },
    );
  });

  test('7. DATABASE_PRIMARY without a loader is unavailable (fail closed)', async () => {
    await assert.rejects(
      resolveBillingRateCard(depsWith('DATABASE_PRIMARY', { loadActiveRateCardForDate: undefined })),
      (err: unknown) => {
        assert.ok(err instanceof BillingRateCardUnavailableError);
        assert.equal(err.code, 'RATE_CARD_DATABASE_ERROR');
        return true;
      },
    );
  });

  test('8. DATABASE_PRIMARY uses the injected clock when no pricingDate is supplied', async () => {
    const clock = new Date('2026-08-07T12:00:00Z');
    let seen = '';
    const result = await resolveBillingRateCard(
      depsWith('DATABASE_PRIMARY', {
        now: () => clock,
        loadActiveRateCardForDate: async (pricingDate) => {
          seen = pricingDate;
          return { card: FAKE_LOADED_CARD, snapshot: FAKE_SNAPSHOT };
        },
      }),
    );
    assert.equal(seen, '2026-08-07');
    assert.equal(result.source, 'DATABASE_PRIMARY');
  });
});
