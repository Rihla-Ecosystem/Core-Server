import { z } from 'zod';

/**
 * Explicit boolean parsing for `noProviderCalls`.
 *
 * Plain `z.coerce.boolean()` would turn the query string `?noProviderCalls=false`
 * into `true`. This accepts only the literal values "true"/"false" (and boolean
 * true/false when the middleware can supply them) and rejects everything else.
 */
const booleanLiteral = z.union([
  z.literal('true'),
  z.literal('false'),
  z.literal(true),
  z.literal(false),
]).transform((value) => value === true || value === 'true');

export const adminObservationsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional().default(50),
  source: z.string().optional(),
  status: z.enum(['FULLY_PRICED', 'PARTIALLY_PRICED', 'UNPRICED', 'ZERO_PROVIDER_CALLS']).optional(),
  noProviderCalls: booleanLiteral.optional(),
}).strict();

export type AdminObservationsQuery = z.infer<typeof adminObservationsQuerySchema>;

const MAX_RANGE_DAYS = 31;
const MAX_RANGE_MS = MAX_RANGE_DAYS * 24 * 60 * 60 * 1000;

export const adminRecomputeBodySchema = z.object({
  from: z.string().refine((val) => !isNaN(Date.parse(val)), {
    message: 'from must be a valid ISO timestamp',
  }),
  to: z.string().refine((val) => !isNaN(Date.parse(val)), {
    message: 'to must be a valid ISO timestamp',
  }),
  limit: z.number().int().min(1).max(500).optional().default(100),
}).strict().refine(
  (data) => new Date(data.from) <= new Date(data.to),
  { message: 'from must be <= to' },
).refine(
  (data) => new Date(data.to).getTime() - new Date(data.from).getTime() <= MAX_RANGE_MS,
  { message: `date range must be at most ${MAX_RANGE_DAYS} days` },
);

export type AdminRecomputeBody = z.infer<typeof adminRecomputeBodySchema>;
