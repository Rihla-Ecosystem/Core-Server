import { z } from 'zod';

export const adminTokenReservationListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    status: z.enum(['PENDING', 'COMPLETED', 'RELEASED']).optional(),
    feature: z.string().trim().min(1).optional(),
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
    userId: z.string().trim().uuid().optional(),
    search: z.preprocess(
      (val) => (typeof val === 'string' && val.trim().length === 0 ? undefined : val),
      z.string().trim().optional(),
    ),
    from: z.string().datetime({ offset: true }).or(z.string().datetime()).optional(),
    to: z.string().datetime({ offset: true }).or(z.string().datetime()).optional(),
  })
  .strict()
  .refine(
    (data) => {
      if (data.from && data.to) {
        return new Date(data.from) <= new Date(data.to);
      }
      return true;
    },
    {
      path: ['to'],
      message: 'from date must be less than or equal to to date',
    },
  );

export type AdminTokenReservationListQuery = z.infer<
  typeof adminTokenReservationListQuerySchema
>;

export const adminTokenReservationParamsSchema = z
  .object({
    reservationId: z.string().trim().uuid(),
  })
  .strict();

export type AdminTokenReservationParams = z.infer<
  typeof adminTokenReservationParamsSchema
>;
