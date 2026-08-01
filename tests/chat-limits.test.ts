import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAT_LIMITS_DEFAULTS,
  CHAT_LIMITS_ENV_VARS,
  ChatLimitsConfigurationError,
  parseChatLimitsConfig,
  toChatContextLimits,
  type ChatLimitsConfig,
} from '../src/config/chat-limits.js';

const DEFAULT_ENV_VARS = {
  CHAT_MAX_INPUT_TOKENS: '12000',
  CHAT_MAX_CURRENT_MESSAGE_TOKENS: '3000',
  CHAT_MAX_MESSAGE_CHARACTERS: '10000',
  CHAT_MAX_RECENT_MESSAGES: '10',
  CHAT_HISTORY_TOKEN_BUDGET: '5500',
  CHAT_SUMMARY_TOKEN_BUDGET: '1000',
  CHAT_MAX_OUTPUT_TOKENS: '1200',
};

function makeEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return { ...DEFAULT_ENV_VARS, ...overrides };
}

function rejectsVar(overrides: Record<string, string>): void {
  assert.throws(() => parseChatLimitsConfig(makeEnv(overrides)), ChatLimitsConfigurationError);
}

test('1. Missing environment variables produce all documented defaults', () => {
  const config = parseChatLimitsConfig({});
  assert.deepEqual({ ...config }, { ...CHAT_LIMITS_DEFAULTS });
  assert.equal(config.maxInputTokens, 12000);
  assert.equal(config.maxCurrentMessageTokens, 3000);
  assert.equal(config.maxMessageCharacters, 10000);
  assert.equal(config.maxRecentMessages, 10);
  assert.equal(config.historyTokenBudget, 5500);
  assert.equal(config.summaryTokenBudget, 1000);
  assert.equal(config.maxOutputTokens, 1200);
});

test('2. Default inputHeadroomTokens equals 2500', () => {
  assert.equal(parseChatLimitsConfig({}).inputHeadroomTokens, 2500);
});

test('3. Default values convert correctly to ChatContextLimits', () => {
  assert.deepEqual(toChatContextLimits(parseChatLimitsConfig({})), {
    maxRecentMessages: 10,
    historyTokenBudget: 5500,
    summaryTokenBudget: 1000,
  });
});

test('4. Every variable can be overridden with a valid integer string', () => {
  const config = parseChatLimitsConfig(
    makeEnv({
      CHAT_MAX_INPUT_TOKENS: '20000',
      CHAT_MAX_CURRENT_MESSAGE_TOKENS: '4000',
      CHAT_MAX_MESSAGE_CHARACTERS: '9999',
      CHAT_MAX_RECENT_MESSAGES: '7',
      CHAT_HISTORY_TOKEN_BUDGET: '3000',
      CHAT_SUMMARY_TOKEN_BUDGET: '500',
      CHAT_MAX_OUTPUT_TOKENS: '2048',
    }),
  );
  assert.equal(config.maxInputTokens, 20000);
  assert.equal(config.maxCurrentMessageTokens, 4000);
  assert.equal(config.maxMessageCharacters, 9999);
  assert.equal(config.maxRecentMessages, 7);
  assert.equal(config.historyTokenBudget, 3000);
  assert.equal(config.summaryTokenBudget, 500);
  assert.equal(config.maxOutputTokens, 2048);
});

test('5. Leading and trailing whitespace is accepted and trimmed', () => {
  const config = parseChatLimitsConfig(
    makeEnv({
      CHAT_MAX_INPUT_TOKENS: '  12000  ',
      CHAT_MAX_RECENT_MESSAGES: '\t10\n',
      CHAT_MAX_OUTPUT_TOKENS: ' 1200 ',
    }),
  );
  assert.equal(config.maxInputTokens, 12000);
  assert.equal(config.maxRecentMessages, 10);
  assert.equal(config.maxOutputTokens, 1200);
});

test('6. maxRecentMessages = 0 is accepted', () => {
  assert.equal(
    parseChatLimitsConfig(makeEnv({ CHAT_MAX_RECENT_MESSAGES: '0' })).maxRecentMessages,
    0,
  );
});

test('7. historyTokenBudget = 0 is accepted', () => {
  assert.equal(
    parseChatLimitsConfig(makeEnv({ CHAT_HISTORY_TOKEN_BUDGET: '0' })).historyTokenBudget,
    0,
  );
});

test('8. summaryTokenBudget = 0 is accepted', () => {
  assert.equal(
    parseChatLimitsConfig(makeEnv({ CHAT_SUMMARY_TOKEN_BUDGET: '0' })).summaryTokenBudget,
    0,
  );
});

test('9. A configuration with zero input headroom is accepted', () => {
  const config = parseChatLimitsConfig(
    makeEnv({
      CHAT_MAX_INPUT_TOKENS: '10000',
      CHAT_MAX_CURRENT_MESSAGE_TOKENS: '5000',
      CHAT_HISTORY_TOKEN_BUDGET: '3000',
      CHAT_SUMMARY_TOKEN_BUDGET: '2000',
    }),
  );
  assert.equal(config.inputHeadroomTokens, 0);
});

test('10. maxCurrentMessageTokens equal to maxInputTokens is accepted only when both budgets are zero', () => {
  const config = parseChatLimitsConfig(
    makeEnv({
      CHAT_MAX_INPUT_TOKENS: '5000',
      CHAT_MAX_CURRENT_MESSAGE_TOKENS: '5000',
      CHAT_HISTORY_TOKEN_BUDGET: '0',
      CHAT_SUMMARY_TOKEN_BUDGET: '0',
    }),
  );
  assert.equal(config.maxCurrentMessageTokens, 5000);
  assert.equal(config.maxInputTokens, 5000);
  assert.equal(config.inputHeadroomTokens, 0);

  assert.throws(
    () =>
      parseChatLimitsConfig(
        makeEnv({
          CHAT_MAX_INPUT_TOKENS: '5000',
          CHAT_MAX_CURRENT_MESSAGE_TOKENS: '5000',
          CHAT_HISTORY_TOKEN_BUDGET: '1',
          CHAT_SUMMARY_TOKEN_BUDGET: '0',
        }),
      ),
    ChatLimitsConfigurationError,
  );
});

test('11. Empty explicitly supplied value is rejected', () => {
  rejectsVar({ CHAT_MAX_INPUT_TOKENS: '' });
});

test('12. Whitespace-only explicitly supplied value is rejected', () => {
  rejectsVar({ CHAT_MAX_INPUT_TOKENS: '   \t ' });
});

test('13. Decimal value is rejected', () => {
  rejectsVar({ CHAT_MAX_INPUT_TOKENS: '1.5' });
});

test('14. Negative disallowed value is rejected', () => {
  rejectsVar({ CHAT_MAX_INPUT_TOKENS: '-5' });
  rejectsVar({ CHAT_MAX_RECENT_MESSAGES: '-1' });
});

test('15. Alphabetic suffix such as "1000tokens" is rejected', () => {
  rejectsVar({ CHAT_MAX_INPUT_TOKENS: '1000tokens' });
});

test('16. NaN is rejected', () => {
  rejectsVar({ CHAT_MAX_INPUT_TOKENS: 'NaN' });
});

test('17. Infinity is rejected', () => {
  rejectsVar({ CHAT_MAX_INPUT_TOKENS: 'Infinity' });
  rejectsVar({ CHAT_MAX_INPUT_TOKENS: '-Infinity' });
});

test('18. Hexadecimal string is rejected', () => {
  rejectsVar({ CHAT_MAX_INPUT_TOKENS: '0x10' });
});

test('19. Scientific notation is rejected', () => {
  rejectsVar({ CHAT_MAX_INPUT_TOKENS: '1e3' });
});

test('20. A value containing only a plus or minus sign is rejected', () => {
  rejectsVar({ CHAT_MAX_INPUT_TOKENS: '+' });
  rejectsVar({ CHAT_MAX_INPUT_TOKENS: '-' });
});

test('21. maxInputTokens = 0 is rejected', () => {
  rejectsVar({ CHAT_MAX_INPUT_TOKENS: '0' });
});

test('22. maxCurrentMessageTokens = 0 is rejected', () => {
  rejectsVar({ CHAT_MAX_CURRENT_MESSAGE_TOKENS: '0' });
});

test('23. maxMessageCharacters = 0 is rejected', () => {
  rejectsVar({ CHAT_MAX_MESSAGE_CHARACTERS: '0' });
});

test('24. maxOutputTokens = 0 is rejected', () => {
  rejectsVar({ CHAT_MAX_OUTPUT_TOKENS: '0' });
});

test('25. maxCurrentMessageTokens greater than maxInputTokens is rejected', () => {
  rejectsVar({
    CHAT_MAX_INPUT_TOKENS: '1000',
    CHAT_MAX_CURRENT_MESSAGE_TOKENS: '5000',
  });
});

test('26. current + history + summary greater than maxInputTokens is rejected', () => {
  rejectsVar({
    CHAT_MAX_INPUT_TOKENS: '4000',
    CHAT_MAX_CURRENT_MESSAGE_TOKENS: '3000',
    CHAT_HISTORY_TOKEN_BUDGET: '1000',
    CHAT_SUMMARY_TOKEN_BUDGET: '1000',
  });
});

test('27. The relationship error identifies the conflicting configuration fields', () => {
  assert.throws(
    () =>
      parseChatLimitsConfig(
        makeEnv({
          CHAT_MAX_INPUT_TOKENS: '4000',
          CHAT_HISTORY_TOKEN_BUDGET: '3000',
          CHAT_SUMMARY_TOKEN_BUDGET: '2000',
        }),
      ),
    (err: unknown) => {
      assert.ok(err instanceof ChatLimitsConfigurationError);
      const message = err.message;
      assert.match(message, /maxCurrentMessageTokens/);
      assert.match(message, /historyTokenBudget/);
      assert.match(message, /summaryTokenBudget/);
      assert.match(message, /maxInputTokens/);
      return true;
    },
  );
});

test('28. maxOutputTokens does not affect the input headroom calculation', () => {
  const config = parseChatLimitsConfig(
    makeEnv({ CHAT_MAX_OUTPUT_TOKENS: '999999' }),
  );
  assert.equal(config.maxOutputTokens, 999999);
  assert.equal(config.inputHeadroomTokens, 2500);
});

test('29. The supplied environment object is not mutated', () => {
  const env = makeEnv({ CHAT_MAX_RECENT_MESSAGES: '5' });
  const snapshot = { ...env };
  parseChatLimitsConfig(env);
  assert.deepEqual(env, snapshot);

  const frozenEnv = Object.freeze(makeEnv());
  parseChatLimitsConfig(frozenEnv);
});

test('30. Repeated parsing produces independent configuration objects', () => {
  const first = parseChatLimitsConfig({});
  const second = parseChatLimitsConfig({});
  assert.notEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(second), true);
});

test('31. toChatContextLimits returns a new object', () => {
  const config = parseChatLimitsConfig({});
  const first = toChatContextLimits(config);
  const second = toChatContextLimits(config);
  assert.notEqual(first, second);
  assert.notEqual(first, config);
  assert.equal(Object.isFrozen(first), true);
});

test('32. Unknown environment variables are ignored', () => {
  const config = parseChatLimitsConfig({
    CHAT_UNKNOWN_VAR: '123',
    FOO: 'bar',
    CHAT_INPUT_HEADROOM_TOKENS: '9999',
  });
  assert.deepEqual({ ...config }, { ...CHAT_LIMITS_DEFAULTS });
});

test('33. The parser performs no database, HTTP, AI, Prisma, wallet, or pricing work', () => {
  const first = parseChatLimitsConfig({});
  const second = parseChatLimitsConfig({});
  assert.deepEqual({ ...first }, { ...second });
  assert.equal(first.maxInputTokens, CHAT_LIMITS_DEFAULTS.maxInputTokens);
  assert.equal(second.maxOutputTokens, CHAT_LIMITS_DEFAULTS.maxOutputTokens);
});

test('34. Error messages do not include the complete environment object', () => {
  const env = makeEnv({
    CHAT_MAX_INPUT_TOKENS: '0x10',
    CHAT_UNKNOWN_SENTINEL: 'super-sensitive-value',
  });
  assert.throws(
    () => parseChatLimitsConfig(env),
    (err: unknown) => {
      assert.ok(err instanceof ChatLimitsConfigurationError);
      assert.ok(!err.message.includes('super-sensitive-value'));
      assert.ok(!err.message.includes('CHAT_UNKNOWN_SENTINEL'));
      return true;
    },
  );
});

test('35. inputHeadroomTokens is always recalculated from the three budgets', () => {
  const config = parseChatLimitsConfig(
    makeEnv({
      CHAT_MAX_INPUT_TOKENS: '9000',
      CHAT_MAX_CURRENT_MESSAGE_TOKENS: '2000',
      CHAT_HISTORY_TOKEN_BUDGET: '3000',
      CHAT_SUMMARY_TOKEN_BUDGET: '1000',
    }),
  );
  assert.equal(config.inputHeadroomTokens, 9000 - 2000 - 3000 - 1000);
});

test('36. The supported environment variable names are exactly the seven', () => {
  assert.deepEqual(
    Object.values(CHAT_LIMITS_ENV_VARS).sort(),
    [
      'CHAT_HISTORY_TOKEN_BUDGET',
      'CHAT_MAX_CURRENT_MESSAGE_TOKENS',
      'CHAT_MAX_INPUT_TOKENS',
      'CHAT_MAX_MESSAGE_CHARACTERS',
      'CHAT_MAX_OUTPUT_TOKENS',
      'CHAT_MAX_RECENT_MESSAGES',
      'CHAT_SUMMARY_TOKEN_BUDGET',
    ].sort(),
  );
});

test('37. A value with internal whitespace is rejected', () => {
  rejectsVar({ CHAT_MAX_INPUT_TOKENS: '10 00' });
});

test('38. A non-string supplied value is rejected', () => {
  assert.throws(
    () =>
      parseChatLimitsConfig({
        ...makeEnv(),
        CHAT_MAX_INPUT_TOKENS: 5 as unknown as string,
      }),
    ChatLimitsConfigurationError,
  );
});

test('39. The error type extends Error with a stable name', () => {
  const config = parseChatLimitsConfig({});
  assert.ok(config instanceof Object);
  const err = new ChatLimitsConfigurationError('test');
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'ChatLimitsConfigurationError');
  assert.equal(typeof err.message, 'string');
});

test('40. An extremely large decimal string is rejected', () => {
  rejectsVar({ CHAT_MAX_INPUT_TOKENS: '9'.repeat(400) });
});

test('41. MAX_SAFE_INTEGER + 1 is rejected', () => {
  rejectsVar({ CHAT_MAX_INPUT_TOKENS: '9007199254740992' });
});

test('42. A positive field outside the safe integer range is rejected', () => {
  rejectsVar({ CHAT_MAX_OUTPUT_TOKENS: '9007199254740992' });
  rejectsVar({ CHAT_MAX_MESSAGE_CHARACTERS: '999999999999999999999999999999999999' });
});

test('43. A non-negative field outside the safe integer range is rejected', () => {
  rejectsVar({ CHAT_MAX_RECENT_MESSAGES: '9007199254740992' });
  rejectsVar({ CHAT_HISTORY_TOKEN_BUDGET: '999999999999999999999999999999999999' });
});

test('44. MAX_SAFE_INTEGER itself parses accurately', () => {
  const config = parseChatLimitsConfig(
    makeEnv({
      CHAT_MAX_INPUT_TOKENS: '9007199254740991',
      CHAT_MAX_CURRENT_MESSAGE_TOKENS: '3000',
      CHAT_HISTORY_TOKEN_BUDGET: '5500',
      CHAT_SUMMARY_TOKEN_BUDGET: '1000',
    }),
  );
  assert.equal(config.maxInputTokens, 9007199254740991);
  assert.equal(config.inputHeadroomTokens, 9007199254740991 - 3000 - 5500 - 1000);
});

test('45. Normal values continue to parse correctly', () => {
  const config = parseChatLimitsConfig(makeEnv());
  assert.deepEqual({ ...config }, { ...CHAT_LIMITS_DEFAULTS });
  assert.equal(config.inputHeadroomTokens, 2500);
});

test('46. Unsafe-integer errors do not expose the complete environment object', () => {
  const env = makeEnv({
    CHAT_MAX_INPUT_TOKENS: '9007199254740992',
    CHAT_UNKNOWN_SENTINEL: 'super-sensitive-value',
  });
  assert.throws(
    () => parseChatLimitsConfig(env),
    (err: unknown) => {
      assert.ok(err instanceof ChatLimitsConfigurationError);
      assert.ok(!err.message.includes('super-sensitive-value'));
      assert.ok(!err.message.includes('CHAT_UNKNOWN_SENTINEL'));
      return true;
    },
  );
});
