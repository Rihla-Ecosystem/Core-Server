import { AppError } from '../middleware/errorHandler.js';
import {
  getBusinessTokenCost,
  isBusinessTokenFeature,
} from '../config/business-token-features.js';
import type { BusinessTokenFeature } from '../config/business-token-features.js';
import {
  consumeBusinessTokens,
  reverseBusinessTokens,
} from './business-token-consumption.service.js';
import type { BusinessConsumptionSource, ConsumeBusinessTokensResult } from './business-token-consumption.service.js';

export interface TokenizedServiceExecutionInput<T> {
  userId: string;
  feature: BusinessTokenFeature;
  source: BusinessConsumptionSource;
  idempotencyKey: string;
  idempotentReplayMessage: string;
  execute: () => Promise<T>;
}

export interface BusinessTokenCharge {
  userId: string;
  feature: BusinessTokenFeature;
  source: BusinessConsumptionSource;
  idempotencyKey: string;
  consumeTransactionId: string;
  consumeReferenceId: string;
}

function assertExecutionInput(
  userId: string,
  feature: string,
  idempotencyKey: string,
): asserts feature is BusinessTokenFeature {
  if (!userId.trim()) {
    throw new AppError(400, 'userId must not be empty');
  }
  if (!idempotencyKey.trim()) {
    throw new AppError(400, 'idempotencyKey must not be empty');
  }
  if (!isBusinessTokenFeature(feature)) {
    throw new AppError(400, 'Invalid business token feature');
  }
}

export async function beginBusinessTokenCharge(
  input: Omit<TokenizedServiceExecutionInput<never>, 'execute'>,
): Promise<BusinessTokenCharge> {
  assertExecutionInput(input.userId, input.feature, input.idempotencyKey);
  getBusinessTokenCost(input.feature);

  const consumption: ConsumeBusinessTokensResult = await consumeBusinessTokens({
    userId: input.userId,
    feature: input.feature,
    source: input.source,
    businessRequestId: input.idempotencyKey,
  });

  if (consumption.idempotentReplay) {
    throw new AppError(409, input.idempotentReplayMessage);
  }

  return {
    userId: input.userId,
    feature: input.feature,
    source: input.source,
    idempotencyKey: input.idempotencyKey,
    consumeTransactionId: consumption.transactionId,
    consumeReferenceId: consumption.referenceId,
  };
}

export async function refundBusinessTokenCharge(charge: BusinessTokenCharge, originalError: unknown): Promise<void> {
  try {
    await reverseBusinessTokens({
      userId: charge.userId,
      feature: charge.feature,
      source: charge.source,
      businessRequestId: charge.idempotencyKey,
    });
  } catch (refundError) {
    console.error('[tokens] compensation_failed', {
      userId: charge.userId,
      feature: charge.feature,
      idempotencyKey: charge.idempotencyKey,
      consumeTransactionId: charge.consumeTransactionId,
      consumeReferenceId: charge.consumeReferenceId,
      originalError: originalError instanceof Error ? originalError.message : String(originalError),
      refundError: refundError instanceof Error ? refundError.message : String(refundError),
    });
  }
}

export async function executeWithBusinessTokenCharge<T>(
  input: TokenizedServiceExecutionInput<T>,
): Promise<T> {
  const charge = await beginBusinessTokenCharge(input);

  try {
    return await input.execute();
  } catch (error) {
    await refundBusinessTokenCharge(charge, error);
    throw error;
  }
}
