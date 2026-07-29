import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { chat } from '../services/chat.service.js';

const router = Router();

const chatSchema = z.object({
  message: z.string().min(1).max(10000),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lon: z.coerce.number().min(-180).max(180).optional(),
  conversation_id: z.string().uuid().optional(),
  persona: z.enum(['auto', 'tour_guide', 'local_expert', 'safety_guru']).default('auto'),
});

/**
 * @openapi
 * /chat:
 *   post:
 *     tags: [Chat]
 *     summary: Send a message to the AI assistant
 *     description: >
 *       Proxies the message to the AI service enriched with the user profile,
 *       spatial context (GeoContext), environmental context, and safety data
 *       (Risk Intelligence). Rewards 2 XP per message, capped at 20 XP/day.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [message]
 *             properties:
 *               message:
 *                 type: string
 *                 minLength: 1
 *                 maxLength: 10000
 *               lat:
 *                 type: number
 *                 description: User's current latitude (enables location-aware responses)
 *               lon:
 *                 type: number
 *                 description: User's current longitude
 *               conversation_id:
 *                 type: string
 *                 format: uuid
 *                 description: Existing conversation to continue; omit to start a new one
 *               persona:
 *                 type: string
 *                 enum: [auto, tour_guide, local_expert, safety_guru]
 *                 default: auto
 *                 description: AI persona to route to (auto = intent-detected)
 *     responses:
 *       200:
 *         description: AI response
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 response: { type: string }
 *                 conversation_id: { type: string, format: uuid }
 *                 persona: { type: string }
 *                 blocked: { type: boolean }
 *                 reason: { type: string }
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       502:
 *         description: AI service unavailable
 */
router.post(
  '/',
  authenticate,
  validate(chatSchema),
  asyncHandler(async (req, res) => {
    const { message, lat, lon, conversation_id, persona } = req.body as z.infer<typeof chatSchema>;
    const result = await chat(req.user!.userId, message, {
      lat,
      lon,
      conversationId: conversation_id,
      persona,
    });
    res.json(result);
  }),
);

export default router;
