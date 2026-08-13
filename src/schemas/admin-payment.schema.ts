import { z } from 'zod';

export const adminPaymentListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['PENDING', 'COMPLETED', 'FAILED', 'CANCELLED', 'REFUNDED']).optional(),
  currency: z.string().trim().length(3).regex(/^[A-Za-z]{3}$/).transform((val) => val.toUpperCase()).optional(),
  tokenPackageId: z.coerce.number().int().min(1).optional(),
  userId: z.string().trim().uuid().optional(),
  dateFrom: z.string().datetime({ offset: true }).transform((val) => new Date(val)).optional(),
  dateTo: z.string().datetime({ offset: true }).transform((val) => new Date(val)).optional(),
  sortBy: z.enum(['createdAt', 'updatedAt', 'amount', 'paidAt']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  refundReview: z.enum(['active', 'resolved']).optional(),
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

export type AdminPaymentListQuery = z.infer<typeof adminPaymentListQuerySchema>;

export const adminPaymentIdParamsSchema = z.object({
  id: z.string().trim().uuid(),
}).strict();

export type AdminPaymentIdParams = z.infer<typeof adminPaymentIdParamsSchema>;

export const adminPaymentRefundResolveParamsSchema = z.object({ refundId: z.string().trim().uuid() }).strict();
export const adminPaymentRefundResolveBodySchema = z.object({ resolutionNote: z.string().trim().min(1).max(2000) }).strict();
export type AdminPaymentRefundResolveBody = z.infer<typeof adminPaymentRefundResolveBodySchema>;
