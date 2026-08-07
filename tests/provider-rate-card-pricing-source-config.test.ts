/**
 * Phase 2F-E config parsing tests for PROVIDER_RATE_CARD_PRICING_SOURCE.
 *
 * The parser is strict: only the three allowed values pass through. Any
 * malformed / empty / unknown value resolves to STATIC (safe disabled) so a
 * typo can never silently enable the database as the pricing source.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseProviderRateCardPricingSource } from '../src/config/env.js';

const TESTS_DIR = fileURLToPath(new URL('.', import.meta.url));
const SRC_ROOT = join(TESTS_DIR, '..', 'src');
const ENV_PATH = join(SRC_ROOT, 'config', 'env.ts');

const ALLOWED = ['STATIC', 'DATABASE_SHADOW', 'DATABASE_PRIMARY'] as const;

test('1. valid values pass through (case-insensitive, trimmed)', () => {
  assert.equal(parseProviderRateCardPricingSource('STATIC'), 'STATIC');
  assert.equal(parseProviderRateCardPricingSource('database_primary'), 'DATABASE_PRIMARY');
  assert.equal(parseProviderRateCardPricingSource('  database_shadow  '), 'DATABASE_SHADOW');
  assert.equal(parseProviderRateCardPricingSource('DAtabase_PRIMARY'), 'DATABASE_PRIMARY');
});

test('2. malformed values resolve to STATIC (never enables DB as primary)', () => {
  for (const bad of [
    'garbage',
    'DATABASE',
    'PRIMARY',
    'database-primary',
    '1',
    '0',
    'true',
    'DATABASE_MAIN',
    'database primary',
  ]) {
    assert.equal(parseProviderRateCardPricingSource(bad), 'STATIC', `value ${JSON.stringify(bad)}`);
  }
});

test('3. non-string / missing values resolve to STATIC', () => {
  assert.equal(parseProviderRateCardPricingSource(undefined), 'STATIC');
  assert.equal(parseProviderRateCardPricingSource(null), 'STATIC');
  assert.equal(parseProviderRateCardPricingSource(123), 'STATIC');
  assert.equal(parseProviderRateCardPricingSource(''), 'STATIC');
});

test('4. env.ts wires the parser into the schema with STATIC default', () => {
  const source = readFileSync(ENV_PATH, 'utf8');
  assert.ok(source.includes('PROVIDER_RATE_CARD_PRICING_SOURCE'));
  assert.ok(source.includes('parseProviderRateCardPricingSource'));
  assert.ok(source.includes('z.enum([\'STATIC\', \'DATABASE_SHADOW\', \'DATABASE_PRIMARY\'])'));
  assert.ok(source.includes('.default(\'STATIC\')'));
});

test('5. env.ts keeps the 2F-D shadow flag for compatibility', () => {
  const source = readFileSync(ENV_PATH, 'utf8');
  assert.ok(source.includes('PROVIDER_RATE_CARD_DB_SHADOW_ENABLED'));
  assert.ok(source.includes('PROVIDER_RATE_CARD_DB_SHADOW_TIMEOUT_MS'));
});

test('6. env.ts reuses the existing DB shadow timeout (no new timeout var)', () => {
  const source = readFileSync(ENV_PATH, 'utf8');
  const occurrences = source.split('PROVIDER_RATE_CARD_DB_SHADOW_TIMEOUT_MS').length - 1;
  assert.equal(occurrences, 1, 'exactly one timeout definition');
  assert.ok(!/PRICING_SOURCE_TIMEOUT|PRIMARY_TIMEOUT/.test(source), 'no duplicate timeout config');
});
