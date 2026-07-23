import { Router } from 'express';
import authRoutes from './auth.routes.js';
import userRoutes from './user.routes.js';
import adminRoutes from './admin.routes.js';
import memoryRoutes from './memory.routes.js';
import envRoutes from './env.routes.js';
import geoRoutes from './geo.routes.js';
import chatRoutes from './chat.routes.js';
import * as userController from '../controllers/user.controller.js';
import vectorRoutes from "./vector.routes.js";

const router = Router();

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/admin', adminRoutes);
router.use('/memory', memoryRoutes);
router.use('/env', envRoutes);
router.use('/geo', geoRoutes);
router.use('/chat', chatRoutes);
router.use("/vector", vectorRoutes);


router.get('/leaderboard', userController.getLeaderboard);

export default router;
