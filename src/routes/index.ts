import { Router } from 'express';
import authRoutes from './auth.routes.js';
import userRoutes from './user.routes.js';
import adminRoutes from './admin.routes.js';
import memoryRoutes from './memory.routes.js';
import envRoutes from './env.routes.js';
import geoRoutes from './geo.routes.js';
import chatRoutes from './chat.routes.js';
import safetyRoutes from './safety.routes.js';
import internalRoutes from './internal.routes.js';
import currencyRoutes from './currency.routes.js';
import journeyRoutes from './journey.routes.js';
import paymentRoutes from './payment.routes.js';
import tokenPackageRoutes from './token-package.routes.js';
import tokenRoutes from './token.routes.js';
import * as userController from '../controllers/user.controller.js';

const router = Router();

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/admin', adminRoutes);
router.use('/memory', memoryRoutes);
router.use('/env', envRoutes);
router.use('/geo', geoRoutes);
router.use('/chat', chatRoutes);
router.use('/safety', safetyRoutes);
router.use('/internal', internalRoutes);
router.use('/currency', currencyRoutes);
router.use('/journeys', journeyRoutes);
router.use('/payments', paymentRoutes);
router.use('/token-packages', tokenPackageRoutes);
router.use('/tokens', tokenRoutes);

router.get('/leaderboard', userController.getLeaderboard);

export default router;
