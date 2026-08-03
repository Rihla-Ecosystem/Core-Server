import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/auth.js';
import { uploadAvatar } from '../utils/upload.js';
import * as userController from '../controllers/user.controller.js';

const router = Router();

const updateProfileSchema = z.object({
  display_name: z.string().trim().min(1).max(100).optional(),
  avatar_url: z.string().url().optional(),
  bio: z.string().max(500).optional(),
  gender: z.enum(['MALE', 'FEMALE']).optional(),
  nationality: z.string().trim().min(1).max(100).optional(),
  language: z.array(z.string().trim().min(2).max(10)).max(20).optional(),
  budget_level: z.string().max(50).optional(),
  arrival_date: z.string().datetime().optional(),
  departure_date: z.string().datetime().optional(),
  travel_style: z.string().max(50).optional(),
  interests: z.array(z.string().max(100)).max(50).optional(),
  accommodation_type: z.string().max(50).optional(),
});

const userBadgesParamsSchema = z.object({
  id: z.string().uuid(),
});

/**
 * @openapi
 * /users/me:
 *   get:
 *     tags: [Users]
 *     summary: Get current user profile
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: User profile
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 *       401:
 *         description: Authentication required
 */
router.get('/me', authenticate, userController.getProfile);

/**
 * @openapi
 * /users/me:
 *   patch:
 *     tags: [Users]
 *     summary: Update current user profile
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UpdateProfileInput'
 *     responses:
 *       200:
 *         description: Updated profile
 *       401:
 *         description: Authentication required
 */
router.patch('/me', authenticate, validate(updateProfileSchema), userController.updateProfile);

/**
 * @openapi
 * /users/me/avatar:
 *   post:
 *     tags: [Users]
 *     summary: Upload avatar image
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               avatar:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Avatar uploaded
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AvatarResponse'
 *       400:
 *         description: No file provided or invalid file
 */
router.post('/me/avatar', authenticate, uploadAvatar.single('avatar'), userController.uploadAvatar);

/**
 * @openapi
 * /users/me/avatar:
 *   delete:
 *     tags: [Users]
 *     summary: Remove avatar
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Avatar removed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AvatarResponse'
 */
router.delete('/me/avatar', authenticate, userController.removeAvatar);

/**
 * @openapi
 * /users/me:
 *   delete:
 *     tags: [Users]
 *     summary: Delete own account
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Account deleted
 */
router.delete('/me', authenticate, userController.deleteAccount);

/**
 * @openapi
 * /users/{id}/badges:
 *   get:
 *     tags: [Users]
 *     summary: Get badges for a user
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: List of badges
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Badge'
 */
router.get('/:id/badges', validate(userBadgesParamsSchema, 'params'), userController.getUserBadges);

// all roles endpoint
/**
 * @openapi
 * /roles:
 *   get:
 *     tags: [Users]
 *     summary: Get all roles
 *     responses:
 *       200:
 *         description: List of roles
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Role'
 */
router.get('/roles', userController.getAllRoles);

export default router;
