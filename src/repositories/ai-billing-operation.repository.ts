import {
  AIBillingOperation,
  AIBillingOperationFailureKind,
  AIBillingOperationStatus,
  Prisma,
  TokenReservation,
  TokenReservationStatus,
  TokenTransactionSource,
  TokenWallet,
} from '@prisma/client';
import { prisma } from '../config/prisma.js';

export interface AIBillingOperationReservationRow {
  id: string;
  walletId: string;
  userId: string;
  feature: string;
  source: TokenTransactionSource;
  tokens: number;
  pricingVersion: number;
  status: TokenReservationStatus;
  referenceId: string;
}

export interface AIBillingOperationWalletRow {
  id: string;
  userId: string;
}

export interface AIBillingOperationRow {
  id: string;
  operationId: string;
  reservationId: string;
  walletId: string;
  userId: string;
  feature: string;
  source: TokenTransactionSource;
  status: AIBillingOperationStatus;
  reservedTokens: number;
  reservationPricingVersion: number;
  requestedProvider: string | null;
  requestedModel: string | null;
  actualProvider: string | null;
  actualModel: string | null;
  providerRequestId: string | null;
  providerRequestSent: boolean | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cached: boolean | null;
  audioSeconds: number | null;
  pricingMode: string | null;
  pricingFallbackReason: string | null;
  actualWalletTokens: number | null;
  billingCurrency: string | null;
  rateCardVersion: string | null;
  walletPolicyVersion: string | null;
  failureKind: AIBillingOperationFailureKind | null;
  failureCode: string | null;
  retryable: boolean | null;
  reviewReasonCode: string | null;
  consumeTransactionId: string | null;
  executedAt: Date | null;
  pricedAt: Date | null;
  failedAt: Date | null;
  reviewedAt: Date | null;
  settledAt: Date | null;
  releasedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateAIBillingOperationRowInput {
  operationId: string;
  reservationId: string;
  walletId: string;
  userId: string;
  feature: string;
  source: TokenTransactionSource;
  reservedTokens: number;
  reservationPricingVersion: number;
  requestedProvider: string | null;
  requestedModel: string | null;
}

export interface AIBillingOperationTransitionInput {
  operationId: string;
  allowedFrom: AIBillingOperationStatus[];
  target: AIBillingOperationStatus;
  set: Record<string, unknown>;
}

export interface AIBillingOperationRepository {
  findReservationById(reservationId: string): Promise<AIBillingOperationReservationRow | null>;
  findWalletById(walletId: string): Promise<AIBillingOperationWalletRow | null>;
  findOperationByOperationId(operationId: string): Promise<AIBillingOperationRow | null>;
  findOperationByReservationId(reservationId: string): Promise<AIBillingOperationRow | null>;
  createOperation(input: CreateAIBillingOperationRowInput): Promise<AIBillingOperationRow>;
  transitionOperation(input: AIBillingOperationTransitionInput): Promise<boolean>;
}

function toReservationRow(reservation: TokenReservation): AIBillingOperationReservationRow {
  return {
    id: reservation.id,
    walletId: reservation.walletId,
    userId: reservation.userId,
    feature: reservation.feature,
    source: reservation.source,
    tokens: reservation.tokens,
    pricingVersion: reservation.pricingVersion,
    status: reservation.status,
    referenceId: reservation.referenceId,
  };
}

function toWalletRow(wallet: TokenWallet): AIBillingOperationWalletRow {
  return {
    id: wallet.id,
    userId: wallet.userId,
  };
}

function toOperationRow(operation: AIBillingOperation): AIBillingOperationRow {
  return {
    id: operation.id,
    operationId: operation.operationId,
    reservationId: operation.reservationId,
    walletId: operation.walletId,
    userId: operation.userId,
    feature: operation.feature,
    source: operation.source,
    status: operation.status,
    reservedTokens: operation.reservedTokens,
    reservationPricingVersion: operation.reservationPricingVersion,
    requestedProvider: operation.requestedProvider,
    requestedModel: operation.requestedModel,
    actualProvider: operation.actualProvider,
    actualModel: operation.actualModel,
    providerRequestId: operation.providerRequestId,
    providerRequestSent: operation.providerRequestSent,
    inputTokens: operation.inputTokens,
    outputTokens: operation.outputTokens,
    totalTokens: operation.totalTokens,
    cached: operation.cached,
    audioSeconds: operation.audioSeconds,
    pricingMode: operation.pricingMode,
    pricingFallbackReason: operation.pricingFallbackReason,
    actualWalletTokens: operation.actualWalletTokens,
    billingCurrency: operation.billingCurrency,
    rateCardVersion: operation.rateCardVersion,
    walletPolicyVersion: operation.walletPolicyVersion,
    failureKind: operation.failureKind,
    failureCode: operation.failureCode,
    retryable: operation.retryable,
    reviewReasonCode: operation.reviewReasonCode,
    consumeTransactionId: operation.consumeTransactionId,
    executedAt: operation.executedAt,
    pricedAt: operation.pricedAt,
    failedAt: operation.failedAt,
    reviewedAt: operation.reviewedAt,
    settledAt: operation.settledAt,
    releasedAt: operation.releasedAt,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
  };
}

export function createPrismaAIBillingOperationRepository(): AIBillingOperationRepository {
  return {
    async findReservationById(reservationId) {
      const reservation = await prisma.tokenReservation.findUnique({
        where: { id: reservationId },
      });
      return reservation ? toReservationRow(reservation) : null;
    },

    async findWalletById(walletId) {
      const wallet = await prisma.tokenWallet.findUnique({
        where: { id: walletId },
      });
      return wallet ? toWalletRow(wallet) : null;
    },

    async findOperationByOperationId(operationId) {
      const operation = await prisma.aIBillingOperation.findUnique({
        where: { operationId },
      });
      return operation ? toOperationRow(operation) : null;
    },

    async findOperationByReservationId(reservationId) {
      const operation = await prisma.aIBillingOperation.findUnique({
        where: { reservationId },
      });
      return operation ? toOperationRow(operation) : null;
    },

    async createOperation(input) {
      const operation = await prisma.aIBillingOperation.create({
        data: {
          operationId: input.operationId,
          reservationId: input.reservationId,
          walletId: input.walletId,
          userId: input.userId,
          feature: input.feature,
          source: input.source,
          status: AIBillingOperationStatus.RESERVED,
          reservedTokens: input.reservedTokens,
          reservationPricingVersion: input.reservationPricingVersion,
          requestedProvider: input.requestedProvider,
          requestedModel: input.requestedModel,
        },
      });
      return toOperationRow(operation);
    },

    async transitionOperation(input) {
      const result = await prisma.aIBillingOperation.updateMany({
        where: { operationId: input.operationId, status: { in: input.allowedFrom } },
        data: { status: input.target, ...input.set } as Prisma.AIBillingOperationUpdateManyMutationInput,
      });
      return result.count === 1;
    },
  };
}
