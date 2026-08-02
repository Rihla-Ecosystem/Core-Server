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
  AIBillingOrchestratorRecoveryResult,
  AIBillingOrchestratorReleasedResult,
  AIBillingOrchestratorResult,
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

// --- Preflight / replay -----------------------------------------------------

test('1. New operation proceeds', async () => {
  const { deps, calls } = makeDeps();
  const input = buildInput({ execute: recordExecute(calls) });
  const result = expectSettled(await runAIBillingOrchestration(input, deps));
  assert.equal(result.operationId, OPERATION_ID);
  assert.equal(result.reservationId, RESERVATION_ID);
});

test('2. Existing RESERVED operation blocks execution', async () => {
  const { deps, calls } = makeDeps({}, { initialStatus: AIBillingOperationStatus.RESERVED });
  const input = buildInput({ execute: recordExecute(calls) });
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.stage, 'PREFLIGHT');
  assert.equal(rec.reasonCode, 'OPERATION_REPLAY_REQUIRES_RECOVERY');
  assert.equal(rec.operationStatus, AIBillingOperationStatus.RESERVED);
  assert.deepEqual(calls.order, ['preflight']);
});

test('3. Existing EXECUTION_SUCCEEDED blocks execution', async () => {
  const { deps, calls } = makeDeps({}, { initialStatus: AIBillingOperationStatus.EXECUTION_SUCCEEDED });
  const input = buildInput({ execute: recordExecute(calls) });
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.operationStatus, AIBillingOperationStatus.EXECUTION_SUCCEEDED);
  assert.deepEqual(calls.order, ['preflight']);
});

test('4. Existing PRICED blocks execution', async () => {
  const { deps, calls } = makeDeps({}, { initialStatus: AIBillingOperationStatus.PRICED });
  const input = buildInput({ execute: recordExecute(calls) });
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.operationStatus, AIBillingOperationStatus.PRICED);
  assert.deepEqual(calls.order, ['preflight']);
});

test('5. Existing SETTLED blocks execution', async () => {
  const { deps, calls } = makeDeps({}, { initialStatus: AIBillingOperationStatus.SETTLED });
  const input = buildInput({ execute: recordExecute(calls) });
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.operationStatus, AIBillingOperationStatus.SETTLED);
  assert.deepEqual(calls.order, ['preflight']);
});

test('6. Existing RELEASED blocks execution', async () => {
  const { deps, calls } = makeDeps({}, { initialStatus: AIBillingOperationStatus.RELEASED });
  const input = buildInput({ execute: recordExecute(calls) });
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.operationStatus, AIBillingOperationStatus.RELEASED);
  assert.deepEqual(calls.order, ['preflight']);
});

test('7. Existing INDETERMINATE blocks execution', async () => {
  const { deps, calls } = makeDeps({}, { initialStatus: AIBillingOperationStatus.INDETERMINATE });
  const input = buildInput({ execute: recordExecute(calls) });
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.operationStatus, AIBillingOperationStatus.INDETERMINATE);
  assert.deepEqual(calls.order, ['preflight']);
});

test('8. Existing-operation repository error does not continue as new', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps({}, { preflightError: true });
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.stage, 'PREFLIGHT');
  assert.equal(rec.reasonCode, 'OPERATION_LOOKUP_FAILED');
  assert.deepEqual(calls.order, ['preflight']);
});

test('9. Replay performs no Quote/Reserve/Execute/Price/Settle/Release', async () => {
  const { deps, calls } = makeDeps({}, { initialStatus: AIBillingOperationStatus.SETTLED });
  const input = buildInput({ execute: recordExecute(calls) });
  await runAIBillingOrchestration(input, deps);
  assert.deepEqual(calls.order, ['preflight']);
});

test('10. Replay result is recoveryRequired', async () => {
  const { deps } = makeDeps({}, { initialStatus: AIBillingOperationStatus.RELEASED });
  const input = buildInput();
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.recoveryRequired, true);
  assert.equal(rec.operationId, OPERATION_ID);
});

// --- Create / race ----------------------------------------------------------

test('11. Quote occurs before Reserve', async () => {
  const { deps, calls } = makeDeps();
  const input = buildInput({ execute: recordExecute(calls) });
  await runAIBillingOrchestration(input, deps);
  assert.ok(calls.order.indexOf('quote') < calls.order.indexOf('reserve'));
});

test('12. Reserve occurs before operation creation', async () => {
  const { deps, calls } = makeDeps();
  const input = buildInput({ execute: recordExecute(calls) });
  await runAIBillingOrchestration(input, deps);
  assert.ok(calls.order.indexOf('reserve') < calls.order.indexOf('createOperation'));
});

test('13. Operation is created before Execute', async () => {
  const { deps, calls } = makeDeps();
  const input = buildInput({ execute: recordExecute(calls) });
  await runAIBillingOrchestration(input, deps);
  assert.ok(calls.order.indexOf('createOperation') < calls.order.indexOf('execute'));
});

test('14. Operation creation failure blocks Execute', async () => {
  const { deps, calls } = makeDeps({}, { createThrows: true });
  const input = buildInput({ execute: recordExecute(calls) });
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.stage, 'OPERATION_CREATION');
  assert.equal(rec.reasonCode, 'OPERATION_CREATE_FAILED');
  assert.equal(rec.reservationId, RESERVATION_ID);
  assert.equal(calls.executeContexts.length, 0);
});

test('15. Operation creation failure does not auto-release', async () => {
  const { deps, calls } = makeDeps({}, { createThrows: true });
  const input = buildInput();
  await runAIBillingOrchestration(input, deps);
  assert.ok(!calls.order.includes('release'));
  assert.ok(!calls.order.includes('settle'));
  assert.ok(!calls.order.includes('price'));
});

test('16. Operation idempotent replay blocks Execute', async () => {
  const { deps, calls } = makeDeps({}, { createIdempotentReplay: true });
  const input = buildInput({ execute: recordExecute(calls) });
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.stage, 'OPERATION_CREATION');
  assert.equal(rec.reasonCode, 'OPERATION_CREATE_REPLAY');
  assert.equal(rec.operationStatus, AIBillingOperationStatus.RESERVED);
  assert.equal(calls.executeContexts.length, 0);
});

test('17. Reservation replay plus newly-created operation may execute once', async () => {
  const { deps, calls } = makeDeps({}, { reserveIdempotentReplay: true });
  const input = buildInput({ execute: recordExecute(calls) });
  const result = expectSettled(await runAIBillingOrchestration(input, deps));
  assert.equal(calls.executeContexts.length, 1);
  assert.equal(result.outcome, 'SETTLED');
});

test('18. Concurrent create loser never executes AI', async () => {
  const { deps, calls } = makeDeps({}, { createIdempotentReplay: true });
  const input = buildInput({ execute: recordExecute(calls) });
  await runAIBillingOrchestration(input, deps);
  assert.equal(calls.executeContexts.length, 0);
});

test('19. operationId is stable and passed through unchanged', async () => {
  const { deps, calls } = makeDeps();
  const input = buildInput({ execute: recordExecute(calls) });
  await runAIBillingOrchestration(input, deps);
  assert.equal(calls.getOperationIds[0], OPERATION_ID);
  assert.equal(calls.createInputs[0].operationId, OPERATION_ID);
  assert.equal(calls.executeContexts[0].operationId, OPERATION_ID);
  assert.equal(calls.executeContexts[0].reservationId, RESERVATION_ID);
});

// --- SUCCESS flow -----------------------------------------------------------

test('20. Parsed SUCCESS records execution evidence', async () => {
  const { deps, calls } = makeDeps();
  const input = buildInput({ execute: recordExecute(calls) });
  await runAIBillingOrchestration(input, deps);
  assert.equal(calls.recordExecutionInputs.length, 1);
  assert.deepEqual(calls.recordExecutionInputs[0].execution, successOutcome().execution);
  assert.deepEqual(calls.recordExecutionInputs[0].usage, BASE_USAGE);
});

test('21. Execution evidence is stored before Price', async () => {
  const { deps, calls } = makeDeps();
  const input = buildInput({ execute: recordExecute(calls) });
  await runAIBillingOrchestration(input, deps);
  assert.ok(calls.order.indexOf('recordExecution') < calls.order.indexOf('price'));
});

test('22. Pricing uses canonical usage', async () => {
  const { deps, calls } = makeDeps();
  const input = buildInput({ execute: recordExecute(calls) });
  await runAIBillingOrchestration(input, deps);
  assert.deepEqual(calls.priceInputs[0].usage, BASE_USAGE);
});

test('23. Pricing evidence is stored before Settle', async () => {
  const { deps, calls } = makeDeps();
  const input = buildInput({ execute: recordExecute(calls) });
  await runAIBillingOrchestration(input, deps);
  assert.ok(calls.order.indexOf('recordPricing') < calls.order.indexOf('settle'));
});

test('24. Settle uses pricing.walletTokens', async () => {
  const { deps, calls } = makeDeps();
  const input = buildInput({ execute: recordExecute(calls) });
  await runAIBillingOrchestration(input, deps);
  const price = expectedPrice(input, BASE_USAGE);
  assert.equal(calls.settleInputs[0].actualTokens, price.walletTokens);
});

test('25. Real settlement result marks operation SETTLED', async () => {
  const { deps, calls } = makeDeps();
  const input = buildInput({ execute: recordExecute(calls) });
  const result = expectSettled(await runAIBillingOrchestration(input, deps));
  assert.equal(calls.markSettledInputs.length, 1);
  assert.equal(calls.markSettledInputs[0].settlement.consumeTransactionId, 'tx-1');
  assert.equal(result.outcome, 'SETTLED');
  assert.equal(result.recoveryRequired, false);
  assert.equal(result.settlement.consumeTransactionId, 'tx-1');
});

test('26. Success data is returned but not persisted as evidence', async () => {
  const { deps, calls } = makeDeps();
  const input = buildInput({ execute: recordExecute(calls) });
  const result = expectSettled(await runAIBillingOrchestration(input, deps));
  assert.deepEqual(result.data, SAMPLE_DATA);
  assert.ok(!('data' in calls.recordExecutionInputs[0]));
  assert.ok(!('data' in calls.recordPricingInputs[0]));
});

test('27. Execute called exactly once', async () => {
  const { deps, calls } = makeDeps();
  const input = buildInput({ execute: recordExecute(calls) });
  await runAIBillingOrchestration(input, deps);
  assert.equal(calls.executeContexts.length, 1);
});

test('28. Actual provider mismatch blocks pricing/settlement', async () => {
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

test('29. Actual model mismatch blocks pricing/settlement', async () => {
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

test('30. Invalid usage blocks pricing/settlement/release', async () => {
  const input = buildInput({
    execute: async () => successOutcome({ usage: { ...BASE_USAGE, inputTokens: 13000, totalTokens: 13020 } }),
  });
  const { deps, calls } = makeDeps();
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.reasonCode, 'USAGE_LIMITS_EXCEEDED');
  assert.equal(rec.stage, 'USAGE_VALIDATION');
  assert.equal(rec.operationStatus, AIBillingOperationStatus.EXECUTION_SUCCEEDED);
  assert.ok(calls.order.includes('recordExecution'));
  assert.ok(!calls.order.includes('price'));
  assert.ok(!calls.order.includes('settle'));
  assert.ok(!calls.order.includes('release'));
});

test('30a. recordExecution occurs before usage-limit validation', async () => {
  const input = buildInput({
    execute: async () => successOutcome({ usage: { ...BASE_USAGE, outputTokens: 1300, totalTokens: 1310 } }),
  });
  const { deps, calls } = makeDeps();
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.reasonCode, 'USAGE_LIMITS_EXCEEDED');
  assert.equal(rec.operationStatus, AIBillingOperationStatus.EXECUTION_SUCCEEDED);
  assert.ok(calls.order.includes('recordExecution'));
  assert.ok(!calls.order.includes('price'));
  assert.equal(calls.recordExecutionInputs.length, 1);
  assert.deepEqual(calls.recordExecutionInputs[0].usage, { ...BASE_USAGE, outputTokens: 1300, totalTokens: 1310 });
});

test('30b. FIXED_FALLBACK with inputTokens above maxInputTokens records execution first', async () => {
  const input = buildInput({
    requestedMode: 'FIXED_FALLBACK',
    provider: undefined,
    model: undefined,
    execute: async () => successOutcome({ usage: { ...BASE_USAGE, inputTokens: 13000, totalTokens: 13020 } }),
  });
  const { deps, calls } = makeDeps();
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.reasonCode, 'USAGE_LIMITS_EXCEEDED');
  assert.equal(rec.stage, 'USAGE_VALIDATION');
  assert.equal(rec.operationStatus, AIBillingOperationStatus.EXECUTION_SUCCEEDED);
  assert.ok(calls.order.includes('recordExecution'));
  assert.ok(!calls.order.includes('price'));
  assert.ok(!calls.order.includes('recordPricing'));
  assert.ok(!calls.order.includes('settle'));
  assert.ok(!calls.order.includes('release'));
});

test('30c. FIXED_FALLBACK with outputTokens above maxOutputTokens records execution first', async () => {
  const input = buildInput({
    requestedMode: 'FIXED_FALLBACK',
    provider: undefined,
    model: undefined,
    execute: async () => successOutcome({ usage: { ...BASE_USAGE, outputTokens: 1300, totalTokens: 1310 } }),
  });
  const { deps, calls } = makeDeps();
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.reasonCode, 'USAGE_LIMITS_EXCEEDED');
  assert.equal(rec.stage, 'USAGE_VALIDATION');
  assert.equal(rec.operationStatus, AIBillingOperationStatus.EXECUTION_SUCCEEDED);
  assert.ok(calls.order.includes('recordExecution'));
  assert.ok(!calls.order.includes('price'));
  assert.ok(!calls.order.includes('recordPricing'));
  assert.ok(!calls.order.includes('settle'));
  assert.ok(!calls.order.includes('release'));
});

test('30d. Valid FIXED_FALLBACK still prices and settles normally', async () => {
  const input = buildInput({ requestedMode: 'FIXED_FALLBACK', provider: undefined, model: undefined });
  const { deps, calls } = makeDeps();
  const result = expectSettled(await runAIBillingOrchestration(input, deps));
  assert.equal(result.outcome, 'SETTLED');
  assert.ok(calls.order.includes('recordExecution'));
  assert.ok(calls.order.includes('price'));
  assert.ok(calls.order.includes('recordPricing'));
  assert.ok(calls.order.includes('settle'));
  assert.ok(!calls.order.includes('release'));
});

test('31. actualWalletTokens above reserved blocks settlement', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps({
    calculateActualPrice: () => priceResult({ walletTokens: 999_999 }),
  });
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.stage, 'PRICING');
  assert.equal(rec.reasonCode, 'PRICING_LIMITS_EXCEEDED');
  assert.ok(!calls.order.includes('settle'));
});

test('32. Execution-evidence write failure blocks pricing', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps({}, { executionThrows: true });
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.stage, 'EXECUTION_EVIDENCE');
  assert.equal(rec.reasonCode, 'EXECUTION_EVIDENCE_FAILED');
  assert.ok(!calls.order.includes('price'));
  assert.ok(!calls.order.includes('settle'));
  assert.ok(!calls.order.includes('release'));
});

test('33. Pricing failure leaves operation after execution evidence', async () => {
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
  assert.ok(calls.order.includes('recordExecution'));
  assert.ok(!calls.order.includes('settle'));
  assert.ok(!calls.order.includes('release'));
});

test('34. Pricing-evidence write failure blocks settlement', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps({}, { pricingThrows: true });
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.stage, 'PRICING_EVIDENCE');
  assert.equal(rec.reasonCode, 'PRICING_EVIDENCE_FAILED');
  assert.ok(!calls.order.includes('settle'));
  assert.ok(!calls.order.includes('release'));
});

test('35. Settlement failure leaves PRICED evidence', async () => {
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
  assert.ok(calls.order.includes('recordPricing'));
  assert.ok(!calls.order.includes('release'));
});

test('36. Final SETTLED marking failure does not settle again', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps({}, { settledThrows: true });
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.stage, 'SETTLED_EVIDENCE');
  assert.equal(rec.reasonCode, 'SETTLED_EVIDENCE_FAILED');
  assert.equal(rec.operationStatus, AIBillingOperationStatus.PRICED);
  assert.equal(calls.settleInputs.length, 1);
});

test('37. Zero-token actual settlement remains supported', async () => {
  const zeroRate = rateCard({ inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 });
  const zeroPolicy = policy({ minimumWalletTokens: 0 });
  const input = buildInput({ rateCard: zeroRate, walletPolicy: zeroPolicy });
  const { deps, calls } = makeDeps();
  const result = expectSettled(await runAIBillingOrchestration(input, deps));
  assert.equal(result.actualWalletTokens, 0);
  assert.equal(calls.settleInputs[0].actualTokens, 0);
  assert.equal(calls.markSettledInputs[0].settlement.actualTokens, 0);
});

test('38. Fixed fallback pricing result is persisted exactly when returned by pricing engine', async () => {
  const customPrice = priceResult({ walletTokens: 7, appliedMode: 'FIXED_FALLBACK', fallbackReason: 'USAGE_MISSING' });
  const input = buildInput();
  const { deps, calls } = makeDeps({
    calculateActualPrice: () => customPrice,
  });
  await runAIBillingOrchestration(input, deps);
  assert.deepEqual(calls.recordPricingInputs[0].pricing, customPrice);
});

// --- Requested identity preflight validation ---------------------------------

function validCreateResult(
  overrides: Partial<CreateAIBillingOperationResult> = {},
): CreateAIBillingOperationResult {
  return {
    ...buildCreateResult(
      OPERATION_ID,
      RESERVATION_ID,
      AIBillingOperationStatus.RESERVED,
      false,
      13200,
      BUSINESS_TOKEN_PRICING_VERSION,
    ),
    ...overrides,
  };
}

test('38a. Only provider supplied is invalid before Quote', async () => {
  const input = buildInput({ provider: 'fake-provider', model: undefined });
  const { deps, calls } = makeDeps();
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.stage, 'PREFLIGHT');
  assert.equal(rec.reasonCode, 'INVALID_REQUESTED_IDENTITY');
  assert.deepEqual(calls.order, []);
});

test('38b. Only model supplied is invalid before Quote', async () => {
  const input = buildInput({ provider: undefined, model: 'fake-model' });
  const { deps, calls } = makeDeps();
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.stage, 'PREFLIGHT');
  assert.equal(rec.reasonCode, 'INVALID_REQUESTED_IDENTITY');
  assert.deepEqual(calls.order, []);
});

test('38c. Blank provider is invalid before Quote', async () => {
  const input = buildInput({ provider: '  ', model: 'fake-model' });
  const { deps, calls } = makeDeps();
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.stage, 'PREFLIGHT');
  assert.equal(rec.reasonCode, 'INVALID_REQUESTED_IDENTITY');
  assert.deepEqual(calls.order, []);
});

test('38d. Blank model is invalid before Quote', async () => {
  const input = buildInput({ provider: 'fake-provider', model: '' });
  const { deps, calls } = makeDeps();
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.stage, 'PREFLIGHT');
  assert.equal(rec.reasonCode, 'INVALID_REQUESTED_IDENTITY');
  assert.deepEqual(calls.order, []);
});

test('38e. Non-string provider runtime value is invalid', async () => {
  const input = buildInput({ provider: 123 as unknown as string, model: 'fake-model' });
  const { deps, calls } = makeDeps();
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.stage, 'PREFLIGHT');
  assert.equal(rec.reasonCode, 'INVALID_REQUESTED_IDENTITY');
  assert.deepEqual(calls.order, []);
});

test('38f. Non-string model runtime value is invalid', async () => {
  const input = buildInput({ provider: 'fake-provider', model: {} as unknown as string });
  const { deps, calls } = makeDeps();
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.stage, 'PREFLIGHT');
  assert.equal(rec.reasonCode, 'INVALID_REQUESTED_IDENTITY');
  assert.deepEqual(calls.order, []);
});

test('38g. Invalid identity performs no Reserve/Create/Execute/Price/Settle/Release', async () => {
  const input = buildInput({ provider: 'fake-provider', model: undefined });
  const { deps, calls } = makeDeps();
  await runAIBillingOrchestration(input, deps);
  assert.ok(!calls.order.includes('reserve'));
  assert.ok(!calls.order.includes('createOperation'));
  assert.ok(!calls.order.includes('execute'));
  assert.ok(!calls.order.includes('price'));
  assert.ok(!calls.order.includes('settle'));
  assert.ok(!calls.order.includes('release'));
});

test('38h. Validated trimmed pair is used for Quote, metadata, create, and snapshot', async () => {
  const input = buildInput({ provider: '  fake-provider  ', model: ' fake-model ' });
  const { deps, calls } = makeDeps();
  const result = expectSettled(await runAIBillingOrchestration(input, deps));
  assert.equal(calls.quoteInputs[0].provider, 'fake-provider');
  assert.equal(calls.quoteInputs[0].model, 'fake-model');
  const meta = calls.reserveInputs[0].metadata as AIBillingReservationMetadata;
  assert.equal(meta.aiBilling.provider, 'fake-provider');
  assert.equal(meta.aiBilling.model, 'fake-model');
  assert.equal(calls.createInputs[0].requestedProvider, 'fake-provider');
  assert.equal(calls.createInputs[0].requestedModel, 'fake-model');
  assert.deepEqual(calls.recordExecutionInputs[0].usage.provider, 'fake-provider');
  assert.equal(result.billing.provider, 'fake-provider');
});

// --- Reservation / durable snapshot integrity --------------------------------

test('38i. reservationId mismatch blocks Execute', async () => {
  const { deps, calls } = makeDeps({
    createAIBillingOperation: async () => validCreateResult({ reservationId: 'other-res' }),
  });
  const input = buildInput({ execute: recordExecute(calls) });
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.stage, 'OPERATION_CREATION');
  assert.equal(rec.reasonCode, 'OPERATION_SNAPSHOT_MISMATCH');
  assert.equal(calls.executeContexts.length, 0);
});

test('38j. operationId mismatch blocks Execute', async () => {
  const { deps, calls } = makeDeps({
    createAIBillingOperation: async () => validCreateResult({ operationId: 'other-op' }),
  });
  const input = buildInput({ execute: recordExecute(calls) });
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.stage, 'OPERATION_CREATION');
  assert.equal(rec.reasonCode, 'OPERATION_SNAPSHOT_MISMATCH');
  assert.equal(calls.executeContexts.length, 0);
});

test('38k. createResult.reservedTokens mismatch blocks Execute', async () => {
  const { deps, calls } = makeDeps({
    createAIBillingOperation: async () => validCreateResult({ reservedTokens: 100 }),
  });
  const input = buildInput({ execute: recordExecute(calls) });
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.stage, 'OPERATION_CREATION');
  assert.equal(rec.reasonCode, 'OPERATION_SNAPSHOT_MISMATCH');
  assert.equal(calls.executeContexts.length, 0);
});

test('38l. reservationPricingVersion mismatch blocks Execute', async () => {
  const { deps, calls } = makeDeps({
    createAIBillingOperation: async () => validCreateResult({ reservationPricingVersion: 2 }),
  });
  const input = buildInput({ execute: recordExecute(calls) });
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.stage, 'OPERATION_CREATION');
  assert.equal(rec.reasonCode, 'OPERATION_SNAPSHOT_MISMATCH');
  assert.equal(calls.executeContexts.length, 0);
});

test('38m. non-RESERVED create status blocks Execute', async () => {
  const { deps, calls } = makeDeps({
    createAIBillingOperation: async () =>
      validCreateResult({ status: AIBillingOperationStatus.EXECUTION_SUCCEEDED }),
  });
  const input = buildInput({ execute: recordExecute(calls) });
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.stage, 'OPERATION_CREATION');
  assert.equal(rec.reasonCode, 'OPERATION_SNAPSHOT_MISMATCH');
  assert.equal(calls.executeContexts.length, 0);
});

test('38n. snapshot mismatch performs no Price/Settle/Release', async () => {
  const { deps, calls } = makeDeps({
    createAIBillingOperation: async () => validCreateResult({ reservedTokens: 100 }),
  });
  const input = buildInput({ execute: recordExecute(calls) });
  await runAIBillingOrchestration(input, deps);
  assert.ok(!calls.order.includes('price'));
  assert.ok(!calls.order.includes('settle'));
  assert.ok(!calls.order.includes('release'));
});

test('38o. durable reservedTokens is the pricing ceiling', async () => {
  const input = buildInput();
  const quote = expectedQuote(input);
  const ceiling = quote.reservationTokens;
  const { deps, calls } = makeDeps({
    calculateActualPrice: () => priceResult({ walletTokens: ceiling + 1 }),
  });
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.stage, 'PRICING');
  assert.equal(rec.reasonCode, 'PRICING_LIMITS_EXCEEDED');
  assert.equal(rec.operationStatus, AIBillingOperationStatus.EXECUTION_SUCCEEDED);
  assert.ok(!calls.order.includes('settle'));
  assert.ok(!calls.order.includes('release'));
});

test('38p. happy path create carries real reserved tokens and pricing version', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps();
  const result = expectSettled(await runAIBillingOrchestration(input, deps));
  const quote = expectedQuote(input);
  assert.equal(calls.createInputs.length, 1);
  assert.equal(result.billing.reservedTokens, quote.reservationTokens);
});

// --- NON_BILLABLE flow ------------------------------------------------------

test('39. Failure evidence stored before Release', async () => {
  const input = buildInput({
    execute: async () => ({
      kind: 'NON_BILLABLE_FAILURE',
      code: 'PROMPT_BLOCKED',
      message: 'request not allowed',
      providerRequestSent: false,
      retryable: false,
    }),
  });
  const { deps, calls } = makeDeps();
  const result = expectReleased(await runAIBillingOrchestration(input, deps));
  assert.equal(result.outcome, 'RELEASED');
  assert.equal(result.failureCode, 'PROMPT_BLOCKED');
  assert.ok(calls.order.indexOf('recordFailure') < calls.order.indexOf('release'));
  assert.ok(calls.order.indexOf('release') < calls.order.indexOf('markReleased'));
});

test('40. Release is not called if failure persistence fails', async () => {
  const input = buildInput({
    execute: async () => ({
      kind: 'NON_BILLABLE_FAILURE',
      code: 'PROMPT_BLOCKED',
      message: 'request not allowed',
      providerRequestSent: false,
      retryable: false,
    }),
  });
  const { deps, calls } = makeDeps({}, { failureThrows: true });
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.stage, 'FAILURE_EVIDENCE');
  assert.equal(rec.reasonCode, 'FAILURE_EVIDENCE_FAILED');
  assert.ok(!calls.order.includes('release'));
});

test('41. Real release result marks operation RELEASED', async () => {
  const input = buildInput({
    execute: async () => ({
      kind: 'NON_BILLABLE_FAILURE',
      code: 'PROMPT_BLOCKED',
      message: 'request not allowed',
      providerRequestSent: false,
      retryable: false,
    }),
  });
  const { deps, calls } = makeDeps();
  const result = expectReleased(await runAIBillingOrchestration(input, deps));
  assert.equal(calls.markReleasedInputs.length, 1);
  assert.equal(calls.markReleasedInputs[0].release.reservationId, RESERVATION_ID);
  assert.equal(result.outcome, 'RELEASED');
  assert.equal(result.recoveryRequired, false);
});

test('42. Release failure leaves NON_BILLABLE_CONFIRMED', async () => {
  const input = buildInput({
    execute: async () => ({
      kind: 'NON_BILLABLE_FAILURE',
      code: 'PROMPT_BLOCKED',
      message: 'request not allowed',
      providerRequestSent: false,
      retryable: false,
    }),
  });
  const { deps, calls } = makeDeps({
    releaseReservation: async () => {
      throw new Error('release boom');
    },
  });
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.stage, 'RELEASE');
  assert.equal(rec.reasonCode, 'RELEASE_FAILED');
  assert.equal(rec.operationStatus, AIBillingOperationStatus.NON_BILLABLE_CONFIRMED);
  assert.equal(rec.reservationId, RESERVATION_ID);
});

test('43. Final RELEASED marking failure does not release twice', async () => {
  const input = buildInput({
    execute: async () => ({
      kind: 'NON_BILLABLE_FAILURE',
      code: 'PROMPT_BLOCKED',
      message: 'request not allowed',
      providerRequestSent: false,
      retryable: false,
    }),
  });
  const { deps, calls } = makeDeps({}, { releasedThrows: true });
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.stage, 'RELEASED_EVIDENCE');
  assert.equal(rec.reasonCode, 'RELEASED_EVIDENCE_FAILED');
  assert.equal(rec.operationStatus, AIBillingOperationStatus.NON_BILLABLE_CONFIRMED);
  assert.equal(calls.releaseInputs.length, 1);
});

test('44. Non-billable path performs no pricing or settlement', async () => {
  const input = buildInput({
    execute: async () => ({
      kind: 'NON_BILLABLE_FAILURE',
      code: 'PROMPT_BLOCKED',
      message: 'request not allowed',
      providerRequestSent: false,
      retryable: false,
    }),
  });
  const { deps, calls } = makeDeps();
  await runAIBillingOrchestration(input, deps);
  assert.ok(!calls.order.includes('price'));
  assert.ok(!calls.order.includes('recordPricing'));
  assert.ok(!calls.order.includes('settle'));
});

test('45. providerRequestSent=false preserved', async () => {
  const input = buildInput({
    execute: async () => ({
      kind: 'NON_BILLABLE_FAILURE',
      code: 'PROMPT_BLOCKED',
      message: 'request not allowed',
      providerRequestSent: false,
      retryable: true,
    }),
  });
  const { deps, calls } = makeDeps();
  await runAIBillingOrchestration(input, deps);
  assert.equal(calls.failureInputs[0].failure.kind, 'NON_BILLABLE_FAILURE');
  assert.equal(calls.failureInputs[0].failure.providerRequestSent, false);
  assert.equal(calls.failureInputs[0].failure.retryable, true);
});

// --- INDETERMINATE flow -----------------------------------------------------

function indeterminateOutcome() {
  return {
    kind: 'INDETERMINATE_FAILURE',
    code: 'PROVIDER_TIMEOUT',
    message: 'provider did not respond',
    providerRequestSent: true,
    retryable: false,
  };
}

test('46. Failure evidence is persisted', async () => {
  const input = buildInput({ execute: async () => indeterminateOutcome() });
  const { deps, calls } = makeDeps();
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(calls.failureInputs.length, 1);
  assert.equal(calls.failureInputs[0].failure.kind, 'INDETERMINATE_FAILURE');
  assert.equal(calls.failureInputs[0].failure.code, 'PROVIDER_TIMEOUT');
  assert.equal(rec.stage, 'EXECUTION');
});

test('47. Reservation is not released', async () => {
  const input = buildInput({ execute: async () => indeterminateOutcome() });
  const { deps, calls } = makeDeps();
  await runAIBillingOrchestration(input, deps);
  assert.ok(!calls.order.includes('release'));
});

test('48. Reservation is not settled', async () => {
  const input = buildInput({ execute: async () => indeterminateOutcome() });
  const { deps, calls } = makeDeps();
  await runAIBillingOrchestration(input, deps);
  assert.ok(!calls.order.includes('settle'));
});

test('49. Pricing is not called', async () => {
  const input = buildInput({ execute: async () => indeterminateOutcome() });
  const { deps, calls } = makeDeps();
  await runAIBillingOrchestration(input, deps);
  assert.ok(!calls.order.includes('price'));
  assert.ok(!calls.order.includes('recordPricing'));
});

test('50. AI is not retried', async () => {
  const { deps, calls } = makeDeps();
  const input = buildInput({
    execute: async (c) => {
      calls.order.push('execute');
      calls.executeContexts.push(c);
      return indeterminateOutcome();
    },
  });
  await runAIBillingOrchestration(input, deps);
  assert.equal(calls.executeContexts.length, 1);
});

test('51. Partial execution identity is passed through', async () => {
  const input = buildInput({
    execute: async () => ({
      ...indeterminateOutcome(),
      execution: { provider: 'fake-provider', model: 'fake-model', providerRequestId: 'req-9' },
    }),
  });
  const { deps, calls } = makeDeps();
  await runAIBillingOrchestration(input, deps);
  assert.deepEqual(calls.failureInputs[0].failure.execution, {
    provider: 'fake-provider',
    model: 'fake-model',
    providerRequestId: 'req-9',
  });
});

test('52. Result requires recovery', async () => {
  const input = buildInput({ execute: async () => indeterminateOutcome() });
  const { deps } = makeDeps();
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.recoveryRequired, true);
  assert.equal(rec.stage, 'EXECUTION');
  assert.equal(rec.reasonCode, 'INDETERMINATE_EXECUTION');
  assert.equal(rec.operationStatus, AIBillingOperationStatus.INDETERMINATE);
});

// --- Thrown / invalid executor ----------------------------------------------

test('53. Thrown executor becomes safe indeterminate evidence', async () => {
  const input = buildInput({
    execute: async () => {
      throw new Error('ai crash');
    },
  });
  const { deps, calls } = makeDeps();
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(calls.failureInputs[0].failure.kind, 'INDETERMINATE_FAILURE');
  assert.equal(calls.failureInputs[0].failure.code, 'EXECUTOR_THROWN_DISPATCH_UNKNOWN');
  assert.equal(calls.failureInputs[0].failure.providerRequestSent, true);
  assert.equal(rec.reasonCode, 'EXECUTOR_THROWN_DISPATCH_UNKNOWN');
});

test('54. Raw thrown message is not persisted or returned', async () => {
  const input = buildInput({
    execute: async () => {
      throw new Error('ai crash secret details');
    },
  });
  const { deps, calls } = makeDeps();
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  const persisted = JSON.stringify(calls.failureInputs[0].failure);
  assert.ok(!persisted.includes('ai crash'));
  assert.ok(!persisted.includes('secret'));
  const returned = JSON.stringify(rec);
  assert.ok(!returned.includes('ai crash'));
});

test('55. Invalid outcome becomes safe indeterminate evidence', async () => {
  const input = buildInput({
    execute: async () => ({ kind: 'UNKNOWN', whatever: true }),
  });
  const { deps, calls } = makeDeps();
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(calls.failureInputs[0].failure.code, 'EXECUTION_OUTCOME_INVALID');
  assert.equal(calls.failureInputs[0].failure.providerRequestSent, true);
  assert.equal(rec.reasonCode, 'EXECUTION_OUTCOME_INVALID');
});

test('56. No financial action after thrown executor', async () => {
  const input = buildInput({
    execute: async () => {
      throw new Error('ai crash');
    },
  });
  const { deps, calls } = makeDeps();
  await runAIBillingOrchestration(input, deps);
  assert.ok(!calls.order.includes('price'));
  assert.ok(!calls.order.includes('settle'));
  assert.ok(!calls.order.includes('release'));
});

test('57. Failure-evidence persistence failure still performs no financial action', async () => {
  const input = buildInput({
    execute: async () => {
      throw new Error('ai crash');
    },
  });
  const { deps, calls } = makeDeps({}, { failureThrows: true });
  const rec = expectRecovery(await runAIBillingOrchestration(input, deps));
  assert.equal(rec.stage, 'FAILURE_EVIDENCE');
  assert.equal(rec.reasonCode, 'FAILURE_EVIDENCE_FAILED');
  assert.ok(!calls.order.includes('release'));
  assert.ok(!calls.order.includes('settle'));
  assert.ok(!calls.order.includes('price'));
});

// --- Ordering ---------------------------------------------------------------

test('58. Exact call order for SUCCESS', async () => {
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

test('59. Exact call order for NON_BILLABLE', async () => {
  const { deps, calls } = makeDeps();
  const input = buildInput({
    execute: recordExecute(calls, async () => ({
      kind: 'NON_BILLABLE_FAILURE',
      code: 'PROMPT_BLOCKED',
      message: 'request not allowed',
      providerRequestSent: false,
      retryable: false,
    })),
  });
  await runAIBillingOrchestration(input, deps);
  assert.deepEqual(calls.order, [
    'preflight',
    'quote',
    'reserve',
    'createOperation',
    'execute',
    'recordFailure',
    'release',
    'markReleased',
  ]);
});

test('60. Exact call order for INDETERMINATE', async () => {
  const { deps, calls } = makeDeps();
  const input = buildInput({ execute: recordExecute(calls, async () => indeterminateOutcome()) });
  await runAIBillingOrchestration(input, deps);
  assert.deepEqual(calls.order, [
    'preflight',
    'quote',
    'reserve',
    'createOperation',
    'execute',
    'recordFailure',
  ]);
});

test('61. No settlement before pricing evidence', async () => {
  const { deps, calls } = makeDeps();
  const input = buildInput({ execute: recordExecute(calls) });
  await runAIBillingOrchestration(input, deps);
  assert.ok(calls.order.indexOf('recordPricing') < calls.order.indexOf('settle'));
});

test('62. No release before non-billable evidence', async () => {
  const input = buildInput({
    execute: async () => ({
      kind: 'NON_BILLABLE_FAILURE',
      code: 'PROMPT_BLOCKED',
      message: 'request not allowed',
      providerRequestSent: false,
      retryable: false,
    }),
  });
  const { deps, calls } = makeDeps();
  await runAIBillingOrchestration(input, deps);
  assert.ok(calls.order.indexOf('recordFailure') < calls.order.indexOf('release'));
});

test('63. No AI execution before durable operation creation', async () => {
  const { deps, calls } = makeDeps();
  const input = buildInput({ execute: recordExecute(calls) });
  await runAIBillingOrchestration(input, deps);
  assert.ok(calls.order.indexOf('createOperation') < calls.order.indexOf('execute'));
});

// --- Separation -------------------------------------------------------------

const serviceSource = readFileSync(
  new URL('../src/services/ai-billing-orchestrator.service.ts', import.meta.url),
  'utf8',
);
const typesSource = readFileSync(
  new URL('../src/types/ai-billing-orchestrator.ts', import.meta.url),
  'utf8',
);

test('64. No HTTP call added', () => {
  assert.ok(!serviceSource.includes('node:http'));
  assert.ok(!serviceSource.includes('node:https'));
  assert.ok(!serviceSource.includes('fetch('));
});

test('65. No live Chat/Streaming integration added', () => {
  assert.ok(!serviceSource.includes('@google/generative-ai'));
  assert.ok(!serviceSource.includes('stream'));
});

test('66. No direct Prisma access in orchestrator', () => {
  assert.ok(!serviceSource.includes('@prisma/client'));
  assert.ok(!/prisma\./.test(serviceSource));
});

test('67. No direct Wallet arithmetic', () => {
  assert.ok(!serviceSource.includes('tokenBalance'));
  assert.ok(!serviceSource.includes('reservedBalance'));
  assert.ok(!serviceSource.includes('availableBalance'));
});

test('68. No direct transaction creation', () => {
  assert.ok(!serviceSource.includes('tokenTransaction'));
  assert.ok(!serviceSource.includes('CONSUME'));
  assert.ok(!serviceSource.includes('REFUND'));
});

test('69. No production provider/model hardcoded', () => {
  assert.ok(!serviceSource.includes('gemini'));
  assert.ok(!serviceSource.includes('gpt-'));
  assert.ok(!serviceSource.includes('claude'));
});

test('70. No provider price added', () => {
  assert.ok(!serviceSource.includes('inputMicrosPerMillionTokens'));
  assert.ok(!serviceSource.includes('outputMicrosPerMillionTokens'));
  assert.ok(!typesSource.includes('billingCurrency: \'USD\''));
});

test('71. No prompt/response persistence', () => {
  assert.ok(!serviceSource.includes('prompt'));
  assert.ok(!serviceSource.includes('response'));
});

test('72. No worker, scheduler, queue, endpoint, or dashboard', () => {
  assert.ok(!serviceSource.includes('bullmq'));
  assert.ok(!serviceSource.includes('queue'));
  assert.ok(!serviceSource.includes('cron'));
  assert.ok(!serviceSource.includes('router.'));
  assert.ok(!serviceSource.includes('dashboard'));
});
