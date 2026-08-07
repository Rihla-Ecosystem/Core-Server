import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  recomputePreview,
  toHistoricalPricingRow,
  classifyRecomputeRow,
  type HistoricalPricingRow,
  type RecomputeRepository,
} from '../src/services/ai-shadow-pricing-recompute.service.js';

const TESTS_DIR = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(TESTS_DIR, '..');
const SRC_ROOT = join(REPO_ROOT, 'src');

function makeRow(overrides?: Partial<HistoricalPricingRow>): HistoricalPricingRow {
  return {
    id: 'row-1',
    source: 'chat',
    createdAt: new Date('2026-08-03T10:00:00.000Z'),
    provider: 'google',
    actualModel: 'gemini-3.6-flash',
    requestedModel: 'gemini-3.6-flash',
    inputTokens: 1000,
    outputTokens: 500,
    recomputeSupported: true,
    ...overrides,
  };
}

function fakeRepository(rows: HistoricalPricingRow[]) {
  const calls: Array<{ from: Date; to: Date; limit: number }> = [];
  const writes: string[] = [];
  const repo: RecomputeRepository = {
    fetchRows: async (opts) => {
      calls.push({ ...opts });
      return rows;
    },
  };
  return {
    repo,
    calls,
    writes,
    write: () => {
      throw new Error('write must never be called');
    },
  };
}

function assertNoBigint(value: unknown, path = 'root'): void {
  if (typeof value === 'bigint') assert.fail(`bigint at ${path}`);
  if (Array.isArray(value)) value.forEach((v, i) => assertNoBigint(v, `${path}[${i}]`));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertNoBigint(v, `${path}.${k}`);
  }
}

test('1. repository receives bounded from/to/limit', async () => {
  const fake = fakeRepository([]);
  await recomputePreview({ repository: fake.repo }, {
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-08-31T23:59:59.999Z',
    limit: 900,
  });
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.calls[0].from, new Date('2026-08-01T00:00:00.000Z'));
  assert.deepEqual(fake.calls[0].to, new Date('2026-08-31T23:59:59.999Z'));
  assert.equal(fake.calls[0].limit, 500);
});

test('2. empty repository result', async () => {
  const fake = fakeRepository([]);
  const result = await recomputePreview({ repository: fake.repo }, {
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-08-31T23:59:59.999Z',
  });
  assert.equal(result.mode, 'READ_ONLY_PREVIEW');
  assert.equal(result.requestAggregationAvailable, false);
  assert.equal(result.rows.scanned, 0);
  assert.equal(result.rows.recomputedPriced, 0);
  assert.equal(result.rows.recomputedUnpriced, 0);
  assert.equal(result.rows.skipped, 0);
  assert.equal(result.pricedProviderCost.nanoUsd, '0');
  assert.ok(result.warnings.length >= 4);
});

test('3. missing provider identity is skipped', async () => {
  const fake = fakeRepository([
    makeRow({ provider: null, recomputeSupported: true }),
  ]);
  const result = await recomputePreview({ repository: fake.repo }, {
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-08-31T23:59:59.999Z',
  });
  assert.equal(result.rows.scanned, 1);
  assert.equal(result.rows.skipped, 1);
  assert.equal(result.rows.recomputedPriced, 0);
  assert.equal(result.skipReasons['SKIPPED_MISSING_PROVIDER_IDENTITY'], 1);
});

test('4. missing model identity is skipped', async () => {
  const fake = fakeRepository([
    makeRow({ provider: 'google', actualModel: null, requestedModel: null, recomputeSupported: true }),
  ]);
  const result = await recomputePreview({ repository: fake.repo }, {
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-08-31T23:59:59.999Z',
  });
  assert.equal(result.rows.skipped, 1);
  assert.equal(result.skipReasons['SKIPPED_MISSING_MODEL_IDENTITY'], 1);
});

test('5. missing usage is skipped', async () => {
  const fake = fakeRepository([
    makeRow({ inputTokens: null, outputTokens: null, recomputeSupported: true }),
  ]);
  const result = await recomputePreview({ repository: fake.repo }, {
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-08-31T23:59:59.999Z',
  });
  assert.equal(result.rows.skipped, 1);
  assert.equal(result.skipReasons['SKIPPED_MISSING_USAGE'], 1);
});

test('6. invalid usage is skipped', async () => {
  const fake = fakeRepository([
    makeRow({ inputTokens: -5, recomputeSupported: true }),
  ]);
  const result = await recomputePreview({ repository: fake.repo }, {
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-08-31T23:59:59.999Z',
  });
  assert.equal(result.rows.skipped, 1);
  assert.equal(result.skipReasons['SKIPPED_INVALID_USAGE'], 1);
});

test('7. no provider is inferred from Gemini model name', async () => {
  const fake = fakeRepository([
    makeRow({ provider: null, actualModel: 'gemini-3.6-flash', requestedModel: 'gemini-3.6-flash', recomputeSupported: true }),
  ]);
  const result = await recomputePreview({ repository: fake.repo }, {
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-08-31T23:59:59.999Z',
  });
  assert.equal(result.rows.recomputedPriced, 0);
  assert.equal(result.skipReasons['SKIPPED_MISSING_PROVIDER_IDENTITY'], 1);
});

test('8. no model is assigned to both actualModel and requestedModel by guessing', () => {
  // The production mapper never assigns the collapsed legacy model to either field.
  const mapped = toHistoricalPricingRow({
    id: 'legacy-1',
    source: 'chat',
    createdAt: new Date('2026-08-03T10:00:00.000Z'),
    model: 'gemini-3.6-flash',
    inputTokens: 100,
    outputTokens: 50,
  });
  assert.equal(mapped.actualModel, null);
  assert.equal(mapped.requestedModel, null);
  assert.equal(mapped.recomputeSupported, false);
  assert.equal(classifyRecomputeRow(mapped), 'SKIPPED_UNSUPPORTED_LEGACY_SHAPE');

  // A supported row with provider but no authoritative model is not guessed.
  assert.equal(
    classifyRecomputeRow(makeRow({ provider: 'google', actualModel: null, requestedModel: null, recomputeSupported: true })),
    'SKIPPED_MISSING_MODEL_IDENTITY',
  );
});

test('9. complete authoritative row is recomputed (provider/model/usage all authoritative)', async () => {
  const fake = fakeRepository([makeRow()]);
  const result = await recomputePreview({ repository: fake.repo }, {
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-08-31T23:59:59.999Z',
  });
  assert.equal(result.rows.scanned, 1);
  assert.equal(result.rows.recomputedPriced, 1);
  assert.equal(result.rows.skipped, 0);
  assert.equal(result.skipReasons['SKIPPED_MISSING_PROVIDER_IDENTITY'], 0);
});

test('10. priced recompute aggregates exact cost', async () => {
  const fake = fakeRepository([makeRow()]);
  const result = await recomputePreview({ repository: fake.repo }, {
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-08-31T23:59:59.999Z',
  });
  // gemini-3.6-flash standard: input 1,500,000 micros/M, output 7,500,000 micros/M.
  // input 1000 -> 1,500,000 nUSD; output 500 -> 3,750,000 nUSD; total 5,250,000.
  assert.equal(result.pricedProviderCost.nanoUsd, '5250000');
  assert.equal(result.pricedProviderCost.usd, '0.005250000');
  assert.equal(result.unpricedReasons['ACTUAL_MODEL_NOT_IN_RATECARD'], undefined);
});

test('11. unpriced recompute remains unpriced', async () => {
  const fake = fakeRepository([
    makeRow({ actualModel: 'gemini-unpriced-model', requestedModel: 'gemini-unpriced-model' }),
  ]);
  const result = await recomputePreview({ repository: fake.repo }, {
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-08-31T23:59:59.999Z',
  });
  assert.equal(result.rows.recomputedPriced, 0);
  assert.equal(result.rows.recomputedUnpriced, 1);
  assert.equal(result.pricedProviderCost.nanoUsd, '0');
  assert.ok(result.unpricedReasons['ACTUAL_MODEL_NOT_IN_RATECARD'] >= 1);
});

test('12. skipped rows do not contribute cost', async () => {
  const fake = fakeRepository([
    makeRow(), // priced
    makeRow({ id: 'skip-1', provider: null, recomputeSupported: true }), // skipped
    makeRow({ id: 'skip-2', actualModel: null, requestedModel: null, recomputeSupported: true }), // skipped
  ]);
  const result = await recomputePreview({ repository: fake.repo }, {
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-08-31T23:59:59.999Z',
  });
  assert.equal(result.rows.scanned, 3);
  assert.equal(result.rows.recomputedPriced, 1);
  assert.equal(result.rows.skipped, 2);
  assert.equal(result.pricedProviderCost.nanoUsd, '5250000');
});

test('13. no database write dependency exists or is called', async () => {
  const fake = fakeRepository([makeRow()]);
  await recomputePreview({ repository: fake.repo }, {
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-08-31T23:59:59.999Z',
  });
  assert.equal(fake.calls.length, 1);
  const source = readFileSync(join(SRC_ROOT, 'services/ai-shadow-pricing-recompute.service.ts'), 'utf8');
  assert.ok(!source.includes('create('));
  assert.ok(!source.includes('update('));
  assert.ok(!source.includes('upsert('));
  assert.ok(!source.includes('.delete('));
});

test('14. no Wallet service is imported or called', () => {
  for (const file of [
    'services/ai-shadow-pricing-recompute.service.ts',
    'services/ai-shadow-pricing-metrics.service.ts',
    'services/ai-shadow-pricing-observation-query.service.ts',
    'controllers/ai-shadow-pricing-admin.controller.ts',
    'schemas/admin-shadow-pricing.schema.ts',
  ]) {
    const source = readFileSync(join(SRC_ROOT, file), 'utf8');
    const importLines = source.split('\n').filter((l) => l.includes('import ')).join('\n');
    assert.ok(!/wallet|Wallet/i.test(importLines), `${file} imports wallet`);
  }
});

test('15. no durable-billing service is imported or called', () => {
  for (const file of [
    'services/ai-shadow-pricing-recompute.service.ts',
    'controllers/ai-shadow-pricing-admin.controller.ts',
  ]) {
    const source = readFileSync(join(SRC_ROOT, file), 'utf8');
    const importLines = source.split('\n').filter((l) => l.includes('import ')).join('\n');
    assert.ok(!/TokenTransaction|TokenReservation/i.test(importLines), `${file} imports TokenTransaction/TokenReservation`);
    assert.ok(!/billing|Billing/i.test(importLines), `${file} imports billing`);
  }
});

test('16. requestAggregationAvailable is false without a grouping key', async () => {
  const fake = fakeRepository([makeRow()]);
  const result = await recomputePreview({ repository: fake.repo }, {
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-08-31T23:59:59.999Z',
  });
  assert.equal(result.requestAggregationAvailable, false);
});

test('17. no conversation/timestamp heuristic grouping', () => {
  // The service never groups; it processes rows independently. Verify no
  // grouping logic exists in the code (comments are ignored).
  const source = readFileSync(join(SRC_ROOT, 'services/ai-shadow-pricing-recompute.service.ts'), 'utf8');
  const codeOnly = source
    .split('\n')
    .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*'))
    .join('\n');
  assert.ok(!codeOnly.includes('groupBy'));
  assert.ok(!codeOnly.includes('conversationId'));
  assert.ok(!codeOnly.includes('operationId'));
  assert.ok(!codeOnly.includes('.group('));
});

test('18. money remains exact strings', async () => {
  const fake = fakeRepository([makeRow()]);
  const result = await recomputePreview({ repository: fake.repo }, {
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-08-31T23:59:59.999Z',
  });
  assert.equal(typeof result.pricedProviderCost.nanoUsd, 'string');
  assert.equal(typeof result.pricedProviderCost.microUsd, 'string');
  assert.equal(typeof result.pricedProviderCost.usd, 'string');
  assert.match(result.pricedProviderCost.usd, /^\d+\.\d{9}$/);
});

test('19. preview warnings are present', async () => {
  const fake = fakeRepository([makeRow()]);
  const result = await recomputePreview({ repository: fake.repo }, {
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-08-31T23:59:59.999Z',
  });
  const joined = result.warnings.join(' ');
  assert.ok(joined.includes('read-only preview'));
  assert.ok(joined.includes('no database data was changed'));
  assert.ok(joined.includes('excludes unresolved/skipped historical usage'));
  assert.ok(joined.includes('request aggregation is unavailable'));
  assert.ok(joined.includes('no provider or model identity was inferred'));
});

test('20. legacy fixed-price/cost fields are ignored', async () => {
  const fake = fakeRepository([makeRow()]);
  const result = await recomputePreview({ repository: fake.repo }, {
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-08-31T23:59:59.999Z',
  });
  // The result has no cost/cents field, and the mapper input contract never
  // includes cost/computeAiCost.
  assert.ok(!('cost' in result));
  const mapped = toHistoricalPricingRow({
    id: 'x', source: 'chat', createdAt: new Date(), model: null,
    inputTokens: 0, outputTokens: 0,
  });
  assert.ok(!('cost' in mapped));
});

test('21. no raw bigint in response', async () => {
  const fake = fakeRepository([makeRow(), makeRow({ id: 'r2', provider: null, recomputeSupported: true })]);
  const result = await recomputePreview({ repository: fake.repo }, {
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-08-31T23:59:59.999Z',
  });
  JSON.stringify(result);
  assertNoBigint(result);
});

test('22. input rows are not mutated', async () => {
  const rows = [makeRow(), makeRow({ id: 'r2', provider: null, recomputeSupported: true })];
  const before = JSON.stringify(rows);
  const fake = fakeRepository(rows);
  await recomputePreview({ repository: fake.repo }, {
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-08-31T23:59:59.999Z',
  });
  assert.equal(JSON.stringify(rows), before);
});
