import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AIBillingOperationStatus, TokenReservationStatus, TokenTransactionSource } from '@prisma/client';
import type { AIProviderUsage } from '../src/types/ai.js';
import type {
  AIProviderTokenRate,
  AIUsagePricingInput,
  AIUsagePricingResult,
  AIWalletPricingPolicy,
} from '../src/types/ai-pricing.js';
import type { AIReservationQuoteInput, AIReservationQuoteResult } from '../src/types/ai-reservation-quote.js';
import type { ChatLimitsConfig } from '../src/config/chat-limits.js';
import type { AIExecutionSuccess } from '../src/types/ai-execution.js';
import type {
  AIBillingOrchestratorDependencies,
  AIBillingOrchestratorInput,
  AIBillingOrchestrationResult,
  AIBillingOrchestratorResult,
  AIBillingOrchestratorRecoveryResult,
  AIBillingOrchestratorReleasedResult,
  AIBillingReservationMetadata,
} from '../src/types/ai-billing-orchestrator.js';
import type {
  CreateAIBillingOperationInput,
  CreateAIBillingOperationResult,
  MarkAIBillingOperationReleasedInput,
  MarkAIBillingOperationReleasedResult,
  MarkAIBillingOperationSettledInput,
  MarkAIBillingOperationSettledResult,
  RecordAIBillingOperationExecutionSuccessInput,
  RecordAIBillingOperationExecutionSuccessResult,
  RecordAIBillingOperationFailureInput,
  RecordAIBillingOperationFailureResult,
  RecordAIBillingOperationPricingInput,
  RecordAIBillingOperationPricingResult,
} from '../src/types/ai-billing-operation.js';
import type {
  ReleaseBusinessTokenReservationInput,
  ReleaseBusinessTokenReservationResult,
  ReserveBusinessTokensForAmountInput,
  ReserveBusinessTokensResult,
  SettleBusinessTokenReservationForAmountInput,
  SettleBusinessTokenReservationResult,
} from '../src/services/token-reservation.service.js';
import { AIBillingOperationError } from '../src/services/ai-billing-operation.service.js';
import { runAIBillingOrchestration } from '../src/services/ai-billing-orchestrator.service.js';
import { calculateAIReservationQuote } from '../src/utils/ai-reservation-quote.js';
import { calculateAIUsagePrice } from '../src/utils/ai-usage-pricing.js';
import { parseAIExecutionOutcome } from '../src/utils/ai-execution-contract.js';
import { BUSINESS_TOKEN_PRICING_VERSION } from '../src/config/business-token-features.js';

interface SampleData {
  text: string;
}

const SAMPLE_DATA: SampleData = { text: 'hello' };
const OPERATION_ID = 'operation-external-1';
const RESERVATION_ID = 'res-1';

const BASE_USAGE: AIProviderUsage = {
  provider: 'fake-provider',
  model: 'fake-model',
  inputTokens: 10,
  outputTokens: 20,
  totalTokens: 30,
};

const BASE_CHAT_LIMITS: ChatLimitsConfig = {
  maxInputTokens: 12000,
  maxCurrentMessageTokens: 3000,
  maxMessageCharacters: 10000,
  maxRecentMessages: 10,
  historyTokenBudget: 5500,
  summaryTokenBudget: 1000,
  maxOutputTokens: 1200,
  inputHeadroomTokens: 12000 - 3000 - 5500 - 1000,
};

const BASE_RATE: AIProviderTokenRate = {
  provider: 'fake-provider',
  model: 'fake-model',
  billingCurrency: 'USD',
  inputMicrosPerMillionTokens: 1_000_000,
  outputMicrosPerMillionTokens: 1_000_000,
  version: 'rate-v1',
};

const BASE_POLICY: AIWalletPricingPolicy = {
  billingCurrency: 'USD',
  walletTokenValueMicros: 1,
  minimumWalletTokens: 1,
  markupBasisPoints: 10_000,
  version: 'policy-v1',
};

function chatLimits(overrides: Partial<ChatLimitsConfig> = {}): ChatLimitsConfig {
  return { ...BASE_CHAT_LIMITS, ...overrides };
}

function rateCard(overrides: Partial<AIProviderTokenRate> = {}): AIProviderTokenRate[] {
  return [{ ...BASE_RATE, ...overrides }];
}

function policy(overrides: Partial<AIWalletPricingPolicy> = {}): AIWalletPricingPolicy {
  return { ...BASE_POLICY, ...overrides };
}

function successOutcome(
  overrides: Partial<AIExecutionSuccess<SampleData>> = {},
): AIExecutionSuccess<SampleData> {
  return {
    kind: 'SUCCESS',
    data: SAMPLE_DATA,
    execution: { provider: 'fake-provider', model: 'fake-model' },
    usage: BASE_USAGE,
    ...overrides,
  };
}

function defaultExecute(): Promise<unknown> {
  return Promise.resolve(successOutcome());
}

function recordExecute(
  calls: FakeCalls,
  fn: () => Promise<unknown> = defaultExecute,
): (context: { operationId: string; reservationId: string }) => Promise<unknown> {
  return async (context) => {
    calls.order.push('execute');
    calls.executeContexts.push(context);
    return fn();
  };
}

function buildInput(
  overrides: Partial<AIBillingOrchestratorInput<SampleData>> = {},
): AIBillingOrchestratorInput<SampleData> {
  return {
    operationId: OPERATION_ID,
    userId: 'user-1',
    feature: 'AI_CHAT_QUERY',
    source: TokenTransactionSource.CHAT,
    idempotencyKey: 'key-1',
    requestedMode: 'PROVIDER_USAGE',
    provider: 'fake-provider',
    model: 'fake-model',
    chatLimits: chatLimits(),
    rateCard: rateCard(),
    walletPolicy: policy(),
    execute: defaultExecute,
    ...overrides,
  };
}

function expectedQuote(input: AIBillingOrchestratorInput<SampleData>): AIReservationQuoteResult {
  return calculateAIReservationQuote({
    feature: input.feature,
    requestedMode: input.requestedMode,
    provider: input.provider,
    model: input.model,
    chatLimits: input.chatLimits,
    rateCard: input.rateCard,
    walletPolicy: input.walletPolicy,
  });
}

function expectedPrice(
  input: AIBillingOrchestratorInput<SampleData>,
  usage: unknown,
): AIUsagePricingResult {
  return calculateAIUsagePrice({
    feature: input.feature,
    requestedMode: input.requestedMode,
    usage: usage as AIProviderUsage | undefined,
    rateCard: input.rateCard,
    walletPolicy: input.walletPolicy,
  });
}

function fakeReserve(input: ReserveBusinessTokensForAmountInput): ReserveBusinessTokensResult {
  return {
    reservationId: RESERVATION_ID,
    referenceId: `${input.userId}:${input.feature}:${input.idempotencyKey}`,
    walletId: 'wallet-1',
    userId: input.userId,
    feature: input.feature,
    source: input.source,
    tokens: input.tokens,
    pricingVersion: BUSINESS_TOKEN_PRICING_VERSION,
    status: TokenReservationStatus.PENDING,
    expiresAt: new Date(Date.now() + 100_000),
    metadata: input.metadata ?? null,
    availableBalance: 1_000_000 - input.tokens,
    reservedBalance: input.tokens,
    totalBalance: 1_000_000,
    idempotentReplay: false,
  };
}

function fakeSettle(
  input: SettleBusinessTokenReservationForAmountInput,
  reserved: number,
): SettleBusinessTokenReservationResult {
  return {
    reservationId: input.reservationId,
    referenceId: 'ref',
    walletId: 'wallet-1',
    userId: 'user-1',
    feature: 'AI_CHAT_QUERY',
    source: TokenTransactionSource.CHAT,
    tokens: reserved,
    actualTokens: input.actualTokens,
    releasedTokens: reserved - input.actualTokens,
    pricingVersion: BUSINESS_TOKEN_PRICING_VERSION,
    status: TokenReservationStatus.COMPLETED,
    settledAt: new Date('2026-01-01T00:00:00.000Z'),
    consumeTransactionId: 'tx-1',
    idempotentReplay: false,
  };
}

function fakeRelease(
  input: ReleaseBusinessTokenReservationInput,
): ReleaseBusinessTokenReservationResult {
  return {
    reservationId: input.reservationId,
    referenceId: 'ref',
    walletId: 'wallet-1',
    userId: 'user-1',
    feature: 'AI_CHAT_QUERY',
    source: TokenTransactionSource.CHAT,
    tokens: 0,
    pricingVersion: BUSINESS_TOKEN_PRICING_VERSION,
    status: TokenReservationStatus.RELEASED,
    releasedAt: new Date('2026-01-01T00:00:00.000Z'),
    releaseReason: input.reason ?? null,
    idempotentReplay: false,
  };
}

function priceResult(overrides: Partial<AIUsagePricingResult> = {}): AIUsagePricingResult {
  return {
    feature: 'AI_CHAT_QUERY',
    requestedMode: 'PROVIDER_USAGE',
    appliedMode: 'PROVIDER_USAGE',
    walletTokens: 30,
    fixedFallbackTokens: 2,
    provider: 'fake-provider',
    model: 'fake-model',
    billingCurrency: 'USD',
    rateCardVersion: 'rate-v1',
    walletPolicyVersion: 'policy-v1',
    ...overrides,
  };
}

interface OperationRecord {
  operationId: string;
  reservationId: string;
  status: AIBillingOperationStatus;
  requestedProvider: string | null;
  requestedModel: string | null;
}

function buildCreateResult(
  operationId: string,
  reservationId: string,
  status: AIBillingOperationStatus = AIBillingOperationStatus.RESERVED,
  idempotentReplay = false,
  reservedTokens = 0,
  reservationPricingVersion = BUSINESS_TOKEN_PRICING_VERSION,
): CreateAIBillingOperationResult {
  return {
    operationId,
    reservationId,
    walletId: 'wallet-1',
    userId: 'user-1',
    feature: 'AI_CHAT_QUERY',
    source: TokenTransactionSource.CHAT,
    status,
    reservedTokens,
    reservationPricingVersion,
    idempotentReplay,
    createdAt: new Date(),
  };
}

function buildEvidence(rec: OperationRecord) {
  return {
    operationId: rec.operationId,
    reservationId: rec.reservationId,
    walletId: 'wallet-1',
    userId: 'user-1',
    feature: 'AI_CHAT_QUERY',
    source: TokenTransactionSource.CHAT,
    status: rec.status,
    reservedTokens: 0,
    reservationPricingVersion: 1,
    ...(rec.requestedProvider === null ? {} : { requestedProvider: rec.requestedProvider }),
    ...(rec.requestedModel === null ? {} : { requestedModel: rec.requestedModel }),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

interface FakeCalls {
  order: string[];
  getOperationIds: string[];
  quoteInputs: AIReservationQuoteInput[];
  reserveInputs: ReserveBusinessTokensForAmountInput[];
  createInputs: CreateAIBillingOperationInput[];
  executeContexts: Array<{ operationId: string; reservationId: string }>;
  recordExecutionInputs: RecordAIBillingOperationExecutionSuccessInput[];
  priceInputs: AIUsagePricingInput[];
  recordPricingInputs: RecordAIBillingOperationPricingInput[];
  settleInputs: SettleBusinessTokenReservationForAmountInput[];
  markSettledInputs: MarkAIBillingOperationSettledInput[];
  releaseInputs: ReleaseBusinessTokenReservationInput[];
  markReleasedInputs: MarkAIBillingOperationReleasedInput[];
  failureInputs: RecordAIBillingOperationFailureInput[];
}

interface MakeDepsOptions {
  initialStatus?: AIBillingOperationStatus;
  initialReservationId?: string;
  createIdempotentReplay?: boolean;
  createThrows?: boolean;
  executionThrows?: boolean;
  pricingThrows?: boolean;
  failureThrows?: boolean;
  settledThrows?: boolean;
  releasedThrows?: boolean;
  preflightError?: boolean;
  reserveIdempotentReplay?: boolean;
}

function makeDeps(
  overrides: Partial<AIBillingOrchestratorDependencies> = {},
  options: MakeDepsOptions = {},
): { deps: AIBillingOrchestratorDependencies; calls: FakeCalls } {
  const calls: FakeCalls = {
    order: [],
    getOperationIds: [],
    quoteInputs: [],
    reserveInputs: [],
    createInputs: [],
    executeContexts: [],
    recordExecutionInputs: [],
    priceInputs: [],
    recordPricingInputs: [],
    settleInputs: [],
    markSettledInputs: [],
    releaseInputs: [],
    markReleasedInputs: [],
    failureInputs: [],
  };

  const records = new Map<string, OperationRecord>();

  if (options.initialStatus) {
    records.set(OPERATION_ID, {
      operationId: OPERATION_ID,
      reservationId: options.initialReservationId ?? RESERVATION_ID,
      status: options.initialStatus,
      requestedProvider: null,
      requestedModel: null,
    });
  }

  const reservedByReservation = new Map<string, number>();

  const deps: AIBillingOrchestratorDependencies = {
    calculateQuote: (input) => {
      calls.order.push('quote');
      calls.quoteInputs.push(input);
      if (overrides.calculateQuote) return overrides.calculateQuote(input);
      return calculateAIReservationQuote(input);
    },
    reserveForAmount: async (input) => {
      calls.order.push('reserve');
      calls.reserveInputs.push(input);
      if (overrides.reserveForAmount) return overrides.reserveForAmount(input);
      const result = fakeReserve(input);
      reservedByReservation.set(RESERVATION_ID, input.tokens);
      return options.reserveIdempotentReplay ? { ...result, idempotentReplay: true } : result;
    },
    getAIBillingOperationByOperationId: async (input) => {
      calls.order.push('preflight');
      calls.getOperationIds.push(input.operationId);
      if (overrides.getAIBillingOperationByOperationId) {
        return overrides.getAIBillingOperationByOperationId(input);
      }
      if (options.preflightError) {
        throw new Error('preflight read failed');
      }
      const rec = records.get(input.operationId);
      return rec ? buildEvidence(rec) : null;
    },
    createAIBillingOperation: async (input) => {
      calls.order.push('createOperation');
      calls.createInputs.push(input);
      if (overrides.createAIBillingOperation) return overrides.createAIBillingOperation(input);
      if (options.createThrows) {
        throw new AIBillingOperationError('STORAGE_FAILED', 'create failed', {
          operationId: input.operationId,
          reservationId: input.reservationId,
          recoveryRequired: true,
        });
      }
      const existing = records.get(input.operationId);
      if (existing || options.createIdempotentReplay) {
        return buildCreateResult(
          input.operationId,
          existing?.reservationId ?? input.reservationId,
          existing?.status ?? AIBillingOperationStatus.RESERVED,
          true,
          reservedByReservation.get(existing?.reservationId ?? input.reservationId) ?? 0,
          BUSINESS_TOKEN_PRICING_VERSION,
        );
      }
      records.set(input.operationId, {
        operationId: input.operationId,
        reservationId: input.reservationId,
        status: AIBillingOperationStatus.RESERVED,
        requestedProvider: input.requestedProvider ?? null,
        requestedModel: input.requestedModel ?? null,
      });
      return buildCreateResult(
        input.operationId,
        input.reservationId,
        AIBillingOperationStatus.RESERVED,
        false,
        reservedByReservation.get(input.reservationId) ?? 0,
        BUSINESS_TOKEN_PRICING_VERSION,
      );
    },
    recordAIBillingOperationExecutionSuccess: async (input) => {
      calls.order.push('recordExecution');
      calls.recordExecutionInputs.push(input);
      if (overrides.recordAIBillingOperationExecutionSuccess) {
        return overrides.recordAIBillingOperationExecutionSuccess(input);
      }
      const rec = records.get(input.operationId);
      if (!rec) {
        throw new AIBillingOperationError('OPERATION_NOT_FOUND', 'not found', {
          operationId: input.operationId,
        });
      }
      if (rec.status !== AIBillingOperationStatus.RESERVED) {
        throw new AIBillingOperationError('INVALID_TRANSITION', 'invalid transition', {
          operationId: input.operationId,
        });
      }
      if (rec.requestedProvider && input.execution.provider !== rec.requestedProvider) {
        throw new AIBillingOperationError('INTEGRITY_CONFLICT', 'provider mismatch', {
          operationId: input.operationId,
        });
      }
      if (rec.requestedModel && input.execution.model !== rec.requestedModel) {
        throw new AIBillingOperationError('INTEGRITY_CONFLICT', 'model mismatch', {
          operationId: input.operationId,
        });
      }
      if (options.executionThrows) {
        throw new Error('record execution boom');
      }
      rec.status = AIBillingOperationStatus.EXECUTION_SUCCEEDED;
      const result: RecordAIBillingOperationExecutionSuccessResult = {
        operationId: input.operationId,
        reservationId: rec.reservationId,
        status: AIBillingOperationStatus.EXECUTION_SUCCEEDED,
        executedAt: new Date(),
        idempotentReplay: false,
      };
      return result;
    },
    recordAIBillingOperationPricing: async (input) => {
      calls.order.push('recordPricing');
      calls.recordPricingInputs.push(input);
      if (overrides.recordAIBillingOperationPricing) return overrides.recordAIBillingOperationPricing(input);
      const rec = records.get(input.operationId);
      if (!rec) {
        throw new AIBillingOperationError('OPERATION_NOT_FOUND', 'not found', {
          operationId: input.operationId,
        });
      }
      if (rec.status !== AIBillingOperationStatus.EXECUTION_SUCCEEDED) {
        throw new AIBillingOperationError('INVALID_TRANSITION', 'invalid transition', {
          operationId: input.operationId,
        });
      }
      if (options.pricingThrows) {
        throw new Error('record pricing boom');
      }
      rec.status = AIBillingOperationStatus.PRICED;
      const result: RecordAIBillingOperationPricingResult = {
        operationId: input.operationId,
        reservationId: rec.reservationId,
        status: AIBillingOperationStatus.PRICED,
        pricedAt: new Date(),
        actualWalletTokens: input.pricing.walletTokens,
        idempotentReplay: false,
      };
      return result;
    },
    recordAIBillingOperationFailure: async (input) => {
      calls.order.push('recordFailure');
      calls.failureInputs.push(input);
      if (overrides.recordAIBillingOperationFailure) return overrides.recordAIBillingOperationFailure(input);
      const rec = records.get(input.operationId);
      if (!rec) {
        throw new AIBillingOperationError('OPERATION_NOT_FOUND', 'not found', {
          operationId: input.operationId,
        });
      }
      if (rec.status !== AIBillingOperationStatus.RESERVED) {
        throw new AIBillingOperationError('INVALID_TRANSITION', 'invalid transition', {
          operationId: input.operationId,
        });
      }
      if (options.failureThrows) {
        throw new Error('record failure boom');
      }
      const target =
        input.failure.kind === 'NON_BILLABLE_FAILURE'
          ? AIBillingOperationStatus.NON_BILLABLE_CONFIRMED
          : AIBillingOperationStatus.INDETERMINATE;
      rec.status = target;
      const result: RecordAIBillingOperationFailureResult = {
        operationId: input.operationId,
        reservationId: rec.reservationId,
        status: target,
        failureKind: input.failure.kind,
        providerRequestSent: input.failure.providerRequestSent,
        failedAt: new Date(),
        idempotentReplay: false,
      };
      return result;
    },
    markAIBillingOperationSettled: async (input) => {
      calls.order.push('markSettled');
      calls.markSettledInputs.push(input);
      if (overrides.markAIBillingOperationSettled) return overrides.markAIBillingOperationSettled(input);
      const rec = records.get(input.operationId);
      if (!rec) {
        throw new AIBillingOperationError('OPERATION_NOT_FOUND', 'not found', {
          operationId: input.operationId,
        });
      }
      if (rec.status !== AIBillingOperationStatus.PRICED) {
        throw new AIBillingOperationError('INVALID_TRANSITION', 'invalid transition', {
          operationId: input.operationId,
        });
      }
      if (options.settledThrows) {
        throw new Error('mark settled boom');
      }
      rec.status = AIBillingOperationStatus.SETTLED;
      const result: MarkAIBillingOperationSettledResult = {
        operationId: input.operationId,
        reservationId: rec.reservationId,
        status: AIBillingOperationStatus.SETTLED,
        settledAt: input.settlement.settledAt,
        actualWalletTokens: input.settlement.actualTokens,
        consumeTransactionId: input.settlement.consumeTransactionId,
        idempotentReplay: false,
      };
      return result;
    },
    markAIBillingOperationReleased: async (input) => {
      calls.order.push('markReleased');
      calls.markReleasedInputs.push(input);
      if (overrides.markAIBillingOperationReleased) return overrides.markAIBillingOperationReleased(input);
      const rec = records.get(input.operationId);
      if (!rec) {
        throw new AIBillingOperationError('OPERATION_NOT_FOUND', 'not found', {
          operationId: input.operationId,
        });
      }
      if (rec.status !== AIBillingOperationStatus.NON_BILLABLE_CONFIRMED) {
        throw new AIBillingOperationError('INVALID_TRANSITION', 'invalid transition', {
          operationId: input.operationId,
        });
      }
      if (options.releasedThrows) {
        throw new Error('mark released boom');
      }
      rec.status = AIBillingOperationStatus.RELEASED;
      const result: MarkAIBillingOperationReleasedResult = {
        operationId: input.operationId,
        reservationId: rec.reservationId,
        status: AIBillingOperationStatus.RELEASED,
        releasedAt: input.release.releasedAt,
        idempotentReplay: false,
      };
      return result;
    },
    parseAIExecutionOutcome: (raw) => {
      if (overrides.parseAIExecutionOutcome) return overrides.parseAIExecutionOutcome(raw);
      return parseAIExecutionOutcome(raw);
    },
    calculateActualPrice: (input) => {
      calls.order.push('price');
      calls.priceInputs.push(input);
      if (overrides.calculateActualPrice) return overrides.calculateActualPrice(input);
      return calculateAIUsagePrice(input);
    },
    settleForAmount: async (input) => {
      calls.order.push('settle');
      calls.settleInputs.push(input);
      if (overrides.settleForAmount) return overrides.settleForAmount(input);
      const reserved = reservedByReservation.get(input.reservationId) ?? 0;
      return fakeSettle(input, reserved);
    },
    releaseReservation: async (input) => {
      calls.order.push('release');
      calls.releaseInputs.push(input);
      if (overrides.releaseReservation) return overrides.releaseReservation(input);
      return fakeRelease(input);
    },
  };

  return { deps, calls };
}

function expectSettled<T>(
  result: AIBillingOrchestrationResult<T>,
): AIBillingOrchestratorResult<T> {
  assert.ok(result.outcome === 'SETTLED', 'expected SETTLED outcome');
  return result as AIBillingOrchestratorResult<T>;
}

function expectReleased(
  result: AIBillingOrchestrationResult<unknown>,
): AIBillingOrchestratorReleasedResult {
  assert.ok(result.outcome === 'RELEASED', 'expected RELEASED outcome');
  return result as AIBillingOrchestratorReleasedResult;
}

function expectRecovery(
  result: AIBillingOrchestrationResult<unknown>,
): AIBillingOrchestratorRecoveryResult {
  assert.ok(result.outcome === 'RECOVERY_REQUIRED', 'expected RECOVERY_REQUIRED outcome');
  return result as AIBillingOrchestratorRecoveryResult;
}

// --- Success and ordering ---------------------------------------------------

test('1. Durable preflight completes before quote', async () => {
  const { deps, calls } = makeDeps();
  const input = buildInput({ execute: recordExecute(calls) });
  const result = expectSettled(await runAIBillingOrchestration(input, deps));
  assert.ok(result.outcome === 'SETTLED');
  assert.equal(calls.order[0], 'preflight');
  assert.ok(calls.order.indexOf('preflight') < calls.order.indexOf('quote'));
});

test('2. Quote is calculated before reservation', async () => {
  const { deps, calls } = makeDeps();
  const input = buildInput({ execute: recordExecute(calls) });
  await runAIBillingOrchestration(input, deps);
  assert.ok(calls.order.indexOf('quote') < calls.order.indexOf('reserve'));
});

test('3. Reservation and operation creation happen before execute', async () => {
  const { deps, calls } = makeDeps();
  const input = buildInput({ execute: recordExecute(calls) });
  await runAIBillingOrchestration(input, deps);
  assert.ok(calls.order.indexOf('reserve') < calls.order.indexOf('createOperation'));
  assert.ok(calls.order.indexOf('createOperation') < calls.order.indexOf('execute'));
});

test('4. Execute completes and execution evidence is stored before pricing', async () => {
  const { deps, calls } = makeDeps();
  const input = buildInput({ execute: recordExecute(calls) });
  await runAIBillingOrchestration(input, deps);
  assert.ok(calls.order.indexOf('execute') < calls.order.indexOf('recordExecution'));
  assert.ok(calls.order.indexOf('recordExecution') < calls.order.indexOf('price'));
});

test('5. Actual pricing evidence is stored before settlement', async () => {
  const { deps, calls } = makeDeps();
  const input = buildInput({ execute: recordExecute(calls) });
  await runAIBillingOrchestration(input, deps);
  assert.ok(calls.order.indexOf('price') < calls.order.indexOf('recordPricing'));
  assert.ok(calls.order.indexOf('recordPricing') < calls.order.indexOf('settle'));
});

test('6. Successful call order is exactly the durable flow', async () => {
  const { deps, calls } = makeDeps();
  const input = buildInput({ execute: recordExecute(calls) });
  await runAIBillingOrchestration(input, deps);
  assert.deepEqual(calls.order, [
    'preflight',
    'quote',
    'reserve',
    'createOperation',
    'execute',
    'recordExecution',
    'price',
    'recordPricing',
    'settle',
    'markSettled',
  ]);
});

test('7. Successful result preserves generic AI data', async () => {
  const input = buildInput();
  const { deps } = makeDeps();
  const result = expectSettled(await runAIBillingOrchestration(input, deps));
  assert.deepEqual(result.data, SAMPLE_DATA);
});

test('8. Reserved amount equals quote.reservationTokens', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps();
  const result = expectSettled(await runAIBillingOrchestration(input, deps));
  const quote = expectedQuote(input);
  assert.equal(calls.reserveInputs[0].tokens, quote.reservationTokens);
  assert.equal(result.billing.reservedTokens, quote.reservationTokens);
});

test('9. Settlement amount equals the pricing engine Wallet-token result', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps();
  const result = expectSettled(await runAIBillingOrchestration(input, deps));
  const price = expectedPrice(input, BASE_USAGE);
  assert.equal(calls.settleInputs[0].actualTokens, price.walletTokens);
  assert.equal(result.billing.actualTokens, price.walletTokens);
});

test('10. Released amount comes from the settlement result', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps();
  const result = expectSettled(await runAIBillingOrchestration(input, deps));
  const quote = expectedQuote(input);
  const price = expectedPrice(input, BASE_USAGE);
  assert.equal(result.billing.releasedTokens, quote.reservationTokens - price.walletTokens);
  assert.equal(result.billing.releasedTokens, quote.reservationTokens - calls.settleInputs[0].actualTokens);
});

// --- Quote and reservation failure ------------------------------------------

test('11. Quote failure performs no reservation or execution', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps({
    calculateQuote: () => {
      throw new Error('quote boom');
    },
  });
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.stage, 'QUOTE');
  assert.equal(rec.reasonCode, 'QUOTE_FAILED');
  assert.deepEqual(calls.order, ['preflight', 'quote']);
});

test('12. Reservation failure performs no execution', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps({
    reserveForAmount: async () => {
      throw new Error('reserve boom');
    },
  });
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.stage, 'RESERVATION');
  assert.equal(rec.reasonCode, 'RESERVATION_FAILED');
  assert.deepEqual(calls.order, ['preflight', 'quote', 'reserve']);
});

test('13. Reservation failure performs no settlement or release', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps({
    reserveForAmount: async () => {
      throw new Error('reserve boom');
    },
  });
  await runAIBillingOrchestration(input, deps);
  assert.ok(!calls.order.includes('settle'));
  assert.ok(!calls.order.includes('release'));
});

// --- Existing-operation replay guard ----------------------------------------

test('14. Existing RESERVED operation blocks execution', async () => {
  const { deps, calls } = makeDeps({}, { initialStatus: AIBillingOperationStatus.RESERVED });
  const input = buildInput({ execute: recordExecute(calls) });
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.stage, 'PREFLIGHT');
  assert.equal(rec.reasonCode, 'OPERATION_REPLAY_REQUIRES_RECOVERY');
  assert.equal(rec.operationStatus, AIBillingOperationStatus.RESERVED);
  assert.deepEqual(calls.order, ['preflight']);
});

test('15. Existing EXECUTION_SUCCEEDED blocks execution', async () => {
  const { deps, calls } = makeDeps({}, { initialStatus: AIBillingOperationStatus.EXECUTION_SUCCEEDED });
  const input = buildInput({ execute: recordExecute(calls) });
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.operationStatus, AIBillingOperationStatus.EXECUTION_SUCCEEDED);
  assert.deepEqual(calls.order, ['preflight']);
});

test('16. Existing PRICED blocks execution', async () => {
  const { deps, calls } = makeDeps({}, { initialStatus: AIBillingOperationStatus.PRICED });
  const input = buildInput({ execute: recordExecute(calls) });
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.operationStatus, AIBillingOperationStatus.PRICED);
  assert.deepEqual(calls.order, ['preflight']);
});

test('17. Existing SETTLED blocks execution', async () => {
  const { deps, calls } = makeDeps({}, { initialStatus: AIBillingOperationStatus.SETTLED });
  const input = buildInput({ execute: recordExecute(calls) });
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.operationStatus, AIBillingOperationStatus.SETTLED);
  assert.deepEqual(calls.order, ['preflight']);
});

test('18. Existing RELEASED blocks execution', async () => {
  const { deps, calls } = makeDeps({}, { initialStatus: AIBillingOperationStatus.RELEASED });
  const input = buildInput({ execute: recordExecute(calls) });
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.operationStatus, AIBillingOperationStatus.RELEASED);
  assert.deepEqual(calls.order, ['preflight']);
});

test('19. Existing INDETERMINATE blocks execution', async () => {
  const { deps, calls } = makeDeps({}, { initialStatus: AIBillingOperationStatus.INDETERMINATE });
  const input = buildInput({ execute: recordExecute(calls) });
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.operationStatus, AIBillingOperationStatus.INDETERMINATE);
  assert.deepEqual(calls.order, ['preflight']);
});

test('20. Existing-operation repository error does not continue as new', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps({}, { preflightError: true });
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.stage, 'PREFLIGHT');
  assert.equal(rec.reasonCode, 'OPERATION_LOOKUP_FAILED');
  assert.deepEqual(calls.order, ['preflight']);
});

test('21. Replay performs no Quote/Reserve/Execute/Price/Settle/Release', async () => {
  const { deps, calls } = makeDeps({}, { initialStatus: AIBillingOperationStatus.EXECUTION_SUCCEEDED });
  const input = buildInput({ execute: recordExecute(calls) });
  await runAIBillingOrchestration(input, deps);
  assert.deepEqual(calls.order, ['preflight']);
});

test('22. Replay result is recoveryRequired with status and reason code', async () => {
  const { deps } = makeDeps({}, { initialStatus: AIBillingOperationStatus.PRICED });
  const input = buildInput();
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.recoveryRequired, true);
  assert.equal(rec.operationId, OPERATION_ID);
  assert.equal(rec.reservationId, RESERVATION_ID);
  assert.equal(rec.stage, 'PREFLIGHT');
  assert.equal(rec.reasonCode, 'OPERATION_REPLAY_REQUIRES_RECOVERY');
});

// --- Create / race ----------------------------------------------------------

test('23. Operation creation failure blocks Execute', async () => {
  const { deps, calls } = makeDeps({}, { createThrows: true });
  const input = buildInput({ execute: recordExecute(calls) });
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.stage, 'OPERATION_CREATION');
  assert.equal(rec.reasonCode, 'OPERATION_CREATE_FAILED');
  assert.equal(rec.reservationId, RESERVATION_ID);
  assert.ok(!calls.order.includes('execute'));
});

test('24. Operation creation failure does not auto-release', async () => {
  const { deps, calls } = makeDeps({}, { createThrows: true });
  const input = buildInput();
  await runAIBillingOrchestration(input, deps);
  assert.ok(!calls.order.includes('release'));
  assert.ok(!calls.order.includes('settle'));
  assert.ok(!calls.order.includes('price'));
});

test('25. Operation idempotent replay blocks Execute', async () => {
  const { deps, calls } = makeDeps({}, { createIdempotentReplay: true });
  const input = buildInput({ execute: recordExecute(calls) });
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.stage, 'OPERATION_CREATION');
  assert.equal(rec.reasonCode, 'OPERATION_CREATE_REPLAY');
  assert.equal(rec.operationStatus, AIBillingOperationStatus.RESERVED);
  assert.ok(!calls.order.includes('execute'));
  assert.ok(!calls.order.includes('price'));
  assert.ok(!calls.order.includes('settle'));
  assert.ok(!calls.order.includes('release'));
});

test('26. Reservation replay plus newly-created operation may execute once', async () => {
  const { deps, calls } = makeDeps({}, { reserveIdempotentReplay: true });
  const input = buildInput({ execute: recordExecute(calls) });
  const result = expectSettled(await runAIBillingOrchestration(input, deps));
  assert.equal(calls.executeContexts.length, 1);
  assert.ok(result.outcome === 'SETTLED');
});

test('27. Concurrent create loser never executes AI', async () => {
  const { deps, calls } = makeDeps({}, { createIdempotentReplay: true });
  const input = buildInput({ execute: recordExecute(calls) });
  await runAIBillingOrchestration(input, deps);
  assert.equal(calls.executeContexts.length, 0);
});

test('28. operationId is stable and passed through unchanged', async () => {
  const { deps, calls } = makeDeps();
  const input = buildInput({ execute: recordExecute(calls) });
  await runAIBillingOrchestration(input, deps);
  assert.equal(calls.createInputs[0].operationId, OPERATION_ID);
  assert.equal(calls.executeContexts[0].operationId, OPERATION_ID);
  assert.equal(calls.executeContexts[0].reservationId, RESERVATION_ID);
  assert.equal(calls.getOperationIds[0], OPERATION_ID);
});

// --- SUCCESS flow -----------------------------------------------------------

test('29. Parsed SUCCESS records execution evidence', async () => {
  const { deps, calls } = makeDeps();
  const input = buildInput({ execute: recordExecute(calls) });
  await runAIBillingOrchestration(input, deps);
  assert.equal(calls.recordExecutionInputs.length, 1);
  assert.deepEqual(calls.recordExecutionInputs[0].execution, successOutcome().execution);
  assert.deepEqual(calls.recordExecutionInputs[0].usage, BASE_USAGE);
});

test('30. Execution evidence is stored before Price', async () => {
  const { deps, calls } = makeDeps();
  const input = buildInput({ execute: recordExecute(calls) });
  await runAIBillingOrchestration(input, deps);
  assert.ok(calls.order.indexOf('recordExecution') < calls.order.indexOf('price'));
});

test('31. Pricing uses canonical usage', async () => {
  const { deps, calls } = makeDeps();
  const input = buildInput({ execute: recordExecute(calls) });
  await runAIBillingOrchestration(input, deps);
  assert.deepEqual(calls.priceInputs[0].usage, BASE_USAGE);
});

test('32. Pricing evidence is stored before Settle', async () => {
  const { deps, calls } = makeDeps();
  const input = buildInput({ execute: recordExecute(calls) });
  await runAIBillingOrchestration(input, deps);
  assert.ok(calls.order.indexOf('recordPricing') < calls.order.indexOf('settle'));
});

test('33. Settle uses pricing.walletTokens', async () => {
  const { deps, calls } = makeDeps();
  const input = buildInput({ execute: recordExecute(calls) });
  await runAIBillingOrchestration(input, deps);
  const price = expectedPrice(input, BASE_USAGE);
  assert.equal(calls.settleInputs[0].actualTokens, price.walletTokens);
});

test('34. Real settlement result marks operation SETTLED', async () => {
  const { deps, calls } = makeDeps();
  const input = buildInput({ execute: recordExecute(calls) });
  const result = expectSettled(await runAIBillingOrchestration(input, deps));
  assert.equal(calls.markSettledInputs.length, 1);
  assert.equal(calls.markSettledInputs[0].settlement.consumeTransactionId, 'tx-1');
  assert.equal(result.outcome, 'SETTLED');
  assert.equal(result.recoveryRequired, false);
});

test('35. Success data is returned but not persisted as evidence', async () => {
  const { deps, calls } = makeDeps();
  const input = buildInput({ execute: recordExecute(calls) });
  const result = expectSettled(await runAIBillingOrchestration(input, deps));
  assert.deepEqual(result.data, SAMPLE_DATA);
  assert.ok(!('data' in calls.recordExecutionInputs[0]));
  assert.ok(!('data' in calls.recordPricingInputs[0]));
});

test('36. Execute called exactly once', async () => {
  const { deps, calls } = makeDeps();
  const input = buildInput({ execute: recordExecute(calls) });
  await runAIBillingOrchestration(input, deps);
  assert.equal(calls.executeContexts.length, 1);
});

// --- Usage validation -------------------------------------------------------

test('37. Actual provider mismatch blocks pricing/settlement', async () => {
  const input = buildInput({
    execute: async () => successOutcome({
      execution: { provider: 'other-provider', model: 'fake-model' },
      usage: { ...BASE_USAGE, provider: 'other-provider' },
    }),
  });
  const { deps, calls } = makeDeps();
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.stage, 'EXECUTION_EVIDENCE');
  assert.equal(rec.reasonCode, 'EXECUTION_EVIDENCE_FAILED');
  assert.ok(calls.order.includes('recordExecution'));
  assert.ok(!calls.order.includes('price'));
  assert.ok(!calls.order.includes('settle'));
  assert.ok(!calls.order.includes('release'));
});

test('38. Actual model mismatch blocks pricing/settlement', async () => {
  const input = buildInput({
    execute: async () => successOutcome({
      execution: { provider: 'fake-provider', model: 'other-model' },
      usage: { ...BASE_USAGE, model: 'other-model' },
    }),
  });
  const { deps, calls } = makeDeps();
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.stage, 'EXECUTION_EVIDENCE');
  assert.equal(rec.reasonCode, 'EXECUTION_EVIDENCE_FAILED');
  assert.ok(calls.order.includes('recordExecution'));
  assert.ok(!calls.order.includes('price'));
  assert.ok(!calls.order.includes('settle'));
  assert.ok(!calls.order.includes('release'));
});

test('39. Input usage above maxInputTokens is rejected before pricing', async () => {
  const input = buildInput({
    execute: async () => successOutcome({ usage: { ...BASE_USAGE, inputTokens: 13000 } }),
  });
  const { deps, calls } = makeDeps();
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.reasonCode, 'USAGE_LIMITS_EXCEEDED');
  assert.ok(!calls.order.includes('price'));
  assert.ok(!calls.order.includes('settle'));
  assert.ok(!calls.order.includes('release'));
});

test('40. Output usage above maxOutputTokens is rejected before pricing', async () => {
  const input = buildInput({
    execute: async () => successOutcome({ usage: { ...BASE_USAGE, outputTokens: 1300 } }),
  });
  const { deps, calls } = makeDeps();
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.reasonCode, 'USAGE_LIMITS_EXCEEDED');
  assert.ok(!calls.order.includes('price'));
});

test('40a. FIXED_FALLBACK with inputTokens above maxInputTokens is rejected before pricing', async () => {
  const input = buildInput({
    requestedMode: 'FIXED_FALLBACK',
    provider: undefined,
    model: undefined,
    execute: async () => successOutcome({ usage: { ...BASE_USAGE, inputTokens: 13000 } }),
  });
  const { deps, calls } = makeDeps();
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.stage, 'USAGE_VALIDATION');
  assert.equal(rec.reasonCode, 'USAGE_LIMITS_EXCEEDED');
  assert.equal(rec.operationStatus, AIBillingOperationStatus.EXECUTION_SUCCEEDED);
  assert.ok(calls.order.includes('recordExecution'));
  assert.ok(!calls.order.includes('price'));
  assert.ok(!calls.order.includes('settle'));
  assert.ok(!calls.order.includes('release'));
});

test('40b. FIXED_FALLBACK with outputTokens above maxOutputTokens is rejected before pricing', async () => {
  const input = buildInput({
    requestedMode: 'FIXED_FALLBACK',
    provider: undefined,
    model: undefined,
    execute: async () => successOutcome({ usage: { ...BASE_USAGE, outputTokens: 1300 } }),
  });
  const { deps, calls } = makeDeps();
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.stage, 'USAGE_VALIDATION');
  assert.equal(rec.reasonCode, 'USAGE_LIMITS_EXCEEDED');
  assert.equal(rec.operationStatus, AIBillingOperationStatus.EXECUTION_SUCCEEDED);
  assert.ok(calls.order.includes('recordExecution'));
  assert.ok(!calls.order.includes('price'));
  assert.ok(!calls.order.includes('settle'));
  assert.ok(!calls.order.includes('release'));
});

test('41. Usage validation failure does not settle or release', async () => {
  const input = buildInput({
    execute: async () => successOutcome({ usage: { ...BASE_USAGE, provider: 'other-provider' } }),
  });
  const { deps, calls } = makeDeps();
  await runAIBillingOrchestration(input, deps);
  assert.ok(!calls.order.includes('settle'));
  assert.ok(!calls.order.includes('release'));
});

test('42. Malformed SUCCESS without usage is treated conservatively as indeterminate', async () => {
  const input = buildInput({
    execute: async () => ({ kind: 'SUCCESS', data: SAMPLE_DATA }),
  });
  const { deps, calls } = makeDeps();
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.reasonCode, 'EXECUTION_OUTCOME_INVALID');
  assert.equal(calls.failureInputs[0].failure.code, 'EXECUTION_OUTCOME_INVALID');
  assert.ok(!calls.order.includes('price'));
  assert.ok(!calls.order.includes('settle'));
  assert.ok(!calls.order.includes('release'));
});

test('43. Malformed SUCCESS with invalid usage is treated conservatively as indeterminate', async () => {
  const input = buildInput({
    execute: async () => ({
      kind: 'SUCCESS',
      data: SAMPLE_DATA,
      execution: { provider: 'fake-provider', model: 'fake-model' },
      usage: { provider: 'fake-provider', model: 'fake-model', inputTokens: -5, outputTokens: 10, totalTokens: 5 },
    }),
  });
  const { deps, calls } = makeDeps();
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.reasonCode, 'EXECUTION_OUTCOME_INVALID');
  assert.equal(calls.failureInputs[0].failure.code, 'EXECUTION_OUTCOME_INVALID');
  assert.ok(!calls.order.includes('price'));
  assert.ok(!calls.order.includes('settle'));
  assert.ok(!calls.order.includes('release'));
});

test('44. totalTokens is not independently billed by the orchestrator', async () => {
  const input = buildInput({
    execute: async () => successOutcome({ usage: { ...BASE_USAGE, totalTokens: 999_999 } }),
  });
  const { deps, calls } = makeDeps({
    calculateActualPrice: () => priceResult({ walletTokens: 7 }),
  });
  const result = expectSettled(await runAIBillingOrchestration(input, deps));
  assert.equal(calls.settleInputs[0].actualTokens, 7);
  assert.equal(result.billing.actualTokens, 7);
});

// --- Pricing and settlement -------------------------------------------------

test('45. Provider usage pricing settles the actual amount', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps();
  const result = expectSettled(await runAIBillingOrchestration(input, deps));
  const price = expectedPrice(input, BASE_USAGE);
  assert.equal(result.billing.actualTokens, price.walletTokens);
  assert.equal(calls.settleInputs[0].actualTokens, price.walletTokens);
});

test('46. Fixed fallback mode reserves and settles the fixed amount', async () => {
  const input = buildInput({ requestedMode: 'FIXED_FALLBACK', provider: undefined, model: undefined });
  const { deps, calls } = makeDeps();
  const result = expectSettled(await runAIBillingOrchestration(input, deps));
  const quote = expectedQuote(input);
  assert.equal(result.billing.actualTokens, quote.reservationTokens);
  assert.equal(calls.settleInputs[0].actualTokens, quote.reservationTokens);
});

test('47. Partial settlement returns unused reservation', async () => {
  const input = buildInput();
  const { deps } = makeDeps();
  const result = expectSettled(await runAIBillingOrchestration(input, deps));
  const quote = expectedQuote(input);
  const price = expectedPrice(input, BASE_USAGE);
  assert.equal(result.billing.reservedTokens, quote.reservationTokens);
  assert.ok(result.billing.releasedTokens > 0);
  assert.equal(result.billing.releasedTokens, quote.reservationTokens - price.walletTokens);
});

test('48. Full settlement returns zero unused tokens', async () => {
  const input = buildInput({ requestedMode: 'FIXED_FALLBACK', provider: undefined, model: undefined });
  const { deps } = makeDeps();
  const result = expectSettled(await runAIBillingOrchestration(input, deps));
  assert.equal(result.billing.actualTokens, expectedQuote(input).reservationTokens);
  assert.equal(result.billing.releasedTokens, 0);
});

test('49. Zero actual price is passed unchanged to settlement', async () => {
  const zeroRate = rateCard({ inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 });
  const zeroPolicy = policy({ minimumWalletTokens: 0 });
  const input = buildInput({ rateCard: zeroRate, walletPolicy: zeroPolicy });
  const { deps, calls } = makeDeps();
  const result = expectSettled(await runAIBillingOrchestration(input, deps));
  assert.equal(result.billing.actualTokens, 0);
  assert.equal(calls.settleInputs[0].actualTokens, 0);
  assert.equal(result.billing.releasedTokens, expectedQuote(input).reservationTokens);
});

test('50. Actual price above reservation is rejected before settlement', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps({
    calculateActualPrice: () => priceResult({ walletTokens: 999_999 }),
  });
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.stage, 'PRICING');
  assert.equal(rec.reasonCode, 'PRICING_LIMITS_EXCEEDED');
  assert.ok(!calls.order.includes('settle'));
  assert.ok(!calls.order.includes('release'));
});

test('51. Pricing failure after execution evidence does not release', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps({
    calculateActualPrice: () => {
      throw new Error('price boom');
    },
  });
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.stage, 'PRICING');
  assert.equal(rec.reasonCode, 'PRICING_FAILED');
  assert.equal(rec.operationStatus, AIBillingOperationStatus.EXECUTION_SUCCEEDED);
  assert.ok(!calls.order.includes('release'));
  assert.ok(!calls.order.includes('settle'));
});

test('52. Settlement failure after pricing evidence does not release', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps({
    settleForAmount: async () => {
      throw new Error('settle boom');
    },
  });
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.stage, 'SETTLEMENT');
  assert.equal(rec.reasonCode, 'SETTLEMENT_FAILED');
  assert.equal(rec.operationStatus, AIBillingOperationStatus.PRICED);
  assert.ok(!calls.order.includes('release'));
});

test('53. Settlement result is the source of actual/released values', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps();
  const result = expectSettled(await runAIBillingOrchestration(input, deps));
  const quote = expectedQuote(input);
  assert.equal(result.billing.actualTokens, calls.settleInputs[0].actualTokens);
  assert.equal(result.billing.releasedTokens, quote.reservationTokens - calls.settleInputs[0].actualTokens);
  assert.equal(result.billing.reservedTokens, quote.reservationTokens);
  assert.equal(result.billing.consumeTransactionId, 'tx-1');
});

// --- Snapshot consistency ---------------------------------------------------

test('54. Quote and actual pricing receive the same rate-card snapshot', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps();
  await runAIBillingOrchestration(input, deps);
  assert.strictEqual(calls.quoteInputs[0].rateCard, calls.priceInputs[0].rateCard);
});

test('55. Quote and actual pricing receive the same Wallet-policy snapshot', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps();
  await runAIBillingOrchestration(input, deps);
  assert.strictEqual(calls.quoteInputs[0].walletPolicy, calls.priceInputs[0].walletPolicy);
});

test('56. Quote receives a frozen independent Chat limits snapshot', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps();
  await runAIBillingOrchestration(input, deps);
  assert.notStrictEqual(calls.quoteInputs[0].chatLimits, input.chatLimits);
  assert.ok(Object.isFrozen(calls.quoteInputs[0].chatLimits));
  assert.deepEqual(calls.quoteInputs[0].chatLimits, input.chatLimits);
});

test('57. Mutating the original rateCard during execute does not affect pricing', async () => {
  const myRate = rateCard();
  const input = buildInput({
    rateCard: myRate,
    execute: async () => {
      myRate[0].inputMicrosPerMillionTokens = 999_999_999;
      return successOutcome();
    },
  });
  const { deps } = makeDeps();
  const result = expectSettled(await runAIBillingOrchestration(input, deps));
  assert.equal(result.billing.actualTokens, 30);
});

test('58. Mutating the original Wallet policy during execute does not affect pricing', async () => {
  const myPolicy = policy();
  const input = buildInput({
    walletPolicy: myPolicy,
    execute: async () => {
      myPolicy.minimumWalletTokens = 999_999;
      return successOutcome();
    },
  });
  const { deps } = makeDeps();
  const result = expectSettled(await runAIBillingOrchestration(input, deps));
  assert.equal(result.billing.actualTokens, 30);
});

test('59. Mutating the original Chat limits during execute does not affect quote validation', async () => {
  const myLimits = chatLimits();
  const input = buildInput({
    chatLimits: myLimits,
    execute: async () => {
      myLimits.maxInputTokens = 1;
      return successOutcome();
    },
  });
  const { deps, calls } = makeDeps();
  const result = expectSettled(await runAIBillingOrchestration(input, deps));
  assert.equal(calls.quoteInputs[0].chatLimits.maxInputTokens, 12000);
  assert.equal(result.billing.actualTokens, 30);
});

test('60. Caller input is not mutated', async () => {
  const myRate = rateCard();
  const myPolicy = policy();
  const myLimits = chatLimits();
  const originalRate = myRate.map((r) => ({ ...r }));
  const originalPolicy = { ...myPolicy };
  const originalLimits = { ...myLimits };
  const input = buildInput({ rateCard: myRate, walletPolicy: myPolicy, chatLimits: myLimits });
  const { deps } = makeDeps();
  await runAIBillingOrchestration(input, deps);
  assert.deepEqual(input.rateCard, originalRate);
  assert.deepEqual(input.walletPolicy, originalPolicy);
  assert.deepEqual(input.chatLimits, originalLimits);
});

test('61. Rate-card entries are not mutated', async () => {
  const input = buildInput();
  const originalRate = input.rateCard.map((r) => ({ ...r }));
  const { deps } = makeDeps();
  await runAIBillingOrchestration(input, deps);
  assert.deepEqual(input.rateCard, originalRate);
});

test('62. Wallet policy is not mutated', async () => {
  const input = buildInput();
  const originalPolicy = { ...input.walletPolicy };
  const { deps } = makeDeps();
  await runAIBillingOrchestration(input, deps);
  assert.deepEqual(input.walletPolicy, originalPolicy);
});

test('63. Repeated orchestrations use independent snapshot objects', async () => {
  const firstInput = buildInput();
  const { deps: deps1, calls: calls1 } = makeDeps();
  await runAIBillingOrchestration(firstInput, deps1);

  const secondInput = buildInput();
  const { deps: deps2, calls: calls2 } = makeDeps();
  await runAIBillingOrchestration(secondInput, deps2);

  assert.notStrictEqual(calls1.quoteInputs[0].rateCard, calls2.quoteInputs[0].rateCard);
  assert.notStrictEqual(calls1.quoteInputs[0].rateCard[0], calls2.quoteInputs[0].rateCard[0]);
  assert.notStrictEqual(calls1.quoteInputs[0].walletPolicy, calls2.quoteInputs[0].walletPolicy);
  assert.notStrictEqual(calls1.quoteInputs[0].chatLimits, calls2.quoteInputs[0].chatLimits);
});

// --- Metadata -------------------------------------------------------------

function metadataOf(inputs: ReserveBusinessTokensForAmountInput[]): AIBillingReservationMetadata {
  const meta = inputs[0].metadata as AIBillingReservationMetadata;
  assert.ok(meta && typeof meta === 'object');
  return meta;
}

test('64. Reservation metadata contains sanitized aiBilling snapshot', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps();
  await runAIBillingOrchestration(input, deps);
  const meta = metadataOf(calls.reserveInputs);
  assert.equal(meta.aiBilling.schemaVersion, 1);
  assert.equal(meta.aiBilling.requestedMode, 'PROVIDER_USAGE');
  assert.equal(meta.aiBilling.quoteAppliedMode, 'PROVIDER_USAGE');
  assert.equal(meta.aiBilling.maxInputTokens, 12000);
  assert.equal(meta.aiBilling.maxOutputTokens, 1200);
  assert.equal(meta.aiBilling.provider, 'fake-provider');
  assert.equal(meta.aiBilling.model, 'fake-model');
});

test('65. Metadata contains quotedTokens and versions', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps();
  const result = expectSettled(await runAIBillingOrchestration(input, deps));
  const meta = metadataOf(calls.reserveInputs);
  assert.equal(meta.aiBilling.quotedTokens, result.billing.reservedTokens);
  assert.equal(meta.aiBilling.rateCardVersion, 'rate-v1');
  assert.equal(meta.aiBilling.walletPolicyVersion, 'policy-v1');
  assert.equal(meta.aiBilling.maximumUsageWalletTokens, 13200);
});

test('66. Metadata omits full rate card and Wallet policy', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps();
  await runAIBillingOrchestration(input, deps);
  const serialized = JSON.stringify(calls.reserveInputs[0].metadata);
  assert.ok(!serialized.includes('inputMicrosPerMillionTokens'));
  assert.ok(!serialized.includes('outputMicrosPerMillionTokens'));
  assert.ok(!serialized.includes('walletTokenValueMicros'));
  assert.ok(!serialized.includes('markupBasisPoints'));
  assert.ok(!serialized.includes('"rateCard"'));
  assert.ok(!serialized.includes('"walletPolicy"'));
});

test('67. Metadata omits prompts, AI response, and raw usage', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps();
  await runAIBillingOrchestration(input, deps);
  const serialized = JSON.stringify(calls.reserveInputs[0].metadata);
  assert.ok(!serialized.includes('prompt'));
  assert.ok(!serialized.includes('message'));
  assert.ok(!serialized.includes('"data"'));
  assert.ok(!serialized.includes('"usage"'));
});

test('68. reservation.pricingVersion is not replaced by a rate-card version', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps();
  await runAIBillingOrchestration(input, deps);
  assert.ok(!('pricingVersion' in calls.reserveInputs[0]));
  assert.equal(calls.reserveInputs[0].tokens, 13200);
  const meta = metadataOf(calls.reserveInputs);
  assert.equal(meta.aiBilling.rateCardVersion, 'rate-v1');
});

// --- Fixed mode -------------------------------------------------------------

test('69. Fixed mode does not require provider/model', async () => {
  const input = buildInput({ requestedMode: 'FIXED_FALLBACK', provider: undefined, model: undefined });
  const { deps } = makeDeps();
  const result = expectSettled(await runAIBillingOrchestration(input, deps));
  assert.equal(result.billing.appliedMode, 'FIXED_FALLBACK');
});

test('70. Fixed mode does not switch to provider pricing because usage exists', async () => {
  const input = buildInput({
    requestedMode: 'FIXED_FALLBACK',
    provider: undefined,
    model: undefined,
    execute: async () => successOutcome(),
  });
  const { deps } = makeDeps();
  const result = expectSettled(await runAIBillingOrchestration(input, deps));
  assert.equal(result.billing.appliedMode, 'FIXED_FALLBACK');
  assert.equal(result.billing.actualTokens, expectedQuote(input).reservationTokens);
});

// --- Separation -------------------------------------------------------------

const serviceSource = readFileSync(
  new URL('../src/services/ai-billing-orchestrator.service.ts', import.meta.url),
  'utf8',
);

test('71. Orchestrator performs no direct Prisma call', () => {
  assert.ok(!serviceSource.includes('@prisma/client'));
  assert.ok(!/prisma\./.test(serviceSource));
});

test('72. Orchestrator performs no direct HTTP call', () => {
  assert.ok(!serviceSource.includes('node:http'));
  assert.ok(!serviceSource.includes('node:https'));
  assert.ok(!serviceSource.includes('fetch('));
});

test('73. Orchestrator performs no direct AI call except the supplied callback', () => {
  assert.ok(!serviceSource.includes('@google/generative-ai'));
  assert.ok(!serviceSource.includes('gemini'));
});

test('74. Orchestrator contains no Wallet arithmetic', () => {
  assert.ok(!serviceSource.includes('tokenBalance'));
  assert.ok(!serviceSource.includes('reservedBalance'));
  assert.ok(!serviceSource.includes('availableBalance'));
});

test('75. Orchestrator contains no duplicated provider pricing formula', () => {
  assert.ok(!serviceSource.includes('inputMicrosPerMillionTokens'));
  assert.ok(!serviceSource.includes('outputMicrosPerMillionTokens'));
  assert.ok(!serviceSource.includes('providerCostMicros'));
  assert.ok(!serviceSource.includes('microsPerMillion'));
});

test('76. No hardcoded reservation ceiling exists', () => {
  assert.ok(!/ceiling/i.test(serviceSource));
  assert.ok(!serviceSource.includes('MAX_RESERVATION'));
  assert.ok(!serviceSource.includes('> 8'));
});

test('77. A quote above 8 is passed unchanged to variable reservation', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps();
  const result = expectSettled(await runAIBillingOrchestration(input, deps));
  const quote = expectedQuote(input);
  assert.ok(quote.reservationTokens > 8);
  assert.equal(calls.reserveInputs[0].tokens, quote.reservationTokens);
  assert.equal(result.billing.reservedTokens, quote.reservationTokens);
});

test('78. Result exposes no wallet balance or secret fields', async () => {
  const input = buildInput();
  const { deps } = makeDeps();
  const result = expectSettled(await runAIBillingOrchestration(input, deps));
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('availableBalance'));
  assert.ok(!serialized.includes('reservedBalance'));
  assert.ok(!serialized.includes('apiKey'));
  assert.ok(!serialized.includes('secret'));
  assert.ok(!('walletId' in result.billing));
});

test('79. Recovery results expose no raw error text', async () => {
  const input = buildInput();
  const { deps } = makeDeps({
    calculateQuote: () => {
      throw new Error('quote boom');
    },
  });
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  const serialized = JSON.stringify(rec);
  assert.ok(!serialized.includes('quote boom'));
  assert.ok(!serialized.includes('rateCard'));
  assert.ok(!serialized.includes('walletPolicy'));
  assert.ok(!serialized.includes('prompt'));
  assert.ok(!serialized.includes('stack'));
});

test('80. Successful result returns a fresh quote object', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps();
  const result = expectSettled(await runAIBillingOrchestration(input, deps));
  assert.notStrictEqual(result.quote, calls.quoteInputs[0]);
  assert.deepEqual(result.quote, expectedQuote(input));
});

// --- Fallback quote behavior -------------------------------------------------

test('81. RATE_CARD_NOT_FOUND quote followed by usage from another priced model is rejected', async () => {
  const input = buildInput({
    rateCard: [{ ...BASE_RATE, model: 'other-model', version: 'rate-other' }],
    execute: async () => successOutcome({
      execution: { provider: 'fake-provider', model: 'other-model' },
      usage: { provider: 'fake-provider', model: 'other-model', inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    }),
  });
  const quote = expectedQuote(input);
  assert.equal(quote.appliedMode, 'FIXED_FALLBACK');
  assert.equal(quote.fallbackReason, 'RATE_CARD_NOT_FOUND');
  const { deps, calls } = makeDeps();
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.stage, 'EXECUTION_EVIDENCE');
  assert.equal(rec.reasonCode, 'EXECUTION_EVIDENCE_FAILED');
  assert.ok(!calls.order.includes('price'));
  assert.ok(!calls.order.includes('settle'));
  assert.ok(!calls.order.includes('release'));
});

test('82. RATE_CARD_NOT_FOUND quote followed by usage from another provider is rejected', async () => {
  const input = buildInput({
    rateCard: [{ ...BASE_RATE, provider: 'other-provider', version: 'rate-other' }],
    execute: async () => successOutcome({
      execution: { provider: 'other-provider', model: 'fake-model' },
      usage: { provider: 'other-provider', model: 'fake-model', inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    }),
  });
  const quote = expectedQuote(input);
  assert.equal(quote.appliedMode, 'FIXED_FALLBACK');
  assert.equal(quote.fallbackReason, 'RATE_CARD_NOT_FOUND');
  const { deps, calls } = makeDeps();
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.stage, 'EXECUTION_EVIDENCE');
  assert.equal(rec.reasonCode, 'EXECUTION_EVIDENCE_FAILED');
  assert.ok(!calls.order.includes('price'));
  assert.ok(!calls.order.includes('settle'));
  assert.ok(!calls.order.includes('release'));
});

test('83. RATE_CARD_NOT_FOUND quote still enforces maxInputTokens', async () => {
  const input = buildInput({
    rateCard: [{ ...BASE_RATE, model: 'other-model', version: 'rate-other' }],
    execute: async () => successOutcome({
      usage: { ...BASE_USAGE, inputTokens: 13000, totalTokens: 13020 },
    }),
  });
  const quote = expectedQuote(input);
  assert.equal(quote.appliedMode, 'FIXED_FALLBACK');
  assert.equal(quote.fallbackReason, 'RATE_CARD_NOT_FOUND');
  const { deps, calls } = makeDeps();
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.reasonCode, 'USAGE_LIMITS_EXCEEDED');
  assert.ok(!calls.order.includes('price'));
  assert.ok(!calls.order.includes('settle'));
  assert.ok(!calls.order.includes('release'));
});

test('84. RATE_CARD_NOT_FOUND quote still enforces maxOutputTokens', async () => {
  const input = buildInput({
    rateCard: [{ ...BASE_RATE, model: 'other-model', version: 'rate-other' }],
    execute: async () => successOutcome({
      usage: { ...BASE_USAGE, outputTokens: 1300, totalTokens: 1310 },
    }),
  });
  const quote = expectedQuote(input);
  assert.equal(quote.appliedMode, 'FIXED_FALLBACK');
  assert.equal(quote.fallbackReason, 'RATE_CARD_NOT_FOUND');
  const { deps, calls } = makeDeps();
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.reasonCode, 'USAGE_LIMITS_EXCEEDED');
  assert.ok(!calls.order.includes('price'));
  assert.ok(!calls.order.includes('settle'));
  assert.ok(!calls.order.includes('release'));
});

test('85. Valid normalized usage is provider-priced, not treated as USAGE_INVALID', async () => {
  const input = buildInput({
    execute: async () => successOutcome({
      usage: { provider: 'fake-provider', model: 'fake-model', input_tokens: 10, output_tokens: 20, total_tokens: 30 },
    }),
  });
  const { deps } = makeDeps();
  const result = expectSettled(await runAIBillingOrchestration(input, deps));
  assert.equal(result.billing.appliedMode, 'PROVIDER_USAGE');
  assert.equal(result.billing.fallbackReason, undefined);
  assert.equal(result.billing.actualTokens, 30);
});
