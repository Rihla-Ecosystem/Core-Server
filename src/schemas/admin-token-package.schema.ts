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
