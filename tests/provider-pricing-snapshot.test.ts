import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapProviderRateCardSnapshot, ProviderRateCardSnapshotError } from '../src/utils/provider-pricing/snapshot.js';
import { validateRateCard } from '../src/utils/provider-pricing/rate-card.js';
import { priceProviderCall } from '../src/utils/provider-pricing/price-call.js';
import { RATE_CARD_SCHEMA_VERSION } from '../src/types/provider-pricing.js';
import type { PricedShadowCall, RateCardEntry } from '../src/types/provider-pricing.js';

/**
 * A structurally valid DRAFT snapshot row (plain objects, no DB). Monetary
 * rates are BigInt (PostgreSQL BIGINT). Entries use DB enum spellings; the
 * mapper must normalize them to engine domain spellings.
 */
function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'snapshot-1',
    version: '2.0.0',
    status: 'DRAFT',
    schemaVersion: RATE_CARD_SCHEMA_VERSION,
    currency: 'USD',
    storageUnit: 'MICROS',
    engineUnit: 'NANO_USD',
    source: 'https://ai.google.dev/gemini-api/docs/pricing',
    generatedAt: new Date('2026-08-05T00:00:00Z'),
    provenance: 'RESEARCH_SNAPSHOT',
    effectiveFrom: null,
    effectiveTo: null,
    publishedAt: null,
    retiredAt: null,
    createdAt: new Date('2026-08-05T00:00:00Z'),
    updatedAt: new Date('2026-08-05T00:00:00Z'),
    entries: [
      {
        id: 'entry-1',
        snapshotId: 'snapshot-1',
        provider: 'google',
        model: 'gemini-3.6-flash',
        status: 'STABLE',
        tier: 'FAST_MODE',
        billingUnit: 'TOKEN',
        inputMicrosPerMillion: 1_500_000n,
        outputMicrosPerMillion: 7_500_000n,
        cachedInputMicrosPerMillion: 150_000n,
        cachedOutputMicrosPerMillion: null,
        perUnitMicros: null,
        audioInputMicrosPerMillion: 200_000n,
        audioOutputMicrosPerMillion: null,
        tokensPerSecond: null,
        cachedInputAccounting: 'DISJOINT',
        aliases: ['gemini-3.6-flash-prod'],
        effectiveFrom: new Date('2026-08-03T00:00:00Z'),
        effectiveTo: null,
        inactive: false,
        source: 'https://ai.google.dev/gemini-api/docs/pricing',
        verifiedAt: new Date('2026-08-04T00:00:00Z'),
      },
    ],
    ...overrides,
  };
}

/** The single mapped entry of a successfully mapped card. */
function mappedEntry(card: unknown): RateCardEntry {
  const entries = (card as { entries: RateCardEntry[] }).entries;
  assert.equal(entries.length, 1);
  return entries[0];
}

function expectMappingError(
  row: unknown,
  code: string,
  message?: string,
): ProviderRateCardSnapshotError {
  let caught: ProviderRateCardSnapshotError | undefined;
  try {
    mapProviderRateCardSnapshot(row);
  } catch (err) {
    assert.ok(err instanceof ProviderRateCardSnapshotError, `expected ProviderRateCardSnapshotError, got ${String(err)}`);
    caught = err;
  }
  assert.ok(caught, 'expected the mapper to throw');
  assert.equal(caught.code, code, caught.message);
  if (message) assert.ok(caught.message.includes(message), caught.message);
  return caught;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    for (const key of Object.keys(value as object)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Lifecycle fixtures
// ---------------------------------------------------------------------------

function makeActiveRow(): Record<string, unknown> {
  return makeRow({
    status: 'ACTIVE',
    effectiveFrom: new Date('2026-08-06T00:00:00Z'),
    publishedAt: new Date('2026-08-06T10:00:00Z'),
  });
}

function makeRetiredRow(): Record<string, unknown> {
  return makeRow({
    status: 'RETIRED',
    effectiveFrom: new Date('2026-08-06T00:00:00Z'),
    publishedAt: new Date('2026-08-06T10:00:00Z'),
    retiredAt: new Date('2026-12-01T10:00:00Z'),
  });
}

// ---------------------------------------------------------------------------
// Contract tests
// ---------------------------------------------------------------------------

test('1. full valid DRAFT snapshot maps correctly when lifecycle metadata is valid', () => {
  const { card, providers } = mapProviderRateCardSnapshot(makeRow());
  assert.deepEqual(providers, ['google']);
  assert.equal(card.version, '2.0.0');
  assert.equal(card.generatedAt, '2026-08-05');
  assert.equal(card.source, 'https://ai.google.dev/gemini-api/docs/pricing');
  const entry = mappedEntry(card);
  assert.equal(entry.model, 'gemini-3.6-flash');
  assert.equal(entry.tier, 'fast_mode');
  assert.deepEqual(entry.tokenRates, {
    inputMicrosPerMillion: 1_500_000,
    outputMicrosPerMillion: 7_500_000,
    cachedInputMicrosPerMillion: 150_000,
  });
  assert.deepEqual(entry.modalityRates, { audioInputMicrosPerMillion: 200_000 });
  assert.equal(entry.cachedInputAccounting, 'DISJOINT');
  assert.deepEqual(entry.aliases, ['gemini-3.6-flash-prod']);
  assert.equal(entry.effectiveFrom, '2026-08-03');
  assert.equal(entry.verifiedAt, '2026-08-04');
});

test('2. full valid ACTIVE snapshot maps correctly', () => {
  const { card } = mapProviderRateCardSnapshot(makeActiveRow());
  assert.equal(card.version, '2.0.0');
  assert.equal(card.entries.length, 1);
});

test('3. full valid RETIRED snapshot maps correctly', () => {
  const { card } = mapProviderRateCardSnapshot(makeRetiredRow());
  assert.equal(card.version, '2.0.0');
  assert.equal(card.entries.length, 1);
});

test('4. version and metadata are preserved', () => {
  const row = makeRow({ version: '9.1.3', source: 'https://pricing.example.test/v9', provenance: 'RESEARCH_SNAPSHOT' });
  const { card } = mapProviderRateCardSnapshot(row);
  assert.equal(card.version, '9.1.3');
  assert.equal(card.source, 'https://pricing.example.test/v9');
  assert.equal(card.provenance, 'RESEARCH_SNAPSHOT');
  assert.equal(card.generatedAt, '2026-08-05');
});

test('5. DB enum spellings normalize to engine domain spellings', () => {
  for (const [db, domain] of [
    ['STANDARD', 'standard'],
    ['BATCH', 'batch'],
    ['PRIORITY', 'priority'],
    ['FAST_MODE', 'fast_mode'],
  ] as const) {
    const { card } = mapProviderRateCardSnapshot(makeRow({ entries: [{ ...makeRow().entries[0], tier: db }] }));
    assert.equal(mappedEntry(card).tier, domain, `tier ${db} -> ${domain}`);
  }
  const { card } = mapProviderRateCardSnapshot(makeRow({ entries: [{ ...makeRow().entries[0], tier: null }] }));
  assert.equal(mappedEntry(card).tier, 'standard', 'null tier -> standard');
});

test('6. every engine-supported rate is preserved', () => {
  const row = makeRow({
    entries: [
      {
        ...makeRow().entries[0],
        inputMicrosPerMillion: 1_500_000n,
        outputMicrosPerMillion: 7_500_000n,
        cachedInputMicrosPerMillion: 150_000n,
        cachedOutputMicrosPerMillion: 75_000n,
        perUnitMicros: null,
        audioInputMicrosPerMillion: 200_000n,
        audioOutputMicrosPerMillion: 4_000_000n,
        tokensPerSecond: 16.7,
        cachedInputAccounting: 'DISJOINT',
      },
    ],
  });
  const { card } = mapProviderRateCardSnapshot(row);
  const entry = mappedEntry(card);
  assert.deepEqual(entry.tokenRates, {
    inputMicrosPerMillion: 1_500_000,
    outputMicrosPerMillion: 7_500_000,
    cachedInputMicrosPerMillion: 150_000,
    cachedOutputMicrosPerMillion: 75_000,
  });
  assert.deepEqual(entry.modalityRates, { audioInputMicrosPerMillion: 200_000 });
  assert.deepEqual(entry.tts, { audioOutputMicrosPerMillion: 4_000_000, tokensPerSecond: 16.7 });
});

test('7. BigInt zero maps to an explicit engine zero', () => {
  const row = makeRow({
    entries: [
      {
        ...makeRow().entries[0],
        inputMicrosPerMillion: 0n,
        outputMicrosPerMillion: 400_000n,
        cachedInputMicrosPerMillion: null,
        audioInputMicrosPerMillion: null,
        cachedInputAccounting: null,
        aliases: null,
      },
    ],
  });
  const { card } = mapProviderRateCardSnapshot(row);
  assert.equal(mappedEntry(card).tokenRates?.inputMicrosPerMillion, 0);
  assert.equal(mappedEntry(card).tokenRates?.inputMicrosPerMillion === undefined, false);
});

test('8. null rates stay absent in the engine card', () => {
  const row = makeRow({
    entries: [
      {
        ...makeRow().entries[0],
        inputMicrosPerMillion: null,
        outputMicrosPerMillion: null,
        cachedInputMicrosPerMillion: 150_000n,
        cachedOutputMicrosPerMillion: null,
        perUnitMicros: null,
        audioInputMicrosPerMillion: null,
        audioOutputMicrosPerMillion: null,
        tokensPerSecond: null,
        cachedInputAccounting: null,
        aliases: null,
        effectiveTo: new Date('2026-12-31T00:00:00Z'),
        verifiedAt: null,
      },
    ],
  });
  const { card } = mapProviderRateCardSnapshot(row);
  const entry = mappedEntry(card);
  assert.deepEqual(entry.tokenRates, { cachedInputMicrosPerMillion: 150_000 });
  assert.equal(entry.perUnitMicros, undefined);
  assert.equal(entry.modalityRates, undefined);
  assert.equal(entry.tts, undefined);
  assert.equal(entry.cachedInputAccounting, undefined);
  assert.equal(entry.aliases, undefined);
  assert.equal(entry.effectiveTo, '2026-12-31');
  assert.equal(entry.verifiedAt, undefined);
});

test('9. maximum safe BigInt maps without loss', () => {
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  const row = makeRow({
    entries: [
      {
        ...makeRow().entries[0],
        inputMicrosPerMillion: max,
        outputMicrosPerMillion: max,
        cachedInputMicrosPerMillion: null,
        audioInputMicrosPerMillion: null,
        cachedInputAccounting: null,
        aliases: null,
      },
    ],
  });
  const { card } = mapProviderRateCardSnapshot(row);
  assert.equal(mappedEntry(card).tokenRates?.inputMicrosPerMillion, Number.MAX_SAFE_INTEGER);
  assert.equal(mappedEntry(card).tokenRates?.outputMicrosPerMillion, Number.MAX_SAFE_INTEGER);
});

test('10. greater-than-MAX_SAFE_INTEGER BigInt is rejected', () => {
  const tooBig = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
  expectMappingError(
    makeRow({ entries: [{ ...makeRow().entries[0], inputMicrosPerMillion: tooBig }] }),
    'SNAPSHOT_RATE_OUT_OF_ENGINE_RANGE',
  );
});

test('11. negative BigInt is rejected', () => {
  expectMappingError(
    makeRow({ entries: [{ ...makeRow().entries[0], inputMicrosPerMillion: -1n }] }),
    'SNAPSHOT_RATE_OUT_OF_ENGINE_RANGE',
  );
});

test('12. duplicate entry identity is rejected', () => {
  const base = makeRow().entries[0];
  const twin = { ...base, id: 'entry-2' };
  expectMappingError(makeRow({ entries: [base, twin] }), 'SNAPSHOT_DUPLICATE_ENTRY_IDENTITY');
});

test('13. duplicate default-tier identity is rejected', () => {
  const base = { ...makeRow().entries[0], tier: null };
  const twin = { ...base, id: 'entry-2' };
  expectMappingError(makeRow({ entries: [base, twin] }), 'SNAPSHOT_DUPLICATE_ENTRY_IDENTITY');
});

test('14. same provider/model with a different tier is accepted', () => {
  const base = makeRow().entries[0];
  const batch = { ...base, id: 'entry-2', tier: 'BATCH' };
  const { card } = mapProviderRateCardSnapshot(makeRow({ entries: [base, batch] }));
  assert.equal(card.entries.length, 2);
});

test('15. same provider/model/tier with a different billing unit is a duplicate identity', () => {
  // The engine resolves rates by (provider, model, tier); billing unit is not
  // a resolution dimension. Two lines sharing provider/model/tier are a
  // duplicate identity even when their billing units differ.
  const tokenEntry = { ...makeRow().entries[0], tier: 'STANDARD', audioInputMicrosPerMillion: null, aliases: null };
  const imageEntry = {
    ...makeRow().entries[0],
    id: 'entry-2',
    tier: 'STANDARD',
    billingUnit: 'IMAGE',
    inputMicrosPerMillion: null,
    outputMicrosPerMillion: null,
    cachedInputMicrosPerMillion: null,
    perUnitMicros: 2_500_000n,
    audioInputMicrosPerMillion: null,
    audioOutputMicrosPerMillion: null,
    tokensPerSecond: null,
    cachedInputAccounting: null,
    aliases: null,
  };
  expectMappingError(makeRow({ entries: [tokenEntry, imageEntry] }), 'SNAPSHOT_DUPLICATE_ENTRY_IDENTITY');
});

test('16. invalid snapshot lifecycle metadata is rejected', () => {
  expectMappingError(makeRow({ status: 'ARCHIVED' }), 'SNAPSHOT_LIFECYCLE_INVALID');
  expectMappingError(
    makeRow({ status: 'DRAFT', publishedAt: new Date('2026-08-06T10:00:00Z') }),
    'SNAPSHOT_LIFECYCLE_INVALID',
  );
  expectMappingError(makeRow({ status: 'DRAFT', retiredAt: new Date('2026-08-06T10:00:00Z') }), 'SNAPSHOT_LIFECYCLE_INVALID');
  expectMappingError(makeRow({ status: 'ACTIVE', publishedAt: null }), 'SNAPSHOT_LIFECYCLE_INVALID');
  expectMappingError(makeRow({ status: 'ACTIVE', publishedAt: new Date('2026-08-06T10:00:00Z'), effectiveFrom: null }), 'SNAPSHOT_LIFECYCLE_INVALID');
  expectMappingError(makeRow({ status: 'ACTIVE', publishedAt: new Date('2026-08-06T10:00:00Z'), effectiveFrom: new Date('2026-08-06T00:00:00Z'), retiredAt: new Date('2026-08-07T00:00:00Z') }), 'SNAPSHOT_LIFECYCLE_INVALID');
  expectMappingError(makeRow({ status: 'RETIRED', publishedAt: new Date('2026-08-06T10:00:00Z'), effectiveFrom: new Date('2026-08-06T00:00:00Z'), retiredAt: null }), 'SNAPSHOT_LIFECYCLE_INVALID');
  expectMappingError(makeRow({ status: 'RETIRED', publishedAt: new Date('2026-08-06T10:00:00Z'), effectiveFrom: new Date('2026-08-06T00:00:00Z'), retiredAt: new Date('2026-08-01T00:00:00Z') }), 'SNAPSHOT_LIFECYCLE_INVALID');
  expectMappingError(
    makeRow({ status: 'ACTIVE', effectiveFrom: new Date('2026-09-01T00:00:00Z'), effectiveTo: new Date('2026-08-01T00:00:00Z'), publishedAt: new Date('2026-08-06T10:00:00Z') }),
    'SNAPSHOT_LIFECYCLE_INVALID',
  );
});

test('17. invalid entry effective window is rejected', () => {
  expectMappingError(
    makeRow({
      entries: [
        {
          ...makeRow().entries[0],
          effectiveFrom: new Date('2026-08-03T00:00:00Z'),
          effectiveTo: new Date('2026-08-01T00:00:00Z'),
        },
      ],
    }),
    'SNAPSHOT_INVALID_INVARIANT',
  );
});

test('18. input is not mutated', () => {
  const row = deepFreeze(makeRow());
  const { card } = mapProviderRateCardSnapshot(row);
  assert.equal(mappedEntry(card).model, 'gemini-3.6-flash');
  assert.equal(row.entries[0].inputMicrosPerMillion, 1_500_000n);
  assert.deepEqual(row.entries[0].aliases, ['gemini-3.6-flash-prod']);
  assert.equal(row.status, 'DRAFT');
});

test('19. nested arrays such as aliases are copied', () => {
  const row = makeRow();
  const { card } = mapProviderRateCardSnapshot(row);
  (row.entries[0].aliases as string[]).push('mutated-after');
  assert.deepEqual(mappedEntry(card).aliases, ['gemini-3.6-flash-prod']);
});

test('20. unknown provider is accepted structurally and derived into the provider set', () => {
  const { card, providers } = mapProviderRateCardSnapshot(
    makeRow({ entries: [{ ...makeRow().entries[0], provider: 'mystery-vendor', aliases: null }] }),
  );
  assert.deepEqual(providers, ['mystery-vendor']);
  assert.equal(mappedEntry(card).provider, 'mystery-vendor');
});

test('21. no hard-coded provider allowlist exists in the mapper', () => {
  const mapperPath = new URL('../src/utils/provider-pricing/snapshot.ts', import.meta.url);
  const content = readFileSync(mapperPath, 'utf8');
  for (const provider of ['google', 'anthropic', 'openai', 'azure']) {
    assert.ok(!content.includes(provider), `mapper must not hard-code provider "${provider}"`);
  }
});

test('22. no static Rate Card import exists in the mapper', () => {
  const mapperPath = new URL('../src/utils/provider-pricing/snapshot.ts', import.meta.url);
  const content = readFileSync(mapperPath, 'utf8');
  assert.ok(!content.includes('provider-rate-card'), 'mapper must not import the static rate card');
  assert.ok(!content.includes('PROVIDER_RATE_CARD'), 'mapper must not import PROVIDER_RATE_CARD');
  assert.ok(!content.includes('@prisma'), 'mapper must not import Prisma');
});

test('23. no Pricing Engine arithmetic is duplicated in the mapper', () => {
  const mapperPath = new URL('../src/utils/provider-pricing/snapshot.ts', import.meta.url);
  const content = readFileSync(mapperPath, 'utf8');
  assert.ok(!content.includes('arithmetic'), 'mapper must not import pricing arithmetic');
  assert.ok(!content.includes('ceilDiv'), 'mapper must not reimplement ceilDiv');
  assert.ok(!content.includes('tokenComponentCostNanoUsd'), 'mapper must not reimplement token costing');
  assert.ok(!content.includes('perUnitCostNanoUsd'), 'mapper must not reimplement per-unit costing');
});

test('24. equivalent mapped and static test cards produce the same pricing result', () => {
  const source = 'https://example.test/pricing';
  const staticCard = {
    schemaVersion: RATE_CARD_SCHEMA_VERSION,
    currency: 'USD',
    storageUnit: 'MICROS',
    engineUnit: 'NANO_USD',
    version: '9.9.9',
    source,
    generatedAt: '2026-08-05',
    provenance: 'RESEARCH_SNAPSHOT',
    entries: [
      {
        provider: 'google',
        model: 'eq-model',
        status: 'STABLE',
        tier: 'standard',
        billingUnit: 'TOKEN',
        tokenRates: { inputMicrosPerMillion: 1_500_000, outputMicrosPerMillion: 7_500_000, cachedInputMicrosPerMillion: 150_000 },
        cachedInputAccounting: 'DISJOINT',
        effectiveFrom: '2026-08-03',
        inactive: false,
      },
      {
        provider: 'google',
        model: 'eq-model',
        status: 'STABLE',
        tier: 'batch',
        billingUnit: 'TOKEN',
        tokenRates: { inputMicrosPerMillion: 750_000, outputMicrosPerMillion: 3_750_000, cachedInputMicrosPerMillion: 75_000 },
        cachedInputAccounting: 'DISJOINT',
        effectiveFrom: '2026-08-03',
        inactive: false,
      },
    ],
  };
  const { card: staticValidated } = validateRateCard(staticCard);

  const baseEntry = {
    ...makeRow().entries[0],
    model: 'eq-model',
    audioInputMicrosPerMillion: null,
    audioOutputMicrosPerMillion: null,
    tokensPerSecond: null,
    aliases: null,
  };
  const row = makeRow({
    version: '9.9.9',
    entries: [
      { ...baseEntry, id: 'e1', tier: 'STANDARD', inputMicrosPerMillion: 1_500_000n, outputMicrosPerMillion: 7_500_000n, cachedInputMicrosPerMillion: 150_000n },
      { ...baseEntry, id: 'e2', tier: 'BATCH', inputMicrosPerMillion: 750_000n, outputMicrosPerMillion: 3_750_000n, cachedInputMicrosPerMillion: 75_000n },
    ],
  });
  const { card: mapped } = mapProviderRateCardSnapshot(row);

  const call = {
    provider: 'google',
    providerCallId: 'call-1',
    actualModel: 'eq-model',
    inputTokens: 1_000,
    outputTokens: 200,
    cachedInputTokens: 50,
  };
  const fromStatic = priceProviderCall(call, { card: staticValidated, pricingDate: '2026-08-05' });
  const fromMapped = priceProviderCall(call, { card: mapped, pricingDate: '2026-08-05' });
  assert.equal(fromStatic.kind, 'PRICED');
  assert.equal(fromMapped.kind, 'PRICED');
  assert.equal(
    (fromMapped as PricedShadowCall).costNanoUsd,
    (fromStatic as PricedShadowCall).costNanoUsd,
  );
});

test('25. unknown model remains UNPRICED using the existing reason', () => {
  const { card } = mapProviderRateCardSnapshot(makeRow());
  const priced = priceProviderCall(
    { provider: 'google', providerCallId: 'call-1', actualModel: 'not-in-card' },
    { card, pricingDate: '2026-08-05' },
  );
  assert.equal(priced.kind, 'UNPRICED');
  assert.equal(priced.reason, 'ACTUAL_MODEL_NOT_IN_RATECARD');
});

test('26. explicit zero rate is never treated as missing', () => {
  const row = makeRow({
    entries: [
      {
        ...makeRow().entries[0],
        tier: 'STANDARD',
        inputMicrosPerMillion: 0n,
        outputMicrosPerMillion: 400_000n,
        cachedInputMicrosPerMillion: null,
        audioInputMicrosPerMillion: null,
        cachedInputAccounting: null,
        aliases: null,
      },
    ],
  });
  const { card } = mapProviderRateCardSnapshot(row);
  assert.equal(mappedEntry(card).tokenRates?.inputMicrosPerMillion, 0);
  const priced = priceProviderCall(
    { provider: 'google', providerCallId: 'call-1', actualModel: 'gemini-3.6-flash', inputTokens: 10, outputTokens: 1 },
    { card, pricingDate: '2026-08-05' },
  );
  assert.equal(priced.kind, 'PRICED');
  assert.equal((priced as PricedShadowCall).costNanoUsd, 400n);
});

// ---------------------------------------------------------------------------
// Source-scan: no runtime cutover guarantees
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SRC_ROOT = join(REPO_ROOT, 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const SRC_FILES = walk(SRC_ROOT);

test('27. static PROVIDER_RATE_CARD remains the active runtime card', () => {
  const configPath = join(SRC_ROOT, 'config', 'provider-rate-card', 'index.ts');
  const content = readFileSync(configPath, 'utf8');
  assert.ok(content.includes('export const PROVIDER_RATE_CARD'));
  assert.ok(content.includes('export const RATE_CARD_PROVIDERS'));
  const aggregatePath = join(SRC_ROOT, 'utils', 'provider-pricing', 'aggregate.ts');
  const aggregateContent = readFileSync(aggregatePath, 'utf8');
  assert.ok(aggregateContent.includes('PROVIDER_RATE_CARD'), 'aggregate must still default to the static card');
});

test('28. no production runtime file imports the new snapshot contracts or mapper', () => {
  const allowed = new Set([
    join(SRC_ROOT, 'types', 'provider-pricing-snapshot.ts'),
    join(SRC_ROOT, 'utils', 'provider-pricing', 'snapshot.ts'),
    // Phase 2F-B read-only loader/repository legitimately consume the mapper.
    join(SRC_ROOT, 'types', 'provider-rate-card-load.ts'),
    join(SRC_ROOT, 'utils', 'provider-rate-card-date.ts'),
    join(SRC_ROOT, 'repositories', 'provider-rate-card.repository.ts'),
    join(SRC_ROOT, 'services', 'provider-rate-card-loader.service.ts'),
    // Phase 2F-C Admin workflow legitimately consumes the mapper/contracts.
    join(SRC_ROOT, 'types', 'provider-rate-card-admin.ts'),
    join(SRC_ROOT, 'repositories', 'provider-rate-card-admin.repository.ts'),
    join(SRC_ROOT, 'services', 'admin-rate-card.service.ts'),
    // Phase 2F-C pure entry-import mirrors the read-side duplicate-identity rule.
    join(SRC_ROOT, 'utils', 'provider-pricing', 'entry-import.ts'),
    // Phase 2F-C pure semantic-parity comparator for idempotent static imports.
    join(SRC_ROOT, 'utils', 'provider-pricing', 'semantic-parity.ts'),
  ]);
  const offenders: string[] = [];
  for (const file of SRC_FILES) {
    if (allowed.has(file)) continue;
    const content = readFileSync(file, 'utf8');
    if (content.includes('provider-pricing-snapshot') || content.includes('provider-pricing/snapshot')) {
      offenders.push(file.slice(SRC_ROOT.length + 1));
    }
  }
  assert.deepEqual(offenders, [], 'only the contracts, mapper, 2F-B loader/repository, and 2F-C Admin workflow may reference the snapshot schema');
});

test('29. rate-card modules are limited to config/utils/types, the read-only loader/repository, the Phase 2G-B billing resolver, and the Admin workflow', () => {
  const allowed = new Set([
    join(SRC_ROOT, 'repositories', 'provider-rate-card.repository.ts'),
    join(SRC_ROOT, 'services', 'provider-rate-card-loader.service.ts'),
    join(SRC_ROOT, 'services', 'billing-rate-card.service.ts'),
    join(SRC_ROOT, 'repositories', 'provider-rate-card-admin.repository.ts'),
    join(SRC_ROOT, 'services', 'admin-rate-card.service.ts'),
    join(SRC_ROOT, 'controllers', 'admin-rate-card.controller.ts'),
    join(SRC_ROOT, 'routes', 'admin-rate-card.routes.ts'),
    join(SRC_ROOT, 'schemas', 'admin-rate-card.schema.ts'),
  ]);
  const offenders: string[] = [];
  for (const file of SRC_FILES) {
    if (/config|utils|types/.test(file)) continue;
    if (allowed.has(file)) continue;
    if (/rate-?card/i.test(file)) offenders.push(file.slice(SRC_ROOT.length + 1));
  }
  assert.deepEqual(offenders, [], 'rate-card modules may only live under config/utils/types, the read-only loader/repository, the Phase 2G-B billing resolver, or the Admin workflow (no other routes/controllers)');
});

test('30. shadow pricing runtime does not query PostgreSQL for a rate card', () => {
  const shadowPath = join(SRC_ROOT, 'services', 'ai-shadow-pricing.service.ts');
  const shadowContent = readFileSync(shadowPath, 'utf8');
  assert.ok(!shadowContent.includes('prisma'), 'shadow pricing service must not touch Prisma');
  const recomputePath = join(SRC_ROOT, 'services', 'ai-shadow-pricing-recompute.service.ts');
  const recomputeContent = readFileSync(recomputePath, 'utf8');
  assert.ok(!recomputeContent.includes('prisma'), 'recompute service must not touch Prisma');
});
