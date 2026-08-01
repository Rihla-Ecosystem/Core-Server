import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AIChatHistoryMessage } from '../src/types/ai.js';
import type {
  BuildChatContextInput,
  ChatContextLimits,
  TokenEstimator,
} from '../src/types/chat-context.js';
import {
  buildChatContext,
  ChatContextValidationError,
} from '../src/utils/chat-context-builder.js';

const wordCountEstimator: TokenEstimator = (text) =>
  text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;

const DEFAULT_LIMITS: ChatContextLimits = {
  maxRecentMessages: 20,
  historyTokenBudget: 1000,
  summaryTokenBudget: 200,
};

function msg(role: 'user' | 'assistant', content: string): AIChatHistoryMessage {
  return { role, content };
}

function buildInput(
  overrides: Partial<BuildChatContextInput> = {},
): BuildChatContextInput {
  return {
    currentMessage: 'current question',
    history: [],
    limits: DEFAULT_LIMITS,
    estimateTokens: wordCountEstimator,
    ...overrides,
  };
}

function limits(overrides: Partial<ChatContextLimits> = {}): ChatContextLimits {
  return { ...DEFAULT_LIMITS, ...overrides };
}

const u1 = msg('user', 'u1');
const a1 = msg('assistant', 'a1');
const u2 = msg('user', 'u2');
const a2 = msg('assistant', 'a2');
const u3 = msg('user', 'u3');
const a3 = msg('assistant', 'a3');
const u4 = msg('user', 'u4');
const a4 = msg('assistant', 'a4');
const u5 = msg('user', 'u5');
const a5 = msg('assistant', 'a5');

test('1. Empty history returns empty selected history', () => {
  const result = buildChatContext(buildInput({ history: [] }));
  assert.deepEqual(result.history, []);
  assert.equal(result.selectedMessageCount, 0);
  assert.equal(result.droppedMessageCount, 0);
});

test('2. History completely fits both limits', () => {
  const history = [u1, a1, u2, a2];
  const result = buildChatContext(buildInput({ history }));
  assert.deepEqual(result.history, history);
  assert.equal(result.selectedMessageCount, 4);
  assert.equal(result.droppedMessageCount, 0);
});

test('3. maxRecentMessages limits selection', () => {
  const history = [u1, a1, u2, a2, u3, a3, u4, a4];
  const result = buildChatContext(
    buildInput({ history, limits: limits({ maxRecentMessages: 4 }) }),
  );
  assert.deepEqual(result.history, [u3, a3, u4, a4]);
  assert.equal(result.selectedMessageCount, 4);
  assert.equal(result.droppedMessageCount, 4);
});

test('4. historyTokenBudget limits selection', () => {
  const history = [u1, a1, u2, a2, u3, a3];
  const result = buildChatContext(
    buildInput({ history, limits: limits({ historyTokenBudget: 4 }) }),
  );
  assert.deepEqual(result.history, [u2, a2, u3, a3]);
  assert.equal(result.estimatedTokens.historyTokens, 4);
});

test('5. Exact token-budget boundary is accepted', () => {
  const history = [u1, a1, u2, a2, u3, a3];
  const result = buildChatContext(
    buildInput({ history, limits: limits({ historyTokenBudget: 2 }) }),
  );
  assert.deepEqual(result.history, [u3, a3]);
  assert.equal(result.estimatedTokens.historyTokens, 2);
});

test('6. An oversized latest unmatched user message selects no older history', () => {
  const history = [
    u1,
    a1,
    msg('user', 'a very long pending question that exceeds the budget'),
  ];
  const result = buildChatContext(
    buildInput({ history, limits: limits({ historyTokenBudget: 2 }) }),
  );
  assert.deepEqual(result.history, []);
  assert.equal(result.selectedMessageCount, 0);
  assert.equal(result.droppedMessageCount, 3);
});

test('7. Selected messages are returned oldest-to-newest', () => {
  const history = [u1, a1, u2, a2, u3, a3, u4, a4];
  const result = buildChatContext(
    buildInput({ history, limits: limits({ maxRecentMessages: 4 }) }),
  );
  assert.deepEqual(
    result.history.map((m) => m.content),
    ['u3', 'a3', 'u4', 'a4'],
  );
});

test('8. Input history array is not mutated', () => {
  const history = [u1, a1, u2, a2, u3, a3, u4, a4];
  const snapshot = history.slice();
  const result = buildChatContext(
    buildInput({ history, limits: limits({ maxRecentMessages: 4 }) }),
  );
  assert.deepEqual(history, snapshot);
  assert.notEqual(result.history, history);
});

test('9. Input message objects are not mutated', () => {
  const history = [u1, a1];
  const snapshot = history.map((m) => ({ ...m }));
  buildChatContext(buildInput({ history }));
  assert.deepEqual(history, snapshot);
});

test('10. The newest complete user + assistant turn is selected first', () => {
  const history = [u1, a1, u2, a2];
  const result = buildChatContext(
    buildInput({ history, limits: limits({ maxRecentMessages: 2 }) }),
  );
  assert.deepEqual(result.history, [u2, a2]);
});

test('11. An orphan leading assistant is not returned', () => {
  const history = [msg('assistant', 'a0'), u1, a1];
  const result = buildChatContext(buildInput({ history }));
  assert.deepEqual(result.history, [u1, a1]);
});

test('12. A latest unmatched user message may be included', () => {
  const history = [u1, a1, u2];
  const full = buildChatContext(
    buildInput({ history, limits: limits({ maxRecentMessages: 3 }) }),
  );
  assert.deepEqual(full.history, [u1, a1, u2]);

  const onlyLatest = buildChatContext(
    buildInput({ history, limits: limits({ maxRecentMessages: 1 }) }),
  );
  assert.deepEqual(onlyLatest.history, [u2]);
});

test('13. A complete turn is skipped when only its assistant message could fit', () => {
  const history = [u1, a1];
  const result = buildChatContext(
    buildInput({ history, limits: limits({ maxRecentMessages: 1 }) }),
  );
  assert.deepEqual(result.history, []);
});

test('14. Multiple newest complete turns are selected until a limit is reached', () => {
  const history = [u1, a1, u2, a2, u3, a3, u4, a4, u5, a5];
  const result = buildChatContext(
    buildInput({ history, limits: limits({ maxRecentMessages: 6 }) }),
  );
  assert.deepEqual(result.history, [u3, a3, u4, a4, u5, a5]);
  assert.equal(result.selectedMessageCount, 6);
  assert.equal(result.droppedMessageCount, 4);
});

test('15. maxRecentMessages = 0 returns no history', () => {
  const result = buildChatContext(
    buildInput({ history: [u1, a1], limits: limits({ maxRecentMessages: 0 }) }),
  );
  assert.deepEqual(result.history, []);
});

test('16. historyTokenBudget = 0 returns no history', () => {
  const result = buildChatContext(
    buildInput({ history: [u1, a1], limits: limits({ historyTokenBudget: 0 }) }),
  );
  assert.deepEqual(result.history, []);
});

test('17. Summary within budget is included', () => {
  const result = buildChatContext(
    buildInput({
      conversationSummary: 'brief summary',
      limits: limits({ summaryTokenBudget: 5 }),
    }),
  );
  assert.equal(result.summaryIncluded, true);
  assert.equal(result.conversationSummary, 'brief summary');
  assert.equal(result.estimatedTokens.summaryTokens, 2);
  assert.equal(result.summaryExcludedReason, undefined);
});

test('18. Empty summary is omitted with reason EMPTY', () => {
  const result = buildChatContext(buildInput({ conversationSummary: '' }));
  assert.equal(result.summaryIncluded, false);
  assert.equal(result.summaryExcludedReason, 'EMPTY');
  assert.equal(result.conversationSummary, undefined);
  assert.equal(result.estimatedTokens.summaryTokens, 0);
});

test('19. Whitespace-only summary is omitted with reason EMPTY', () => {
  const result = buildChatContext(buildInput({ conversationSummary: '   \n  ' }));
  assert.equal(result.summaryIncluded, false);
  assert.equal(result.summaryExcludedReason, 'EMPTY');
  assert.equal(result.conversationSummary, undefined);
  assert.equal(result.estimatedTokens.summaryTokens, 0);
});

test('20. Summary exceeding its budget is omitted without truncation', () => {
  const summary = 'this is a quite long conversation summary that exceeds the configured budget';
  const result = buildChatContext(
    buildInput({ conversationSummary: summary, limits: limits({ summaryTokenBudget: 3 }) }),
  );
  assert.equal(result.summaryIncluded, false);
  assert.equal(result.summaryExcludedReason, 'BUDGET_EXCEEDED');
  assert.equal(result.conversationSummary, undefined);
  assert.equal(result.estimatedTokens.summaryTokens, 12);
});

test('21. summaryTokenBudget = 0 excludes a non-empty summary', () => {
  const result = buildChatContext(
    buildInput({ conversationSummary: 'some words here', limits: limits({ summaryTokenBudget: 0 }) }),
  );
  assert.equal(result.summaryIncluded, false);
  assert.equal(result.summaryExcludedReason, 'BUDGET_EXCEEDED');
});

test('22. Current message is kept separate from history', () => {
  const result = buildChatContext(
    buildInput({ currentMessage: 'new question', history: [u1, a1] }),
  );
  assert.equal(result.currentMessage, 'new question');
  assert.ok(!result.history.some((m) => m.content === 'new question'));
});

test('23. Current message token estimate is reported', () => {
  const result = buildChatContext(buildInput({ currentMessage: 'hello world' }));
  assert.equal(result.estimatedTokens.currentMessageTokens, 2);
});

test('24. History token total is reported correctly', () => {
  const result = buildChatContext(buildInput({ history: [u1, a1, u2, a2] }));
  assert.equal(result.estimatedTokens.historyTokens, 4);
});

test('25. Included summary contributes to totalTokens', () => {
  const result = buildChatContext(
    buildInput({
      currentMessage: 'hello world',
      history: [u1, a1],
      conversationSummary: 'brief summary',
      limits: limits({ summaryTokenBudget: 5 }),
    }),
  );
  assert.equal(result.estimatedTokens.currentMessageTokens, 2);
  assert.equal(result.estimatedTokens.historyTokens, 2);
  assert.equal(result.estimatedTokens.summaryTokens, 2);
  assert.equal(result.estimatedTokens.totalTokens, 6);
});

test('26. Excluded summary does not contribute to totalTokens', () => {
  const result = buildChatContext(
    buildInput({
      currentMessage: 'hello world',
      history: [u1, a1],
      conversationSummary: 'this is a quite long conversation summary that exceeds the configured budget',
      limits: limits({ summaryTokenBudget: 3 }),
    }),
  );
  assert.equal(result.estimatedTokens.summaryTokens, 12);
  assert.equal(result.estimatedTokens.totalTokens, 4);
});

test('27. Invalid maxRecentMessages is rejected', () => {
  for (const bad of [-1, 1.5, NaN, Infinity, '5'] as number[]) {
    assert.throws(
      () => buildChatContext(buildInput({ limits: limits({ maxRecentMessages: bad }) })),
      ChatContextValidationError,
    );
  }
});

test('28. Invalid historyTokenBudget is rejected', () => {
  for (const bad of [-1, 1.5, NaN, Infinity, '5'] as number[]) {
    assert.throws(
      () => buildChatContext(buildInput({ limits: limits({ historyTokenBudget: bad }) })),
      ChatContextValidationError,
    );
  }
});

test('29. Invalid summaryTokenBudget is rejected', () => {
  for (const bad of [-1, 1.5, NaN, Infinity, '5'] as number[]) {
    assert.throws(
      () => buildChatContext(buildInput({ limits: limits({ summaryTokenBudget: bad }) })),
      ChatContextValidationError,
    );
  }
});

test('30. Empty current message is rejected', () => {
  assert.throws(
    () => buildChatContext(buildInput({ currentMessage: '' })),
    ChatContextValidationError,
  );
});

test('31. Whitespace-only current message is rejected', () => {
  assert.throws(
    () => buildChatContext(buildInput({ currentMessage: '   \n ' })),
    ChatContextValidationError,
  );
});

test('32. Estimator returning a negative value is rejected', () => {
  assert.throws(
    () => buildChatContext(buildInput({ estimateTokens: () => -1 })),
    ChatContextValidationError,
  );
});

test('33. Estimator returning a decimal is rejected', () => {
  assert.throws(
    () => buildChatContext(buildInput({ estimateTokens: () => 1.5 })),
    ChatContextValidationError,
  );
});

test('34. Estimator returning NaN is rejected', () => {
  assert.throws(
    () => buildChatContext(buildInput({ estimateTokens: () => NaN })),
    ChatContextValidationError,
  );
});

test('35. Estimator returning Infinity is rejected', () => {
  assert.throws(
    () => buildChatContext(buildInput({ estimateTokens: () => Infinity })),
    ChatContextValidationError,
  );
});

test('36. Builder performs no database, HTTP, or AI operations', () => {
  const calls: string[] = [];
  const estimateTokens: TokenEstimator = (text) => {
    calls.push(text);
    return wordCountEstimator(text);
  };

  const result = buildChatContext({
    currentMessage: 'hello world',
    history: [u1, a1],
    conversationSummary: 'brief summary',
    limits: limits({ summaryTokenBudget: 5 }),
    estimateTokens,
  });

  assert.equal(result.history.length, 2);
  assert.equal(result.summaryIncluded, true);
  assert.equal(calls.length, 4);
});

test('37. A history entry with an invalid role is rejected', () => {
  assert.throws(
    () =>
      buildChatContext(
        buildInput({ history: [{ role: 'system', content: 'x' } as AIChatHistoryMessage] }),
      ),
    ChatContextValidationError,
  );
});

test('38. History that is not an array is rejected', () => {
  assert.throws(
    () => buildChatContext(buildInput({ history: 'not-an-array' as unknown as AIChatHistoryMessage[] })),
    ChatContextValidationError,
  );
});

test('39. A non-function estimator is rejected', () => {
  assert.throws(
    () => buildChatContext(buildInput({ estimateTokens: 'not-a-function' as unknown as TokenEstimator })),
    ChatContextValidationError,
  );
});

test('40. droppedMessageCount is reported correctly', () => {
  const history = [u1, a1, u2, a2, u3, a3];
  const result = buildChatContext(
    buildInput({ history, limits: limits({ maxRecentMessages: 2 }) }),
  );
  assert.equal(result.selectedMessageCount, 2);
  assert.equal(result.droppedMessageCount, 4);
});

test('41. Missing limit fields are rejected', () => {
  assert.throws(
    () => buildChatContext(buildInput({ limits: {} as ChatContextLimits })),
    ChatContextValidationError,
  );
});

test('42. A newest complete turn exceeding the token budget selects no older history', () => {
  const history = [
    u1,
    a1,
    msg('user', 'newest question with several words'),
    msg('assistant', 'newest response with several words'),
  ];
  const result = buildChatContext(
    buildInput({ history, limits: limits({ historyTokenBudget: 2 }) }),
  );
  assert.deepEqual(result.history, []);
  assert.equal(result.selectedMessageCount, 0);
  assert.equal(result.droppedMessageCount, 4);
});

test('43. A newest complete turn exceeding maxRecentMessages selects no older user', () => {
  const history = [u1, u2, a2];
  const result = buildChatContext(
    buildInput({ history, limits: limits({ maxRecentMessages: 1 }) }),
  );
  assert.deepEqual(result.history, []);
  assert.equal(result.selectedMessageCount, 0);
  assert.equal(result.droppedMessageCount, 3);
});

test('44. A too-large newest valid turn leaves no older valid units (contiguous suffix)', () => {
  const history = [
    u1,
    a1,
    msg('assistant', 'orphan'),
    msg('user', 'newest user exceeds'),
    msg('assistant', 'newest assistant exceeds'),
  ];
  const result = buildChatContext(
    buildInput({ history, limits: limits({ historyTokenBudget: 2 }) }),
  );
  assert.deepEqual(result.history, []);
  assert.equal(result.selectedMessageCount, 0);
  assert.equal(result.droppedMessageCount, 5);
});

test('45. An orphan assistant may be skipped while the previous complete turn is still selected', () => {
  const history = [u1, a1, msg('assistant', 'orphan'), u2, a2];
  const result = buildChatContext(buildInput({ history }));
  assert.deepEqual(result.history, [u1, a1, u2, a2]);
  assert.equal(result.selectedMessageCount, 4);
  assert.equal(result.droppedMessageCount, 1);
});
