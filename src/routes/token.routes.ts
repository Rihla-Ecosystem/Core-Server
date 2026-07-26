import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import * as tokenController from '../controllers/token.controller.js';

const router = Router();

router.get('/wallet', authenticate, tokenController.getWalletBalance);
router.get('/transactions', authenticate, tokenController.getTokenTransactions);

export default router;
