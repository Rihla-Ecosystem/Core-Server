import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUSINESS_TOKEN_FEATURE_COSTS,
  BUSINESS_TOKEN_FEATURES,
  getBusinessTokenCost,
  type BusinessTokenFeature,
} from '../src/config/business-token-features.js';

const EXPECTED_COSTS = {
  AI_TRIP_ITINERARY: 10,
  AI_CHAT_QUERY: 2,
  AI_IMAGE_ANALYSIS: 5,
  REAL_TIME_TRANSLATION: 3,
  PERSONALIZED_RECOMMENDATIONS: 5,
  OFFLINE_MAP_DOWNLOAD: 8,
  SMART_BUDGET_PLANNER: 6,
  LOCAL_AUDIO_GUIDE: 12,
  BOOKING_PRICE_COMPARISON: 4,
} as const;

test('1. Catalogue contains exactly the nine feature codes', () => {
  assert.deepEqual(
    Object.keys(BUSINESS_TOKEN_FEATURE_COSTS).sort(),
    Object.keys(EXPECTED_COSTS).sort(),
  );
});

test('2. Configured costs are exactly the approved values', () => {
  assert.deepEqual({ ...BUSINESS_TOKEN_FEATURE_COSTS }, { ...EXPECTED_COSTS });
});

test('3. getBusinessTokenCost() returns the correct value for every feature', () => {
  for (const feature of BUSINESS_TOKEN_FEATURES) {
    assert.equal(getBusinessTokenCost(feature), EXPECTED_COSTS[feature]);
  }
});

test('4. Every configured cost is a positive integer', () => {
  for (const feature of BUSINESS_TOKEN_FEATURES) {
    const cost = getBusinessTokenCost(feature);
    assert.ok(Number.isInteger(cost));
    assert.ok(cost > 0);
  }
});

test('5. BUSINESS_TOKEN_FEATURES contains no duplicates', () => {
  assert.equal(BUSINESS_TOKEN_FEATURES.length, new Set(BUSINESS_TOKEN_FEATURES).size);
});

test('6. The catalogue is not mutated during normal resolver usage', () => {
  const before = { ...BUSINESS_TOKEN_FEATURE_COSTS };

  for (const feature of BUSINESS_TOKEN_FEATURES) {
    getBusinessTokenCost(feature);
  }

  assert.deepEqual({ ...BUSINESS_TOKEN_FEATURE_COSTS }, before);
});

test('7. AI_IMAGE_ANALYSIS exists in the catalogue and costs exactly 5 tokens', () => {
  assert.ok('AI_IMAGE_ANALYSIS' in BUSINESS_TOKEN_FEATURE_COSTS);
  assert.equal(BUSINESS_TOKEN_FEATURE_COSTS.AI_IMAGE_ANALYSIS, 5);
  assert.equal(getBusinessTokenCost('AI_IMAGE_ANALYSIS'), 5);
  assert.ok(BUSINESS_TOKEN_FEATURES.includes('AI_IMAGE_ANALYSIS'));
});

test('8. Existing feature costs remain unchanged', () => {
  for (const feature of BUSINESS_TOKEN_FEATURES) {
    if (feature === 'AI_IMAGE_ANALYSIS') continue;
    assert.equal(BUSINESS_TOKEN_FEATURE_COSTS[feature], EXPECTED_COSTS[feature]);
  }
});

test('9. BusinessTokenFeature type derives from the catalogue', () => {
  const typedFeature: BusinessTokenFeature = 'AI_IMAGE_ANALYSIS';
  assert.equal(typedFeature, 'AI_IMAGE_ANALYSIS');
});
