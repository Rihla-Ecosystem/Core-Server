import { z } from 'zod';

export const adminBillingRecoveryQueueQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['PENDING', 'COMPLETED', 'RELEASED']).optional(),
  feature: z
    .preprocess(
      (val) => (typeof val === 'string' && val.trim().length === 0 ? undefined : val),
      z.string().trim().max(50).optional(),
    )
    .optional(),
}).strict();

export type AdminBillingRecoveryQueueQuery = z.infer<typeof adminBillingRecoveryQueueQuerySchema>;

export const adminBillingRecoveryReservationParamsSchema = z.object({
  reservationId: z.string().trim().uuid(),
}).strict();

export const adminBillingRecoveryWalletParamsSchema = z.object({
  walletId: z.string().trim().uuid(),
}).strict();

const recoveryReasonSchema = z.string().trim().min(1).max(500);
const evidenceReferenceSchema = z.string().trim().min(1).max(500).optional();

export const adminBillingRecoveryActionBodySchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('SETTLE'),
    confirmation: z.literal('ACTUAL_TOKENS_CONFIRMED'),
    actualTokens: z.number().int().min(0),
    reason: recoveryReasonSchema,
    evidenceReference: evidenceReferenceSchema,
  }).strict(),
  z.object({
    type: z.literal('RELEASE'),
    confirmation: z.literal('CONFIRMED_NON_BILLABLE'),
    reason: recoveryReasonSchema,
    evidenceReference: evidenceReferenceSchema,
  }).strict(),
  z.object({
    type: z.literal('MANUAL_RELEASE'),
    confirmation: z.literal('ADMIN_CONFIRMED_NON_BILLABLE'),
    reason: recoveryReasonSchema,
    evidenceReference: evidenceReferenceSchema,
  }).strict(),
  z.object({
    type: z.literal('MANUAL_SETTLE'),
    confirmation: z.literal('ADMIN_CONFIRMED_ACTUAL_TOKENS'),
    actualTokens: z.number().int().min(0),
    reason: recoveryReasonSchema,
    evidenceReference: evidenceReferenceSchema,
  }).strict(),
  z.object({
    type: z.literal('REVIEW'),
    reason: recoveryReasonSchema,
    evidenceReference: evidenceReferenceSchema,
  }).strict(),
  z.object({
    type: z.literal('APPROVE_SYSTEM_RECOMMENDATION'),
    confirmation: z.literal('APPROVE_SYSTEM_RECOMMENDATION'),
    reason: recoveryReasonSchema,
    evidenceReference: evidenceReferenceSchema,
  }).strict(),
]);

export type AdminBillingRecoveryActionBody = z.infer<typeof adminBillingRecoveryActionBodySchema>;
