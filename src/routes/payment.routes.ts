import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/auth.js';
import * as paymentController from '../controllers/payment.controller.js';

const router = Router();

const billingDataSchema = z.object({
  first_name: z.string().trim().min(1, 'First name is required'),
  last_name: z.string().trim().min(1, 'Last name is required'),
  email: z.string().trim().email('Valid email is required'),
  phone_number: z.string().trim().min(1, 'Phone number is required'),
  apartment: z.string().trim().optional(),
  floor: z.string().trim().optional(),
  street: z.string().trim().optional(),
  building: z.string().trim().optional(),
  shipping_method: z.string().trim().optional(),
  postal_code: z.string().trim().optional(),
  city: z.string().trim().min(1).optional(),
  country: z.string().trim().min(1).optional(),
  state: z.string().trim().optional(),
}).strict();

const createIntentionSchema = z.object({
  tokenPackageId: z.number().int().positive('tokenPackageId must be a positive integer'),
  billing_data: billingDataSchema,
}).strict();

router.post(
  '/intention',
  authenticate,
  validate(createIntentionSchema),
  paymentController.createIntention,
);

router.post('/paymob/webhook', paymentController.handlePaymobWebhook);

export default router;
