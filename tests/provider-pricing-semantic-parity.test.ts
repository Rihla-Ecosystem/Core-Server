/**
 * Phase 2F-C pure semantic-parity comparator tests (no database).
 *
 * Proves the comparator's content-equality contract: DB-generated fields are
 * ignored, entry order is irrelevant, NULL vs explicit zero stays distinct,
 * and only genuine rate-card content differences produce differences.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  ProviderRateCardSnapshotRow,
  ProviderRateCardEntryRow,
} from '../src/types/provider-pricing-snapshot.js';
import { semanticParityDifferences, semanticParityEqual } from '../src/utils/provider-pricing/semantic-parity.js';

function entry(overrides: Partial<ProviderRateCardEntryRow> = {}): ProviderRateCardEntryRow {
  return {
    id: 'e1',
    snapshotId: 's1',
    provider: 'google',
    model: 'gemini-x',
    status: 'STABLE',
    tier: 'STANDARD',
    billingUnit: 'TOKEN',
    inputMicrosPerMillion: 1_500_000n,
    outputMicrosPerMillion: 7_500_000n,
    cachedInputMicrosPerMillion: 150_000n,
    cachedOutputMicrosPerMillion: null,
    perUnitMicros: null,
    audioInputMicrosPerMillion: null,
    audioOutputMicrosPerMillion: null,
    tokensPerSecond: null,
    cachedInputAccounting: 'DISJOINT',
    aliases: null,
    effectiveFrom: new Date('2026-08-03T00:00:00Z'),
    effectiveTo: null,
    inactive: false,
    source: null,
    verifiedAt: new Date('2026-08-03T00:00:00Z'),
    ...overrides,
  };
}

function row(overrides: Partial<ProviderRateCardSnapshotRow> = {}): ProviderRateCardSnapshotRow {
  return {
    id: 'snap-a',
    version: '1.0.0',
    status: 'DRAFT',
    schemaVersion: 1,
    currency: 'USD',
    storageUnit: 'MICROS',
    engineUnit: 'NANO_USD',
    source: 'https://example.test/pricing',
    generatedAt: new Date('2026-08-03T00:00:00Z'),
    provenance: 'RESEARCH_SNAPSHOT',
    effectiveFrom: null,
    effectiveTo: null,
    publishedAt: null,
    retiredAt: null,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-02T00:00:00Z'),
    entries: [entry()],
    ...overrides,
  };
}

test('1. identical content with different DB-generated fields compares equal', () => {
  const a = row();
  const b = row({
    id: 'snap-b',
    createdAt: new Date('2026-08-04T00:00:00Z'),
    updatedAt: new Date('2026-08-05T00:00:00Z'),
    entries: [entry({ id: 'e-other', snapshotId: 'snap-b' })],
  });
  assert.equal(semanticParityEqual(a, b), true);
  assert.deepEqual(semanticParityDifferences(a, b), []);
});

test('2. entry order is irrelevant (order-insensitive)', () => {
  const e2 = entry({ model: 'gemini-y', tier: 'BATCH' });
  const e3 = entry({ model: 'gemini-z', tier: 'PRIORITY' });
  const a = row({ entries: [entry(), e2, e3] });
  const b = row({ entries: [e3, entry(), e2] });
  assert.equal(semanticParityEqual(a, b), true);
});

test('3. NULL vs explicit zero rate stays distinct', () => {
  const a = row({ entries: [entry({ cachedOutputMicrosPerMillion: null })] });
  const b = row({ entries: [entry({ cachedOutputMicrosPerMillion: 0n })] });
  assert.equal(semanticParityEqual(a, b), false);
  assert.ok(semanticParityDifferences(a, b).some((d) => d.includes('cachedOutputMicrosPerMillion')));
});

test('4. version/source/generatedAt/currency differences are detected', () => {
  const base = row();
  for (const diff of [
    row({ version: '2.0.0' }),
    row({ source: 'https://other.test/pricing' }),
    row({ generatedAt: new Date('2026-08-04T00:00:00Z') }),
    row({ currency: 'EUR' }),
    row({ status: 'ACTIVE', publishedAt: new Date('2026-08-03T00:00:00Z'), effectiveFrom: new Date('2026-08-03T00:00:00Z') }),
  ]) {
    assert.equal(semanticParityEqual(base, diff), false, 'expected a difference');
  }
});

test('5. entry rate differences are detected', () => {
  const a = row({ entries: [entry({ inputMicrosPerMillion: 1_500_000n })] });
  const b = row({ entries: [entry({ inputMicrosPerMillion: 2_000_000n })] });
  assert.equal(semanticParityEqual(a, b), false);
});

test('6. alias order is irrelevant (sorted comparison)', () => {
  const a = row({ entries: [entry({ aliases: ['alpha', 'beta'] })] });
  const b = row({ entries: [entry({ aliases: ['beta', 'alpha'] })] });
  assert.equal(semanticParityEqual(a, b), true);
});

test('7. lifecycle timestamps are ignored by default and compared when requested', () => {
  const published = new Date('2026-08-03T00:00:00Z');
  const a = row({
    status: 'ACTIVE',
    publishedAt: published,
    retiredAt: null,
    effectiveFrom: new Date('2026-08-03T00:00:00Z'),
  });
  const b = row({
    status: 'ACTIVE',
    publishedAt: new Date('2026-09-01T00:00:00Z'),
    retiredAt: null,
    effectiveFrom: new Date('2026-08-03T00:00:00Z'),
  });
  assert.equal(semanticParityEqual(a, b), true, 'timestamps ignored by default');
  assert.equal(semanticParityEqual(a, b, { compareLifecycleTimestamps: true }), false);
});

test('8. null tier equals the STANDARD DB default', () => {
  const a = row({ entries: [entry({ tier: null })] });
  const b = row({ entries: [entry({ tier: 'STANDARD' })] });
  assert.equal(semanticParityEqual(a, b), true);
});

test('9. entry window/status/inactive/verifiedAt differences are detected', () => {
  const base = row({ entries: [entry()] });
  const cases: Array<[string, ProviderRateCardEntryRow]> = [
    ['effectiveFrom', entry({ effectiveFrom: new Date('2026-09-01T00:00:00Z') })],
    ['effectiveTo', entry({ effectiveTo: new Date('2026-12-31T00:00:00Z') })],
    ['status', entry({ status: 'PREVIEW' })],
    ['inactive', entry({ inactive: true })],
    ['verifiedAt', entry({ verifiedAt: null })],
    ['billingUnit', entry({ billingUnit: 'SECOND' })],
  ];
  for (const [label, e] of cases) {
    assert.equal(semanticParityEqual(base, row({ entries: [e] })), false, `expected a difference for ${label}`);
  }
});

test('10. snapshot-level business windows are compared', () => {
  const a = row({ effectiveFrom: new Date('2026-08-03T00:00:00Z') });
  const b = row({ effectiveFrom: new Date('2026-09-01T00:00:00Z') });
  assert.equal(semanticParityEqual(a, b), false);
});
