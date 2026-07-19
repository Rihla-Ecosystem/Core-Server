import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/auth.js';
import * as memoryController from '../controllers/memory.controller.js';

const router = Router();

const createTripSchema = z.object({
  title: z.string().min(1).max(255),
  destination: z.string().min(1).max(255),
  start_date: z.string().datetime(),
  end_date: z.string().datetime(),
  itinerary: z.any().optional(),
  notes: z.string().max(5000).optional(),
});

const setPreferenceSchema = z.object({
  key: z.string().min(1).max(100),
  value: z.any(),
});

const createFeedbackSchema = z.object({
  type: z.string().min(1).max(50),
  target_id: z.string().uuid().optional(),
  target_type: z.string().max(50).optional(),
  rating: z.number().int().min(1).max(5).optional(),
  comment: z.string().max(2000).optional(),
});

router.get('/history', authenticate, memoryController.listTrips);
router.post('/history', authenticate, validate(createTripSchema), memoryController.createTrip);
router.delete('/history/:id', authenticate, memoryController.deleteTrip);

router.get('/preferences', authenticate, memoryController.getPreferences);
router.post('/preferences', authenticate, validate(setPreferenceSchema), memoryController.setPreference);

router.post('/feedback', authenticate, validate(createFeedbackSchema), memoryController.createFeedback);

router.get('/summary', authenticate, memoryController.getSummary);

export default router;
