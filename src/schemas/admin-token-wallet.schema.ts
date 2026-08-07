import { z } from 'zod';
import { MAX_TOKEN_BALANCE } from '../config/business-token-features.js';

export const adminTokenWalletListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.preprocess(
    (val) => (typeof val === 'string' && val.trim().length === 0 ? undefined : val),
    z.string().trim().max(100).optional(),
  ),
  status: z.enum(['ACTIVE', 'INACTIVE', 'BLOCKED']).optional(),
  sortBy: z.enum(['tokenBalance', 'createdAt', 'updatedAt']).default('updatedAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
}).strict();

export type AdminTokenWalletListQuery = z.infer<typeof adminTokenWalletListQuerySchema>;

export const adminTokenWalletUserIdParamsSchema = z.object({
  userId: z.string().trim().uuid(),
}).strict();

export type AdminTokenWalletUserIdParams = z.infer<typeof adminTokenWalletUserIdParamsSchema>;

export const adminTokenWalletTransactionsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  type: z.enum(['GRANT', 'CONSUME', 'REFUND', 'BONUS', 'ADJUSTMENT']).optional(),
  source: z
    .enum([
      'CHAT',
      'IMAGE',
      'FILE_UPLOAD',
      'OCR',
      'VOICE',
      'ITINERARY',
      'PURCHASE',
      'ADMIN',
    ])
    .optional(),
  dateFrom: z.string().datetime({ offset: true }).transform((val) => new Date(val)).optional(),
  dateTo: z.string().datetime({ offset: true }).transform((val) => new Date(val)).optional(),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
}).strict().refine(
  (data) => {
    if (data.dateFrom !== undefined && data.dateTo !== undefined) {
      return data.dateFrom <= data.dateTo;
    }
    return true;
  },
  {
    path: ['dateTo'],
    message: 'dateFrom must be less than or equal to dateTo',
  },
);

export type AdminTokenWalletTransactionsQuery = z.infer<typeof adminTokenWalletTransactionsQuerySchema>;

export const adminTokenWalletBonusBodySchema = z.object({
  tokens: z.number().int().positive().max(MAX_TOKEN_BALANCE),
  reason: z.string().trim().min(3).max(500),
  idempotencyKey: z.string().trim().uuid(),
}).strict();

export type AdminTokenWalletBonusBody = z.infer<typeof adminTokenWalletBonusBodySchema>;

export const adminTokenWalletAdjustmentOperationSchema = z.enum(['CREDIT', 'DEBIT']);

export const adminTokenWalletAdjustmentBodySchema = z.object({
  operation: adminTokenWalletAdjustmentOperationSchema,
  tokens: z.number().int().positive().max(MAX_TOKEN_BALANCE),
  reason: z.string().trim().min(5).max(500),
  idempotencyKey: z.string().trim().uuid(),
  paymentId: z.string().trim().uuid().optional(),
  relatedTransactionId: z.string().trim().uuid().optional(),
}).strict();

export type AdminTokenWalletAdjustmentBody = z.infer<typeof adminTokenWalletAdjustmentBodySchema>;
