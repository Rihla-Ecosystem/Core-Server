/**
 * Phase 2F-C pure entry-import conversion tests (no database).
 *
 * Proves the pure converter validates an engine-domain rate card through the
 * existing engine validator and produces the exact bigint DB row payload:
 * non-negative safe-integer money → bigint, lowercase engine tiers →
 * uppercase DB enums, ISO dates → UTC-midnight Dates, aliases → arrays, and
 * duplicate (provider, model, tier) identities rejected (DB unique identity
 * excludes the effective window).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  convertRateCardForImport,
  convertEntriesForImport,
  ProviderRateCardImportError,
} from '../src/utils/provider-pricing/entry-import.js';

function makeCard(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    currency: 'USD',
    storageUnit: 'MICROS',
    engineUnit: 'NANO_USD',
    version: '1.0.0',
    source: 'https://example.test/pricing',
    generatedAt: '2026-08-03',
    provenance: 'RESEARCH_SNAPSHOT',
    entries: [
      {
        provider: 'google',
        model: 'gemini-x',
        status: 'STABLE',
        tier: 'standard',
        billingUnit: 'TOKEN',
        tokenRates: {
          inputMicrosPerMillion: 1_500_000,
          outputMicrosPerMillion: 7_500_000,
          cachedInputMicrosPerMillion: 150_000,
        },
        cachedInputAccounting: 'DISJOINT',
        effectiveFrom: '2026-08-03',
        inactive: false,
        source: 'https://example.test/pricing',
        verifiedAt: '2026-08-03',
      },
    ],
    ...overrides,
  };
}

function asImportError(err: unknown): ProviderRateCardImportError {
  assert.ok(err instanceof ProviderRateCardImportError, `expected ProviderRateCardImportError, got ${String(err)}`);
  return err;
}

test('1. a valid card converts to exact bigint DB rows', () => {
  const result = convertRateCardForImport(makeCard());
  assert.equal(result.rows.length, 1);
  const row = result.rows[0];
  assert.equal(row.provider, 'google');
  assert.equal(row.model, 'gemini-x');
  assert.equal(row.status, 'STABLE');
  assert.equal(row.tier, 'STANDARD');
  assert.equal(row.billingUnit, 'TOKEN');
  assert.equal(row.inputMicrosPerMillion, 1_500_000n);
  assert.equal(row.outputMicrosPerMillion, 7_500_000n);
  assert.equal(row.cachedInputMicrosPerMillion, 150_000n);
  assert.equal(row.cachedOutputMicrosPerMillion, null);
  assert.equal(row.perUnitMicros, null);
  assert.equal(row.audioInputMicrosPerMillion, null);
  assert.equal(row.audioOutputMicrosPerMillion, null);
  assert.equal(row.cachedInputAccounting, 'DISJOINT');
  assert.equal(row.effectiveFrom.getTime(), new Date('2026-08-03T00:00:00Z').getTime());
  assert.equal(row.effectiveTo, null);
  assert.equal(row.inactive, false);
  assert.equal(row.source, 'https://example.test/pricing');
  assert.equal(row.verifiedAt.getTime(), new Date('2026-08-03T00:00:00Z').getTime());
});

test('2. an explicit zero rate converts to 0n (distinct from null)', () => {
  const result = convertRateCardForImport(
    makeCard({
      entries: [
        {
          ...makeCard().entries[0],
          tokenRates: { inputMicrosPerMillion: 0, outputMicrosPerMillion: 7_500_000 },
          cachedInputAccounting: undefined,
        },
      ],
    }),
  );
  assert.equal(result.rows[0].inputMicrosPerMillion, 0n);
  assert.equal(result.rows[0].outputMicrosPerMillion, 7_500_000n);
  assert.equal(result.rows[0].cachedInputMicrosPerMillion, null);
});

test('3. provider is lowercased and model is preserved', () => {
  const result = convertRateCardForImport(
    makeCard({ entries: [{ ...makeCard().entries[0], provider: 'GOOGLE', model: 'Gemini-X' }] }),
  );
  assert.equal(result.rows[0].provider, 'google');
  assert.equal(result.rows[0].model, 'Gemini-X');
});

test('4. engine tiers map to uppercase DB tiers; default is STANDARD', () => {
  for (const [tier, db] of [
    ['standard', 'STANDARD'],
    ['batch', 'BATCH'],
    ['priority', 'PRIORITY'],
    ['fast_mode', 'FAST_MODE'],
  ] as const) {
    const result = convertRateCardForImport(
      makeCard({ entries: [{ ...makeCard().entries[0], tier }] }),
    );
    assert.equal(result.rows[0].tier, db);
  }
  const result = convertRateCardForImport(makeCard({ entries: [{ ...makeCard().entries[0], tier: undefined }] }));
  assert.equal(result.rows[0].tier, 'STANDARD');
});

test('5. non-TOKEN per-unit entries map perUnitMicros to bigint and null the token rates', () => {
  const result = convertRateCardForImport(
    makeCard({
      entries: [
        {
          provider: 'google',
          model: 'image-gen',
          status: 'STABLE',
          tier: 'standard',
          billingUnit: 'IMAGE',
          perUnitMicros: 2_500_000,
          effectiveFrom: '2026-08-03',
          inactive: false,
        },
      ],
    }),
  );
  const row = result.rows[0];
  assert.equal(row.billingUnit, 'IMAGE');
  assert.equal(row.perUnitMicros, 2_500_000n);
  assert.equal(row.inputMicrosPerMillion, null);
  assert.equal(row.outputMicrosPerMillion, null);
  assert.equal(row.cachedInputMicrosPerMillion, null);
});

test('6. modality and TTS rates convert to bigint; tokensPerSecond stays a number', () => {
  const result = convertRateCardForImport(
    makeCard({
      entries: [
        {
          provider: 'google',
          model: 'voice',
          status: 'STABLE',
          tier: 'standard',
          billingUnit: 'TOKEN',
          tokenRates: { inputMicrosPerMillion: 1_000_000 },
          modalityRates: { audioInputMicrosPerMillion: 2_000_000 },
          tts: { audioOutputMicrosPerMillion: 3_000_000, tokensPerSecond: 12.5 },
          effectiveFrom: '2026-08-03',
          inactive: false,
        },
      ],
    }),
  );
  const row = result.rows[0];
  assert.equal(row.audioInputMicrosPerMillion, 2_000_000n);
  assert.equal(row.audioOutputMicrosPerMillion, 3_000_000n);
  assert.equal(row.tokensPerSecond, 12.5);
});

test('7. aliases pass through as a copied array; empty aliases stay null', () => {
  const withAliases = convertRateCardForImport(
    makeCard({ entries: [{ ...makeCard().entries[0], aliases: ['gemini-x-preview', 'gx'] }] }),
  );
  assert.deepEqual(withAliases.rows[0].aliases, ['gemini-x-preview', 'gx']);
  const without = convertRateCardForImport(makeCard());
  assert.equal(without.rows[0].aliases, null);
});

test('8. effectiveTo and verifiedAt convert to UTC-midnight Dates; source passes through', () => {
  const result = convertRateCardForImport(
    makeCard({ entries: [{ ...makeCard().entries[0], effectiveTo: '2026-12-31' }] }),
  );
  assert.equal(result.rows[0].effectiveTo.getTime(), new Date('2026-12-31T00:00:00Z').getTime());
});

test('9. a card that fails the engine validator -> IMPORT_INVALID_CARD', () => {
  for (const bad of [
    makeCard({ entries: [] }),
    makeCard({ entries: [{ ...makeCard().entries[0], tokenRates: undefined }] }),
    makeCard({ entries: [{ ...makeCard().entries[0], billingUnit: 'NOPE' }] }),
    makeCard({ entries: [{ ...makeCard().entries[0], tier: 'nope' }] }),
    makeCard({ entries: [{ ...makeCard().entries[0], effectiveTo: '2026-01-01' }] }),
    makeCard({ entries: [{ ...makeCard().entries[0], tokenRates: { inputMicrosPerMillion: -5 } }] }),
    makeCard({ entries: [{ ...makeCard().entries[0], tokenRates: { inputMicrosPerMillion: 1.5 } }] }),
    makeCard({ provenance: 'OTHER' }),
    makeCard({ currency: 'EUR' }),
  ]) {
    assert.throws(() => convertRateCardForImport(bad), (err: unknown) => {
      const e = asImportError(err);
      assert.equal(e.code, 'IMPORT_INVALID_CARD');
      return true;
    }, `expected IMPORT_INVALID_CARD for ${JSON.stringify(bad)}`);
  }
});

test('10. duplicate (provider, model, tier) identity -> IMPORT_DUPLICATE_IDENTITY even with disjoint windows', () => {
  const entry = makeCard().entries[0];
  assert.throws(
    () =>
      convertRateCardForImport(
        makeCard({
          entries: [
            { ...entry, effectiveFrom: '2026-08-03', effectiveTo: '2026-12-31' },
            { ...entry, model: 'gemini-x', effectiveFrom: '2027-01-01', effectiveTo: '2027-12-31' },
          ],
        }),
      ),
    (err: unknown) => {
      const e = asImportError(err);
      assert.equal(e.code, 'IMPORT_DUPLICATE_IDENTITY');
      return true;
    },
  );
});

test('10b. overlapping windows for one identity are caught by the engine validator first -> IMPORT_INVALID_CARD', () => {
  const entry = makeCard().entries[0];
  assert.throws(
    () =>
      convertRateCardForImport(
        makeCard({ entries: [entry, { ...entry, model: 'gemini-x', effectiveFrom: '2027-01-01' }] }),
      ),
    (err: unknown) => {
      const e = asImportError(err);
      assert.equal(e.code, 'IMPORT_INVALID_CARD');
      return true;
    },
  );
});

test('11. the same identity in different tiers is allowed', () => {
  const entry = makeCard().entries[0];
  const result = convertRateCardForImport(
    makeCard({
      entries: [entry, { ...entry, model: 'gemini-x', tier: 'batch', effectiveFrom: '2026-08-03' }],
    }),
  );
  assert.equal(result.rows.length, 2);
});

test('12. convertEntriesForImport builds a full card with fixed engine constants', () => {
  const entry = makeCard().entries[0];
  const result = convertEntriesForImport([entry], {
    version: 'draft-1',
    source: 'https://example.test/pricing',
    generatedAt: '2026-08-03',
  });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].inputMicrosPerMillion, 1_500_000n);
  assert.equal(result.card.version, 'draft-1');
  assert.deepEqual(result.providers, ['google']);
});

test('13. the converter never mutates its input', () => {
  const card = makeCard();
  const frozen = JSON.parse(JSON.stringify(card));
  convertRateCardForImport(card);
  assert.deepEqual(card, frozen);
});

test('14. a valid card returns the re-normalized engine card and providers', () => {
  const result = convertRateCardForImport(makeCard());
  assert.equal(result.card.entries.length, 1);
  assert.equal(result.card.entries[0].provider, 'google');
  assert.deepEqual(result.providers, ['google']);
  assert.equal(result.card.version, '1.0.0');
});
