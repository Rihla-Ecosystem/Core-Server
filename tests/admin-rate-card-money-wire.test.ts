/**
 * Phase 2F-C closure: Admin money wire contract tests (no database).
 *
 * Proves the HTTP wire contract for every monetary field is a strict
 * non-negative integer STRING that converts DIRECTLY to an exact `bigint`
 * (never through `Number`): JSON numbers, negative strings, decimals, exponent
 * notation, whitespace-padded values, empty strings, and values beyond
 * PostgreSQL BIGINT are all rejected; "0" becomes 0n, absent/null money stays
 * null, and values above Number.MAX_SAFE_INTEGER remain exact.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rateCardMoneyStringSchema,
  adminRateCardImportBodySchema,
} from '../src/schemas/admin-rate-card.schema.js';
import {
  convertAdminEntriesForImport,
  ProviderRateCardImportError,
} from '../src/utils/provider-pricing/entry-import.js';

const META = { version: '1.0.0', source: 'https://example.test/pricing', generatedAt: '2026-08-03' };

function entry(money: unknown): unknown {
  return {
    provider: 'google',
    model: 'gemini-x',
    status: 'STABLE',
    tier: 'standard',
    billingUnit: 'TOKEN',
    tokenRates: {
      inputMicrosPerMillion: money,
      outputMicrosPerMillion: '7500000',
    },
    effectiveFrom: '2026-08-03',
    inactive: false,
    adminReason: 'testing',
  };
}

test('1. wire money schema accepts canonical non-negative integer strings', () => {
  for (const ok of ['0', '1500000', '9000000000000000000', '9223372036854775807']) {
    assert.equal(rateCardMoneyStringSchema.safeParse(ok).success, true, `expected ${ok} to be accepted`);
  }
});

test('2. wire money schema rejects JSON numbers', () => {
  for (const bad of [0, 1500000, 9000000000000000000, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
    assert.equal(rateCardMoneyStringSchema.safeParse(bad).success, false, `expected ${String(bad)} to be rejected`);
  }
});

test('3. wire money schema rejects negative/decimal/exponent/whitespace/empty/overflow strings', () => {
  for (const bad of ['-1', '1.5', '1e3', '1E3', ' 1', '1 ', '', '+1', '-0', '1_000', '9223372036854775808']) {
    assert.equal(rateCardMoneyStringSchema.safeParse(bad).success, false, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test('4. the full import body schema accepts string money and rejects numeric money (400 on the wire)', () => {
  const validBody = { source: 's', generatedAt: '2026-08-03', entries: [entry('1500000')] };
  assert.equal(adminRateCardImportBodySchema.safeParse(validBody).success, true);
  const numericBody = { source: 's', generatedAt: '2026-08-03', entries: [entry(1500000)] };
  const parsed = adminRateCardImportBodySchema.safeParse(numericBody);
  assert.equal(parsed.success, false, 'numeric JSON money must be rejected by the wire schema');
  const overflowBody = { source: 's', generatedAt: '2026-08-03', entries: [entry('9223372036854775808')] };
  assert.equal(adminRateCardImportBodySchema.safeParse(overflowBody).success, false);
});

test('5. "0" converts directly to 0n (never through Number)', () => {
  const { rows } = convertAdminEntriesForImport([entry('0')], META);
  assert.equal(rows[0].inputMicrosPerMillion, 0n);
});

test('6. absent and explicit-null money both remain null', () => {
  const absent = convertAdminEntriesForImport([{ ...entry('1'), tokenRates: { outputMicrosPerMillion: '1' } }], META);
  assert.equal(absent.rows[0].inputMicrosPerMillion, null);
  const nullish = convertAdminEntriesForImport([{ ...entry('1'), tokenRates: { inputMicrosPerMillion: null, outputMicrosPerMillion: '1' } }], META);
  assert.equal(nullish.rows[0].inputMicrosPerMillion, null);
});

test('7. values above Number.MAX_SAFE_INTEGER are rejected with IMPORT_INVALID_CARD', () => {
  const big = '9000000000000000000';
  assert.throws(
    () => convertAdminEntriesForImport([entry(big)], META),
    (err: unknown) => {
      assert.ok(err instanceof ProviderRateCardImportError);
      assert.equal(err.code, 'IMPORT_INVALID_CARD');
      return true;
    },
  );
});

test('8. non-negative safe-integer numbers still convert for internal callers (no wire)', () => {
  const { rows } = convertAdminEntriesForImport([entry(1500000)], META);
  assert.equal(rows[0].inputMicrosPerMillion, 1_500_000n);
});

test('9. malformed money strings -> IMPORT_INVALID_CARD', () => {
  for (const bad of ['-1', '1.5', '1e3', ' 1', '1 ', '', '+1', '9223372036854775808']) {
    assert.throws(
      () => convertAdminEntriesForImport([entry(bad)], META),
      (err: unknown) => {
        assert.ok(err instanceof ProviderRateCardImportError, `expected ProviderRateCardImportError, got ${String(err)}`);
        assert.equal(err.code, 'IMPORT_INVALID_CARD');
        return true;
      },
      `expected IMPORT_INVALID_CARD for money ${JSON.stringify(bad)}`,
    );
  }
});

test('10. unsafe (non-safe-integer) JSON numbers -> IMPORT_INVALID_CARD', () => {
  for (const bad of [Number.MAX_SAFE_INTEGER + 1, -5, 1.5]) {
    assert.throws(
      () => convertAdminEntriesForImport([entry(bad)], META),
      (err: unknown) => {
        assert.ok(err instanceof ProviderRateCardImportError);
        assert.equal(err.code, 'IMPORT_INVALID_CARD');
        return true;
      },
      `expected IMPORT_INVALID_CARD for money ${String(bad)}`,
    );
  }
});

test('11. the converter never mutates its input', () => {
  const raw = entry('1500000');
  const frozen = JSON.parse(JSON.stringify(raw));
  convertAdminEntriesForImport([raw], META);
  assert.deepEqual(raw, frozen);
});
