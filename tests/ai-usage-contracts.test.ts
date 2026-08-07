import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAIProviderUsage, normalizeProviderCalls } from '../src/utils/ai-usage.js';
import type {
  AIChatHistoryMessage,
  AIChatRequest,
  AIChatResponse,
  AIProviderUsage,
  ProviderCallUsage,
} from '../src/types/ai.js';

const BASE_USAGE = {
  provider: 'test-provider',
  model: 'test-model',
  inputTokens: 10,
  outputTokens: 20,
  totalTokens: 30,
} as const;

test('1. Valid camelCase usage is normalized', () => {
  assert.deepEqual(normalizeAIProviderUsage({ ...BASE_USAGE }), { ...BASE_USAGE });
});

test('2. Valid snake_case usage is normalized', () => {
  const result = normalizeAIProviderUsage({
    provider: 'test-provider',
    model: 'test-model',
    input_tokens: 10,
    output_tokens: 20,
    total_tokens: 30,
  });
  assert.deepEqual(result, { ...BASE_USAGE });
});

test('3. Valid mixed-case usage is normalized', () => {
  const result = normalizeAIProviderUsage({
    provider: 'test-provider',
    model: 'test-model',
    inputTokens: 10,
    output_tokens: 20,
    total_tokens: 30,
  });
  assert.deepEqual(result, { ...BASE_USAGE });
});

test('4. null returns undefined', () => {
  assert.equal(normalizeAIProviderUsage(null), undefined);
});

test('5. undefined returns undefined', () => {
  assert.equal(normalizeAIProviderUsage(undefined), undefined);
});

test('6. Primitive values return undefined', () => {
  for (const primitive of [42, 'usage', true, 0n]) {
    assert.equal(normalizeAIProviderUsage(primitive), undefined);
  }
  assert.equal(normalizeAIProviderUsage(() => null), undefined);
});

test('7. Missing provider returns undefined', () => {
  const { provider: _omitted, ...withoutProvider } = BASE_USAGE;
  assert.equal(normalizeAIProviderUsage(withoutProvider), undefined);
});

test('8. Empty provider returns undefined', () => {
  assert.equal(normalizeAIProviderUsage({ ...BASE_USAGE, provider: '' }), undefined);
  assert.equal(normalizeAIProviderUsage({ ...BASE_USAGE, provider: '   ' }), undefined);
});

test('9. Missing model returns undefined', () => {
  const { model: _omitted, ...withoutModel } = BASE_USAGE;
  assert.equal(normalizeAIProviderUsage(withoutModel), undefined);
});

test('10. Negative input tokens return undefined', () => {
  assert.equal(
    normalizeAIProviderUsage({ ...BASE_USAGE, inputTokens: -1 }),
    undefined,
  );
});

test('11. Decimal token count returns undefined', () => {
  assert.equal(
    normalizeAIProviderUsage({ ...BASE_USAGE, inputTokens: 10.5 }),
    undefined,
  );
});

test('12. String token value returns undefined', () => {
  assert.equal(
    normalizeAIProviderUsage({ ...BASE_USAGE, inputTokens: '10' }),
    undefined,
  );
});

test('13. NaN returns undefined', () => {
  assert.equal(normalizeAIProviderUsage({ ...BASE_USAGE, inputTokens: NaN }), undefined);
});

test('14. Infinity returns undefined', () => {
  assert.equal(
    normalizeAIProviderUsage({ ...BASE_USAGE, inputTokens: Infinity }),
    undefined,
  );
  assert.equal(
    normalizeAIProviderUsage({ ...BASE_USAGE, inputTokens: -Infinity }),
    undefined,
  );
});

test('15. Valid cached=true is preserved', () => {
  assert.deepEqual(normalizeAIProviderUsage({ ...BASE_USAGE, cached: true }), {
    ...BASE_USAGE,
    cached: true,
  });
});

test('16. Invalid cached value rejects the usage object', () => {
  for (const bad of ['true', 1, null, {}, []]) {
    assert.equal(normalizeAIProviderUsage({ ...BASE_USAGE, cached: bad }), undefined);
  }
});

test('17. Valid audioSeconds is preserved', () => {
  assert.deepEqual(normalizeAIProviderUsage({ ...BASE_USAGE, audioSeconds: 1.5 }), {
    ...BASE_USAGE,
    audioSeconds: 1.5,
  });
  assert.deepEqual(normalizeAIProviderUsage({ ...BASE_USAGE, audio_seconds: 2 }), {
    ...BASE_USAGE,
    audioSeconds: 2,
  });
});

test('18. Negative audioSeconds is not accepted', () => {
  assert.equal(
    normalizeAIProviderUsage({ ...BASE_USAGE, audioSeconds: -1 }),
    undefined,
  );
  assert.equal(
    normalizeAIProviderUsage({ ...BASE_USAGE, audio_seconds: -0.5 }),
    undefined,
  );
});

test('19. Unknown fields are ignored', () => {
  const result = normalizeAIProviderUsage({
    ...BASE_USAGE,
    cached: true,
    extra_field: 'x',
    nested: { deep: [1, 2] },
    input_tokens: 999,
  });
  assert.deepEqual(result, { ...BASE_USAGE, cached: true });
});

test('20. Input object is not mutated', () => {
  const input = { ...BASE_USAGE, cached: true, audioSeconds: 2.5, nested: { a: [1] } };
  const snapshot = structuredClone(input);
  normalizeAIProviderUsage(input);
  assert.deepEqual(input, snapshot);
});

test('21. totalTokens may differ from inputTokens + outputTokens and is preserved', () => {
  const result = normalizeAIProviderUsage({ ...BASE_USAGE, totalTokens: 99 });
  assert.equal(result?.inputTokens, 10);
  assert.equal(result?.outputTokens, 20);
  assert.equal(result?.totalTokens, 99);
});

test('22. camelCase wins when both valid camelCase and snake_case fields exist', () => {
  const result = normalizeAIProviderUsage({
    provider: 'p',
    model: 'm',
    inputTokens: 5,
    input_tokens: 50,
    outputTokens: 6,
    output_tokens: 60,
    totalTokens: 7,
    total_tokens: 70,
  });
  assert.deepEqual(result, {
    provider: 'p',
    model: 'm',
    inputTokens: 5,
    outputTokens: 6,
    totalTokens: 7,
  });
});

test('23. Invalid camelCase does not fall back to valid snake_case for the same field', () => {
  assert.equal(
    normalizeAIProviderUsage({
      provider: 'p',
      model: 'm',
      inputTokens: 'bad',
      input_tokens: 50,
      outputTokens: 6,
      totalTokens: 7,
    }),
    undefined,
  );
  assert.equal(
    normalizeAIProviderUsage({
      provider: 'p',
      model: 'm',
      outputTokens: 'bad',
      output_tokens: 60,
      inputTokens: 5,
      totalTokens: 7,
    }),
    undefined,
  );
  assert.equal(
    normalizeAIProviderUsage({
      provider: 'p',
      model: 'm',
      totalTokens: 'bad',
      total_tokens: 70,
      inputTokens: 5,
      outputTokens: 6,
    }),
    undefined,
  );
});

test('24. inputTokens undefined does not fall back to valid input_tokens', () => {
  assert.equal(
    normalizeAIProviderUsage({
      provider: 'p',
      model: 'm',
      inputTokens: undefined,
      input_tokens: 50,
      outputTokens: 6,
      totalTokens: 7,
    }),
    undefined,
  );
});

test('25. outputTokens undefined does not fall back to valid output_tokens', () => {
  assert.equal(
    normalizeAIProviderUsage({
      provider: 'p',
      model: 'm',
      outputTokens: undefined,
      output_tokens: 60,
      inputTokens: 5,
      totalTokens: 7,
    }),
    undefined,
  );
});

test('26. totalTokens undefined does not fall back to valid total_tokens', () => {
  assert.equal(
    normalizeAIProviderUsage({
      provider: 'p',
      model: 'm',
      totalTokens: undefined,
      total_tokens: 70,
      inputTokens: 5,
      outputTokens: 6,
    }),
    undefined,
  );
});

test('27. audioSeconds undefined does not fall back to valid audio_seconds', () => {
  assert.equal(
    normalizeAIProviderUsage({
      provider: 'p',
      model: 'm',
      inputTokens: 5,
      outputTokens: 6,
      totalTokens: 7,
      audioSeconds: undefined,
      audio_seconds: 2,
    }),
    undefined,
  );
});

test('28. cached undefined is present-but-invalid and rejects the usage', () => {
  assert.equal(
    normalizeAIProviderUsage({ ...BASE_USAGE, cached: undefined }),
    undefined,
  );
});

test('29. Completely absent optional cached and audioSeconds fields remain valid', () => {
  assert.deepEqual(normalizeAIProviderUsage({ ...BASE_USAGE }), { ...BASE_USAGE });
  assert.deepEqual(
    normalizeAIProviderUsage({ ...BASE_USAGE, audio_seconds: 2 }),
    { ...BASE_USAGE, audioSeconds: 2 },
  );
});

const CHAT_USER = {
  display_name: 'Sara',
  gender: 'FEMALE',
  nationality: 'Egyptian',
  language: ['en'],
  budget_level: 'moderate',
  travel_style: 'cultural',
  interests: ['history'],
  accommodation_type: 'hotel',
  preferences: { theme: 'history' },
};

test('30. Chat request history is optional', () => {
  const request: AIChatRequest = { message: 'hello', user: CHAT_USER };
  assert.equal('history' in request, false);
});

test('31. conversationSummary is optional', () => {
  const request: AIChatRequest = { message: 'hello', user: CHAT_USER };
  assert.equal('conversationSummary' in request, false);
});

test('32. maxOutputTokens is optional', () => {
  const request: AIChatRequest = { message: 'hello', user: CHAT_USER };
  assert.equal('maxOutputTokens' in request, false);
});

test('33. Chat response usage is optional', () => {
  const response: AIChatResponse = {
    response: 'ok',
    conversation_id: 'c1',
    persona: 'auto',
  };
  assert.equal('usage' in response, false);
});

test('34. Existing request shape remains representable', () => {
  const request: AIChatRequest = {
    message: 'Where should I go?',
    conversation_id: 'c1',
    persona: 'tour_guide',
    user: CHAT_USER,
    lat: 30.0444,
    lon: 31.2357,
    history: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ],
  };
  assert.equal(request.message, 'Where should I go?');
  assert.equal(request.conversation_id, 'c1');
  assert.equal(request.persona, 'tour_guide');
  assert.deepEqual(request.history?.[1], { role: 'assistant', content: 'hello' });
});

test('35. Existing response shape remains representable and accepts optional usage', () => {
  const response: AIChatResponse = {
    response: 'ok',
    conversation_id: 'c1',
    persona: 'auto',
    blocked: false,
    reason: null,
  };
  assert.equal(response.response, 'ok');

  const withUsage: AIChatResponse = {
    ...response,
    usage: { provider: 'p', model: 'm', inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  };
  assert.equal(withUsage.usage?.totalTokens, 2);
});

test('36. Chat history messages are typed for user and assistant roles', () => {
  const history: AIChatHistoryMessage[] = [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b' },
  ];
  assert.equal(history[0].role, 'user');
  assert.equal(history[1].role, 'assistant');
});

test('37. Future request fields are representable on the contract', () => {
  const request: AIChatRequest = {
    message: 'hello',
    user: CHAT_USER,
    history: [{ role: 'user', content: 'hi' }],
    conversationSummary: 'User asked about Cairo',
    maxOutputTokens: 512,
  };
  assert.equal(request.history?.length, 1);
  assert.equal(request.conversationSummary, 'User asked about Cairo');
  assert.equal(request.maxOutputTokens, 512);
});

test('38. AIProviderUsage contract accepts all documented fields', () => {
  const usage: AIProviderUsage = {
    provider: 'p',
    model: 'm',
    inputTokens: 1,
    outputTokens: 2,
    totalTokens: 3,
    cached: true,
    audioSeconds: 4.5,
  };
  assert.equal(usage.cached, true);
  assert.equal(usage.audioSeconds, 4.5);
});

const BASE_CALL = {
  provider: 'google',
  providerCallMade: true,
  providerCallId: 'call-1',
  requestedModel: 'gemini-3.6-flash',
  actualModel: 'gemini-3.6-flash',
  operation: 'TEXT_CHAT',
  usageSource: 'PROVIDER_RESPONSE',
  usageCompleteness: 'COMPLETE',
  inputTokens: 100,
  outputTokens: 40,
  totalTokens: 140,
} as const;

test('39. Valid provider calls array is normalized', () => {
  const result = normalizeProviderCalls([{ ...BASE_CALL }]);
  assert.equal(result?.length, 1);
  assert.deepEqual(result?.[0], { ...BASE_CALL });
});

test('40. Empty array returns undefined', () => {
  assert.equal(normalizeProviderCalls([]), undefined);
});

test('41. Non-array input returns undefined', () => {
  assert.equal(normalizeProviderCalls(null), undefined);
  assert.equal(normalizeProviderCalls(undefined), undefined);
  assert.equal(normalizeProviderCalls('x'), undefined);
  assert.equal(normalizeProviderCalls({}), undefined);
});

test('42. Missing provider rejects the array', () => {
  const { provider: _omitted, ...withoutProvider } = BASE_CALL;
  assert.equal(normalizeProviderCalls([withoutProvider]), undefined);
});

test('43. Empty provider rejects the array', () => {
  assert.equal(normalizeProviderCalls([{ ...BASE_CALL, provider: '  ' }]), undefined);
});

test('44. Missing providerCallMade rejects the array', () => {
  const { providerCallMade: _omitted, ...withoutMade } = BASE_CALL;
  assert.equal(normalizeProviderCalls([withoutMade]), undefined);
});

test('45. Non-boolean providerCallMade rejects the array', () => {
  assert.equal(normalizeProviderCalls([{ ...BASE_CALL, providerCallMade: 1 }]), undefined);
});

test('46. Negative token count rejects the array', () => {
  assert.equal(normalizeProviderCalls([{ ...BASE_CALL, inputTokens: -1 }]), undefined);
  assert.equal(normalizeProviderCalls([{ ...BASE_CALL, totalTokens: -5 }]), undefined);
});

test('47. Decimal token count rejects the array', () => {
  assert.equal(normalizeProviderCalls([{ ...BASE_CALL, outputTokens: 1.5 }]), undefined);
});

test('48. String token count rejects the array', () => {
  assert.equal(normalizeProviderCalls([{ ...BASE_CALL, inputTokens: '100' }]), undefined);
});

test('49. NaN/Infinity reject the array', () => {
  assert.equal(normalizeProviderCalls([{ ...BASE_CALL, inputTokens: NaN }]), undefined);
  assert.equal(normalizeProviderCalls([{ ...BASE_CALL, inputTokens: Infinity }]), undefined);
});

test('50. Optional fields are preserved when present', () => {
  const result = normalizeProviderCalls([
    { ...BASE_CALL, cachedInputTokens: 50, reasoningTokens: 3, accountingSemantics: 'INCLUDED_IN_AGGREGATE' },
  ]);
  assert.equal(result?.[0].cachedInputTokens, 50);
  assert.equal(result?.[0].reasoningTokens, 3);
  assert.equal(result?.[0].accountingSemantics, 'INCLUDED_IN_AGGREGATE');
});

test('51. Unknown numeric fields are dropped, not coerced to zero', () => {
  const result = normalizeProviderCalls([{ ...BASE_CALL }]);
  assert.equal(result?.[0].audioInputSeconds, undefined);
});

test('52. Input array is not mutated', () => {
  const input = [{ ...BASE_CALL }];
  const snapshot = structuredClone(input);
  normalizeProviderCalls(input);
  assert.deepEqual(input, snapshot);
});

test('53. Multiple calls preserve order and ids', () => {
  const result = normalizeProviderCalls([
    { ...BASE_CALL },
    { ...BASE_CALL, providerCallId: 'call-2', totalTokens: 200 },
  ]);
  assert.equal(result?.length, 2);
  assert.equal(result?.[1].providerCallId, 'call-2');
});

test('54. providerCalls is optional on AIChatResponse', () => {
  const response: AIChatResponse = {
    response: 'ok',
    conversation_id: 'c1',
    persona: 'auto',
  };
  assert.equal('providerCalls' in response, false);
});

test('55. AIChatResponse accepts providerCalls', () => {
  const response: AIChatResponse = {
    response: 'ok',
    conversation_id: 'c1',
    persona: 'auto',
    providerCalls: [{ provider: 'google', providerCallMade: true }],
  };
  assert.equal(response.providerCalls?.[0].provider, 'google');
});

test('56. ProviderCallUsage accepts all documented fields', () => {
  const call: ProviderCallUsage = {
    provider: 'google',
    providerCallMade: true,
    providerCallId: 'call-1',
    requestedModel: 'r',
    actualModel: 'a',
    operation: 'TEXT_CHAT',
    usageSource: 'PROVIDER_RESPONSE',
    usageCompleteness: 'COMPLETE',
    accountingSemantics: 'INCLUDED_IN_AGGREGATE',
    inputTokens: 1,
    outputTokens: 2,
    totalTokens: 3,
    cachedInputTokens: 4,
    reasoningTokens: 5,
  };
  assert.equal(call.reasoningTokens, 5);
});
