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
