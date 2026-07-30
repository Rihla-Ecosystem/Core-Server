import { z } from 'zod';

export const adminTokenPackageListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.preprocess(
    (val) => (typeof val === 'string' && val.trim().length === 0 ? undefined : val),
    z.string().trim().max(100).optional(),
  ),
  isActive: z
    .enum(['true', 'false'])
    .transform((val) => val === 'true')
    .optional(),
  currency: z.preprocess(
    (val) => (typeof val === 'string' && val.trim().length === 0 ? undefined : val),
    z.string().trim().length(3).transform((val) => val.toUpperCase()).optional(),
  ),
  sortBy: z.enum(['name', 'price', 'tokens', 'sortOrder', 'createdAt', 'updatedAt']).default('sortOrder'),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
}).strict();

export const adminTokenPackageIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
}).strict();

export type AdminTokenPackageListQuery = z.infer<typeof adminTokenPackageListQuerySchema>;
export type AdminTokenPackageIdParams = z.infer<typeof adminTokenPackageIdParamsSchema>;

const whitespaceToUndefined = (val: unknown) =>
  typeof val === 'string' && val.trim().length === 0 ? undefined : val;

const priceSchema = z.preprocess(
  (val) => {
    if (typeof val === 'number' && Number.isFinite(val)) {
      return String(val);
    }
    return val;
  },
  z.string()
    .refine((val) => /^\d+(\.\d{1,2})?$/.test(val), {
      message: 'Price must be a positive number with at most 2 decimal places',
    })
    .refine((val) => parseFloat(val) > 0, {
      message: 'Price must be greater than zero',
    }),
);

const currencySchema = z.preprocess(
  (val) => (typeof val === 'string' ? val.trim().toUpperCase() : val),
  z.literal('EGP'),
);

export const adminTokenPackageCreateBodySchema = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.preprocess(
    whitespaceToUndefined,
    z.string().trim().max(500).optional(),
  ),
  code: z.string().trim().transform((val) => val.toUpperCase()).refine(
    (val) => /^[A-Z0-9_]+$/.test(val),
    { message: 'Code must contain only uppercase letters, digits, and underscores' },
  ),
  price: priceSchema,
  currency: currencySchema,
  tokens: z.number().int().positive(),
  sortOrder: z.number().int().nonnegative(),
  isActive: z.boolean().optional().default(true),
}).strict();

export type AdminTokenPackageCreateBody = z.infer<typeof adminTokenPackageCreateBodySchema>;

export const adminTokenPackageUpdateBodySchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  description: z.preprocess(
    (val) => {
      if (val === undefined) return undefined;
      if (val === null) return null;
      if (typeof val === 'string' && val.trim().length === 0) return null;
      return val;
    },
    z.union([z.literal(null), z.string().trim().max(500)]).optional(),
  ),
  price: priceSchema.optional(),
  currency: currencySchema.optional(),
  tokens: z.number().int().positive().optional(),
  sortOrder: z.number().int().nonnegative().optional(),
}).strict().refine(
  (data) => data.name !== undefined || data.description !== undefined
    || data.price !== undefined || data.currency !== undefined
    || data.tokens !== undefined || data.sortOrder !== undefined,
  { message: 'At least one field must be provided' },
);

export type AdminTokenPackageUpdateBody = z.infer<typeof adminTokenPackageUpdateBodySchema>;
