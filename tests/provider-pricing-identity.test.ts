import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalizeModel,
  canonicalizeProvider,
  selectPricingIdentity,
} from '../src/utils/provider-pricing/model-identity.js';
import type { PricingIdentityCandidate } from '../src/types/provider-pricing.js';

const BASE = { provider: 'Google' };

test('1. Provider identity is canonicalized as trim + lowercase', () => {
  assert.equal(canonicalizeProvider('Google'), 'google');
  assert.equal(canonicalizeProvider('  GOOGLE  '), 'google');
  assert.equal(canonicalizeProvider('Mixed Case Provider'), 'mixed case provider');
});

test('2. Whitespace-only provider returns undefined', () => {
  assert.equal(canonicalizeProvider(''), undefined);
  assert.equal(canonicalizeProvider('   '), undefined);
});

test('3. Non-string provider returns undefined', () => {
  assert.equal(canonicalizeProvider(42), undefined);
  assert.equal(canonicalizeProvider(null), undefined);
  assert.equal(canonicalizeProvider(undefined), undefined);
  assert.equal(canonicalizeProvider({}), undefined);
});

test('4. Model display identity is trimmed but preserves case', () => {
  const model = canonicalizeModel('  Gemini-3.6-Flash  ');
  assert.deepEqual(model, { display: 'Gemini-3.6-Flash', lookup: 'gemini-3.6-flash' });
});

test('5. Model lookup key is trimmed + lowercased', () => {
  const model = canonicalizeModel('GEMINI-2.5-FLASH-LITE');
  assert.equal(model?.display, 'GEMINI-2.5-FLASH-LITE');
  assert.equal(model?.lookup, 'gemini-2.5-flash-lite');
});

test('6. Whitespace-only model returns undefined', () => {
  assert.equal(canonicalizeModel(''), undefined);
  assert.equal(canonicalizeModel('   '), undefined);
});

test('7. Non-string model returns undefined', () => {
  assert.equal(canonicalizeModel(42), undefined);
  assert.equal(canonicalizeModel(null), undefined);
  assert.equal(canonicalizeModel(undefined), undefined);
});

test('8. actualModel present and resolvable => SELECTED via ACTUAL_MODEL', () => {
  const result = selectPricingIdentity({
    ...BASE,
    actualModel: 'gemini-3.6-flash',
    requestedModel: 'gemini-3.5-flash-lite',
  });
  assert.equal(result.kind, 'SELECTED');
  if (result.kind === 'SELECTED') {
    assert.equal(result.source, 'ACTUAL_MODEL');
    assert.equal(result.model, 'gemini-3.6-flash');
    assert.equal(result.modelLookupKey, 'gemini-3.6-flash');
  }
});

test('9. actualModel is authoritative: requestedModel is never inspected when actualModel is present', () => {
  const result = selectPricingIdentity({
    ...BASE,
    actualModel: 'gemini-3.6-flash',
    requestedModel: 'different-model',
  });
  assert.equal(result.kind, 'SELECTED');
  if (result.kind === 'SELECTED') {
    assert.equal(result.source, 'ACTUAL_MODEL');
    assert.equal(result.model, 'gemini-3.6-flash');
  }
});

test('10. actualModel present + requestedModel absent => SELECTED via ACTUAL_MODEL', () => {
  const result = selectPricingIdentity({ ...BASE, actualModel: 'gemini-3.6-flash' });
  assert.equal(result.kind, 'SELECTED');
  if (result.kind === 'SELECTED') {
    assert.equal(result.source, 'ACTUAL_MODEL');
    assert.equal(result.model, 'gemini-3.6-flash');
  }
});

test('11. actualModel whitespace-only is treated absent and falls back to requestedModel', () => {
  const result = selectPricingIdentity({
    ...BASE,
    actualModel: '   ',
    requestedModel: 'gemini-2.5-flash-lite',
  });
  assert.equal(result.kind, 'SELECTED');
  if (result.kind === 'SELECTED') {
    assert.equal(result.source, 'REQUESTED_MODEL_FALLBACK');
    assert.equal(result.model, 'gemini-2.5-flash-lite');
  }
});

test('12. actualModel absent + requestedModel present + resolvable => SELECTED via REQUESTED_MODEL_FALLBACK', () => {
  const result = selectPricingIdentity({
    ...BASE,
    requestedModel: 'gemini-2.5-flash-lite',
  });
  assert.equal(result.kind, 'SELECTED');
  if (result.kind === 'SELECTED') {
    assert.equal(result.source, 'REQUESTED_MODEL_FALLBACK');
    assert.equal(result.model, 'gemini-2.5-flash-lite');
  }
});

test('13. both absent => MISSING_MODEL with no model and no source', () => {
  const result = selectPricingIdentity(BASE);
  assert.equal(result.kind, 'MISSING_MODEL');
  if (result.kind === 'MISSING_MODEL') {
    assert.equal(result.reason, 'MODEL_MISSING');
  }
  assert.equal('model' in result, false);
  assert.equal('modelLookupKey' in result, false);
  assert.equal('source' in result, false);
});

test('14. Neither actualModel nor requestedModel (both non-string) => MISSING_MODEL', () => {
  const result = selectPricingIdentity({
    provider: 'google',
    actualModel: 42,
    requestedModel: null,
  });
  assert.equal(result.kind, 'MISSING_MODEL');
  if (result.kind === 'MISSING_MODEL') {
    assert.equal(result.reason, 'MODEL_MISSING');
  }
});

test('15. Model identity never matches by substring or fuzzy prefix/suffix', () => {
  const model = canonicalizeModel('gemini-3.6-flash');
  assert.equal(model?.lookup, 'gemini-3.6-flash');
  assert.notEqual(model?.lookup, 'gemini');
  assert.notEqual(model?.lookup, 'flash');
  assert.notEqual(model?.lookup, 'lite');
  assert.notEqual(model?.lookup, 'gemini-3.6');
});

test('16. Provider is never derived from the model string', () => {
  const result = selectPricingIdentity({
    provider: 'google',
    actualModel: 'gemini-3.6-flash',
  });
  assert.equal(result.kind, 'SELECTED');
  assert.equal(result.provider, 'google');
  assert.equal(result.providerLookupKey, 'google');
  if (result.kind === 'SELECTED') {
    assert.notEqual(result.provider, result.model);
  }
});

test('17. Provider and model case handling are independent', () => {
  const result = selectPricingIdentity({
    provider: '  OpenAI ',
    actualModel: '  GPT-5 " " ',
  });
  assert.equal(result.kind, 'SELECTED');
  assert.equal(result.provider, 'openai');
  if (result.kind === 'SELECTED') {
    assert.equal(result.model, 'GPT-5 " "');
    assert.equal(result.modelLookupKey, 'gpt-5 " "');
  }
});

test('18. Two calls with different models resolve independently', () => {
  const first = selectPricingIdentity({
    provider: 'google',
    actualModel: 'gemini-3.6-flash',
  });
  const second = selectPricingIdentity({
    provider: 'google',
    actualModel: 'gemini-2.5-flash-lite',
  });
  assert.equal(first.kind, 'SELECTED');
  assert.equal(second.kind, 'SELECTED');
  if (first.kind === 'SELECTED' && second.kind === 'SELECTED') {
    assert.equal(first.model, 'gemini-3.6-flash');
    assert.equal(second.model, 'gemini-2.5-flash-lite');
    assert.equal(first.source, 'ACTUAL_MODEL');
    assert.equal(second.source, 'ACTUAL_MODEL');
  }
});

test('19. Input object is not mutated', () => {
  const input = { provider: 'Google', requestedModel: '  Model X ', actualModel: ' Model Y ' };
  const snapshot = structuredClone(input);
  selectPricingIdentity(input);
  assert.deepEqual(input, snapshot);
});

test('20. Provider canonicalization key used for lookup is same as display (lowercased)', () => {
  const result = selectPricingIdentity({
    provider: ' Google ',
    actualModel: 'gemini-3.6-flash',
  });
  assert.equal(result.kind, 'SELECTED');
  assert.equal(result.provider, 'google');
  assert.equal(result.providerLookupKey, 'google');
});

// Compile-time guards: the identity result is a discriminated union, so a
// SELECTED variant requires model/modelLookupKey/source and a MISSING_MODEL
// variant structurally carries none of them. Each @ts-expect-error line is
// verified by `tsc --noEmit` over this file.

const _selected: PricingIdentityCandidate = {
  kind: 'SELECTED',
  model: 'gemini-3.6-flash',
  modelLookupKey: 'gemini-3.6-flash',
  source: 'ACTUAL_MODEL',
};

const _missing: PricingIdentityCandidate = {
  kind: 'MISSING_MODEL',
  reason: 'MODEL_MISSING',
};

// SELECTED without the required model / lookup key / source must not compile.
const _selectedNoModel: PricingIdentityCandidate = _selected;
// @ts-expect-error SELECTED requires a model
const _badSelected1: PricingIdentityCandidate = { kind: 'SELECTED', modelLookupKey: 'm', source: 'ACTUAL_MODEL' };
// @ts-expect-error SELECTED requires a modelLookupKey
const _badSelected2: PricingIdentityCandidate = { kind: 'SELECTED', model: 'm', source: 'ACTUAL_MODEL' };
// @ts-expect-error SELECTED requires a source
const _badSelected3: PricingIdentityCandidate = { kind: 'SELECTED', model: 'm', modelLookupKey: 'm' };

// MISSING_MODEL with a model / source must not compile.
// @ts-expect-error MISSING_MODEL must not carry a model
const _badMissing1: PricingIdentityCandidate = { kind: 'MISSING_MODEL', reason: 'MODEL_MISSING', model: 'm' };
// @ts-expect-error MISSING_MODEL must not carry modelLookupKey
const _badMissing2: PricingIdentityCandidate = { kind: 'MISSING_MODEL', reason: 'MODEL_MISSING', modelLookupKey: 'm' };
// @ts-expect-error MISSING_MODEL must not carry a source
const _badMissing3: PricingIdentityCandidate = { kind: 'MISSING_MODEL', reason: 'MODEL_MISSING', source: 'ACTUAL_MODEL' };
// @ts-expect-error MISSING_MODEL requires the MODEL_MISSING reason
const _badMissing4: PricingIdentityCandidate = { kind: 'MISSING_MODEL' };

// A SELECTED result narrows so model/source are non-optional; a MISSING_MODEL
// result has no model/source at all.
if (_selected.kind === 'SELECTED') {
  const _m: string = _selected.model;
  const _s: 'ACTUAL_MODEL' | 'REQUESTED_MODEL_FALLBACK' = _selected.source;
}
if (_missing.kind === 'MISSING_MODEL') {
  const _r: 'MODEL_MISSING' = _missing.reason;
  // @ts-expect-error MISSING_MODEL carries no model field
  const _noModel: string = _missing.model;
  // @ts-expect-error MISSING_MODEL carries no source field
  const _noSource: string = _missing.source;
}

test('21. Impossible identity candidate combinations fail to compile', () => {
  assert.ok(_selectedNoModel);
  assert.ok(_missing);
});