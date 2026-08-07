/**
 * Phase 2F-C strict Zod schemas for the rate-card Admin workflow.
 *
 * Inputs are validated strictly (unknown keys rejected → 400). The pure
 * entry-import converter and the engine validator remain the authoritative
 * domain validators; these schemas enforce the wire shape, the fixed ISO date
 * formats, and the strict non-negative integer STRING money contract at the
 * HTTP boundary.
 */

import { z } from 'zod';

const isoDateString = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date (YYYY-MM-DD)');

const isoDateTimeString = z
  .string()
  .datetime({ offset: true })
  .refine((value) => !Number.isNaN(new Date(value).getTime()), 'must be a valid ISO datetime');

const INT64_MAX = 9_223_372_036_854_775_807n;

/**
 * Strict non-negative integer money STRINGS (direct-to-bigint wire contract).
 *
 * Accepts only canonical digit strings such as "0", "1500000", and
 * "9000000000000000000". Rejects JSON numbers, negative strings, decimals,
 * exponent notation, whitespace-padded values, empty strings, and any value
 * that cannot fit PostgreSQL BIGINT (int64). The converter turns the string
 * into a `bigint` directly — never through `Number`.
 */
export const rateCardMoneyStringSchema = z
  .string()
  .refine(
    (value) => /^\d+$/.test(value) && BigInt(value) <= INT64_MAX,
    'must be a non-negative integer string (digits only) within int64',
  );

export const rateCardEntryStatusSchema = z.enum([
  'STABLE',
  'PREVIEW',
  'DEPRECATED',
  'LIMITED_AVAILABILITY',
]);

export const rateCardTierSchema = z.enum(['standard', 'batch', 'priority', 'fast_mode']);

export const rateCardBillingUnitSchema = z.enum([
  'TOKEN',
  'IMAGE',
  'SECOND',
  'MINUTE',
  'CHARACTER',
]);

export const cachedInputAccountingSchema = z.enum(['DISJOINT', 'INCLUDED_IN_INPUT']);

const rateCardTokenRatesSchema = z
  .object({
    inputMicrosPerMillion: rateCardMoneyStringSchema.nullish(),
    outputMicrosPerMillion: rateCardMoneyStringSchema.nullish(),
    cachedInputMicrosPerMillion: rateCardMoneyStringSchema.nullish(),
    cachedOutputMicrosPerMillion: rateCardMoneyStringSchema.nullish(),
  })
  .strict();

const rateCardEntrySchema = z
  .object({
    provider: z.string().trim().min(1),
    model: z.string().trim().min(1),
    aliases: z.array(z.string().trim().min(1)).optional(),
    status: rateCardEntryStatusSchema,
    tier: rateCardTierSchema.optional(),
    billingUnit: rateCardBillingUnitSchema,
    tokenRates: rateCardTokenRatesSchema.optional(),
    perUnitMicros: rateCardMoneyStringSchema.nullish(),
    modalityRates: z
      .object({ audioInputMicrosPerMillion: rateCardMoneyStringSchema.nullish() })
      .strict()
      .optional(),
    tts: z
      .object({
        audioOutputMicrosPerMillion: rateCardMoneyStringSchema.nullish(),
        tokensPerSecond: z.number().positive().optional(),
      })
      .strict()
      .optional(),
    cachedInputAccounting: cachedInputAccountingSchema.optional(),
    effectiveFrom: isoDateString,
    effectiveTo: isoDateString.optional(),
    inactive: z.boolean(),
    source: z.string().trim().min(1).optional(),
    verifiedAt: isoDateString.optional(),
    adminReason: z.string().trim().min(1),
  })
  .strict();

export const adminRateCardDraftBodySchema = z
  .object({
    version: z.string().trim().min(1),
    source: z.string().trim().min(1),
    generatedAt: isoDateString,
    effectiveFrom: isoDateString.optional(),
    effectiveTo: isoDateString.optional(),
  })
  .strict()
  .refine(
    (data) =>
      data.effectiveFrom === undefined ||
      data.effectiveTo === undefined ||
      data.effectiveTo >= data.effectiveFrom,
    {
      path: ['effectiveTo'],
      message: 'effectiveTo must be greater than or equal to effectiveFrom',
    },
  );

export const adminRateCardImportBodySchema = z
  .object({
    source: z.string().trim().min(1),
    generatedAt: isoDateString,
    entries: z.array(rateCardEntrySchema).min(1),
  })
  .strict();

export const adminRateCardPublishBodySchema = z
  .object({
    effectiveFrom: isoDateString.optional(),
    effectiveTo: isoDateString.optional(),
    /** Explicit ACTIVE snapshot to replace atomically (retire + activate). */
    replaceActiveVersion: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine(
    (data) =>
      data.effectiveFrom === undefined ||
      data.effectiveTo === undefined ||
      data.effectiveTo >= data.effectiveFrom,
    {
      path: ['effectiveTo'],
      message: 'effectiveTo must be greater than or equal to effectiveFrom',
    },
  );

export const adminRateCardRetireBodySchema = z
  .object({
    retiredAt: isoDateTimeString.optional(),
    /** Optional business-date window close written atomically with the retire. */
    effectiveTo: isoDateString.optional(),
  })
  .strict();

export const adminRateCardVersionParamsSchema = z.object({
  version: z.string().trim().min(1),
}).strict();

export const adminRateCardEntryParamsSchema = z.object({
  version: z.string().trim().min(1),
  entryId: z.string().trim().uuid(),
}).strict();

export type AdminRateCardEntryParams = z.infer<typeof adminRateCardEntryParamsSchema>;

/**
 * Single rate-card entry body for the Draft entry CRUD. Mirrors the import
 * entry shape: strict (unknown keys rejected), money as strict non-negative
 * integer STRINGS, DRAFT-only editing enforced by the service.
 */
export const adminRateCardEntryBodySchema = rateCardEntrySchema;

export type AdminRateCardEntryBody = z.infer<typeof adminRateCardEntryBodySchema>;

/**
 * Partial entry body for PATCH. Every field optional; at least one field must
 * be present. Sub-objects (tokenRates, modalityRates, tts) replace wholesale
 * when provided; scalar fields replace; explicit null clears optional values.
 * adminReason is always required to provide audit trail for changes.
 */
export const adminRateCardEntryPatchSchema = rateCardEntrySchema
  .partial()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'at least one entry field must be provided',
  })
  .refine((data) => data.adminReason !== undefined && data.adminReason !== null && data.adminReason !== '', {
    message: 'adminReason is required for all entry mutations',
    path: ['adminReason'],
  });

export type AdminRateCardEntryPatch = z.infer<typeof adminRateCardEntryPatchSchema>;

export const adminRateCardListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    status: z.enum(['DRAFT', 'ACTIVE', 'RETIRED']).optional(),
  })
  .strict();

export type AdminRateCardDraftBody = z.infer<typeof adminRateCardDraftBodySchema>;
export type AdminRateCardImportBody = z.infer<typeof adminRateCardImportBodySchema>;
export type AdminRateCardPublishBody = z.infer<typeof adminRateCardPublishBodySchema>;
export type AdminRateCardRetireBody = z.infer<typeof adminRateCardRetireBodySchema>;
export type AdminRateCardVersionParams = z.infer<typeof adminRateCardVersionParamsSchema>;
export type AdminRateCardListQuery = z.infer<typeof adminRateCardListQuerySchema>;
