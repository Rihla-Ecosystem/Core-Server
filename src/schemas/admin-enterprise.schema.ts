import { z } from 'zod';

export const toBoolean = z.preprocess((value) => {
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  return value;
}, z.boolean());

export const listQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  search: z.string().trim().min(1).optional(),
});

export const roleListQuerySchema = listQuerySchema.extend({
  sort: z.enum(['id', 'name', 'createdAt']).default('id'),
  order: z.enum(['asc', 'desc']).default('asc'),
});

export const roleCreateBodySchema = z.object({
  name: z.string().trim().min(1).max(50),
  permissions: z.array(z.string().trim().min(1).max(100)).default([]),
});

export const roleUpdateBodySchema = z
  .object({
    name: z.string().trim().min(1).max(50).optional(),
    permissions: z.array(z.string().trim().min(1).max(100)).optional(),
  })
  .refine((value) => value.name !== undefined || value.permissions !== undefined, {
    message: 'At least one field is required',
  });

export const idParamSchema = z.object({
  id: z.string().uuid(),
});

export const intParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const badgeListQuerySchema = listQuerySchema.extend({
  criteriaType: z.string().trim().min(1).optional(),
});

export const badgeCreateBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional().nullable(),
  iconUrl: z.string().trim().max(1000).optional().nullable(),
  criteriaType: z.enum(['xp_threshold', 'action_count', 'manual']).default('manual'),
  criteriaValue: z.coerce.number().int().positive().optional().nullable(),
});

export const badgeUpdateBodySchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().max(500).optional().nullable(),
    iconUrl: z.string().trim().max(1000).optional().nullable(),
    criteriaType: z.enum(['xp_threshold', 'action_count', 'manual']).optional(),
    criteriaValue: z.coerce.number().int().positive().optional().nullable(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'At least one field is required' });

export const journeyListQuerySchema = listQuerySchema.extend({
  isActive: toBoolean.optional(),
  sort: z.enum(['title', 'xpReward', 'createdAt', 'updatedAt']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export const journeyCreateBodySchema = z.object({
  slug: z.string().trim().min(1).max(100).regex(/^[a-z0-9_-]+$/),
  title: z.string().trim().min(1).max(255),
  description: z.string().trim().max(2000).optional().nullable(),
  xpReward: z.coerce.number().int().min(0).default(0),
  isActive: z.boolean().default(true),
  steps: z
    .array(
      z.object({
        stepNumber: z.coerce.number().int().positive(),
        title: z.string().trim().min(1).max(255),
        content: z.string().trim().min(1),
        xpReward: z.coerce.number().int().min(0).default(0),
      }),
    )
    .optional(),
});

export const journeyUpdateBodySchema = z
  .object({
    slug: z.string().trim().min(1).max(100).regex(/^[a-z0-9_-]+$/).optional(),
    title: z.string().trim().min(1).max(255).optional(),
    description: z.string().trim().max(2000).optional().nullable(),
    xpReward: z.coerce.number().int().min(0).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'At least one field is required' });

export const journeyStepBodySchema = z.object({
  stepNumber: z.coerce.number().int().positive(),
  title: z.string().trim().min(1).max(255),
  content: z.string().trim().min(1),
  xpReward: z.coerce.number().int().min(0).default(0),
});

export const journeyStepUpdateBodySchema = z
  .object({
    stepNumber: z.coerce.number().int().positive().optional(),
    title: z.string().trim().min(1).max(255).optional(),
    content: z.string().trim().min(1).optional(),
    xpReward: z.coerce.number().int().min(0).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'At least one field is required' });

export const tripListQuerySchema = listQuerySchema.extend({
  destination: z.string().trim().min(1).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  sort: z.enum(['startDate', 'endDate', 'createdAt', 'updatedAt', 'title']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export const conversationListQuerySchema = listQuerySchema.extend({
  sort: z.enum(['createdAt', 'updatedAt', 'title']).default('updatedAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export const transactionListQuerySchema = listQuerySchema.extend({
  type: z.enum(['GRANT', 'CONSUME', 'REFUND', 'BONUS', 'ADJUSTMENT']).optional(),
  source: z.enum(['CHAT', 'IMAGE', 'FILE_UPLOAD', 'OCR', 'VOICE', 'PURCHASE', 'ADMIN']).optional(),
  userId: z.string().uuid().optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  sort: z.enum(['createdAt', 'tokens']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export const notificationListQuerySchema = listQuerySchema.extend({
  type: z.enum(['INFO', 'SUCCESS', 'WARNING', 'ERROR', 'SYSTEM']).optional(),
  isRead: toBoolean.optional(),
  userId: z.string().uuid().optional(),
  sort: z.enum(['createdAt']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export const notificationCreateBodySchema = z.object({
  type: z.enum(['INFO', 'SUCCESS', 'WARNING', 'ERROR', 'SYSTEM']).default('INFO'),
  title: z.string().trim().min(1).max(200),
  message: z.string().trim().min(1).max(5000),
  data: z.record(z.unknown()).optional(),
  userId: z.string().uuid().optional().describe('Optional single recipient; omit to broadcast to all users'),
});

export const auditLogListQuerySchema = listQuerySchema.extend({
  action: z.string().trim().min(1).optional(),
  actorId: z.string().uuid().optional(),
  targetUserId: z.string().uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
