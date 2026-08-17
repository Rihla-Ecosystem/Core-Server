import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAIExecutionBudget } from '../src/config/ai-execution-budget.js';

test('Core owns and serializes the execution budget for each billed AI feature', () => {
  const chat = getAIExecutionBudget('AI_CHAT_QUERY');
  assert.equal(chat.maxInputTokens, 12_000);
  assert.equal(chat.maxOutputTokens, 1_200);
  assert.equal(chat.maxCurrentMessageTokens, 3_000);
  assert.equal(chat.maxHistoryTokens, 5_500);
  assert.equal(chat.maxHistoryMessages, 10);

  assert.deepEqual(getAIExecutionBudget('AI_IMAGE_ANALYSIS'), {
    maxInputTokens: 3_000, maxOutputTokens: 400, maxImageBytes: 10 * 1024 * 1024, maxImagePixels: 20_000_000,
  });
  assert.deepEqual(getAIExecutionBudget('REAL_TIME_TRANSLATION'), {
    maxInputTokens: 1_000, maxOutputTokens: 1_200, maxAudioBytes: 10 * 1024 * 1024,
    maxAudioDurationSeconds: 60, maxAudioInputTokens: 1_920, maxTtsCharacters: 500, maxTtsOutputTokens: 1_200,
  });
  assert.deepEqual(getAIExecutionBudget('AI_TRIP_ITINERARY'), {
    maxInputTokens: 8_000, maxOutputTokens: 1_000, maxCities: 10, maxInterests: 10, maxDays: 14,
  });
  assert.deepEqual(getAIExecutionBudget('AI_CONTEXT_ANALYZE'), {
    maxInputTokens: 2_000, maxOutputTokens: 600,
  });
});
