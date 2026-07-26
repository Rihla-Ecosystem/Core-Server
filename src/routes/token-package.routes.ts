import { Router } from 'express';
import * as tokenPackageController from '../controllers/token-package.controller.js';

const router = Router();

router.get('/', tokenPackageController.getTokenPackages);

export default router;
