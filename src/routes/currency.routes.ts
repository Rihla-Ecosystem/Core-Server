import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { getCurrencyInfo, getExchangeRates, isSupportedCurrency } from '../services/currency.service.js';

const router = Router();
const ratesSchema = z.object({ base: z.string().transform((value) => value.toUpperCase()).refine(isSupportedCurrency, 'Unsupported currency code').default('USD') });

router.get('/info', authenticate, (_req, res) => res.json(getCurrencyInfo()));
router.get('/rates', authenticate, validate(ratesSchema, 'query'), async (req, res, next) => {
  try { const { base } = req.query as unknown as { base: 'EGP' | 'USD' | 'EUR' | 'GBP' | 'SAR' | 'AED' }; res.json(await getExchangeRates(base)); } catch (error) { next(error); }
});

export default router;
