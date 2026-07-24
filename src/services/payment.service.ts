import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { AppError } from '../middleware/errorHandler.js';
import { createPaymobIntention } from './paymob.service.js';
import type { PaymobBillingData, PaymobIntentionResult } from './paymob.service.js';

export interface ClientBillingData {
  first_name: string;
  last_name: string;
  email: string;
  phone_number: string;
  apartment?: string;
  floor?: string;
  street?: string;
  building?: string;
  shipping_method?: string;
  postal_code?: string;
  city?: string;
  country?: string;
  state?: string;
}

export interface CreatePaymentIntentionInput {
  userId: string;
  tokenPackageId: number;
  billingData: ClientBillingData;
}

export interface CreatePaymentIntentionResult {
  paymentId: string;
  intentionId: string;
  clientSecret: string;
  /** Amount in major currency units as stored in the database (e.g. "100.00" EGP) */
  amount: string;
  currency: string;
  tokens: number;
  packageName: string;
}

/**
 * Converts a Prisma Decimal price to smallest currency units (e.g. piasters for EGP).
 * Uses Prisma Decimal arithmetic.
 * Assumes 2 decimal places for the currency (standard for EGP, USD, EUR, etc.).
 */
function priceToSmallestUnit(price: Prisma.Decimal): number {
  const smallestUnitDecimal = price.mul(100);

  if (!smallestUnitDecimal.isInteger() || smallestUnitDecimal.lte(0)) {
    throw new AppError(500, 'Package price cannot be safely converted to smallest currency unit');
  }

  const cents = smallestUnitDecimal.toNumber();

  if (!Number.isSafeInteger(cents)) {
    throw new AppError(500, 'Package price cannot be safely converted to smallest currency unit');
  }

  return cents;
}

/**
 * Creates a pending Payment record and a Paymob payment intention.
 *
 * Flow:
 * 1. Validate the TokenPackage exists and is purchasable.
 * 2. Create a PENDING Payment record (outside any long-lived transaction).
 * 3. Call Paymob to create a payment intention (no DB transaction held open).
 * 4. On Paymob success, update the Payment providerIntentionId separately.
 * 5. On Paymob failure, mark the Payment as FAILED with a fixed safe failure reason and rethrow.
 *
 * Does NOT credit tokens, modify wallets, or create TokenTransactions.
 * Webhook handling will be implemented separately.
 */
export async function createPaymentIntention(
  input: CreatePaymentIntentionInput,
): Promise<CreatePaymentIntentionResult> {
  // 1. Look up the TokenPackage
  const tokenPackage = await prisma.tokenPackage.findUnique({
    where: { id: input.tokenPackageId },
  });

  if (!tokenPackage) {
    throw new AppError(404, 'Token package not found');
  }

  if (!tokenPackage.isActive) {
    throw new AppError(400, 'Token package is not available for purchase');
  }

  if (tokenPackage.tokens <= 0) {
    throw new AppError(400, 'Token package has an invalid token count');
  }

  const price = new Prisma.Decimal(tokenPackage.price);

  if (price.lte(0)) {
    throw new AppError(400, 'Token package has an invalid price');
  }

  if (!tokenPackage.currency || tokenPackage.currency.trim().length === 0) {
    throw new AppError(400, 'Token package has an invalid currency');
  }

  // 2. Convert price to smallest currency unit (cents/piasters) precisely
  const amountInCents = priceToSmallestUnit(price);

  // Normalize billing data so all 13 provider fields are present
  const normalizedBillingData: PaymobBillingData = {
    first_name: input.billingData.first_name.trim(),
    last_name: input.billingData.last_name.trim(),
    email: input.billingData.email.trim(),
    phone_number: input.billingData.phone_number.trim(),
    apartment: input.billingData.apartment?.trim() || 'NA',
    floor: input.billingData.floor?.trim() || 'NA',
    street: input.billingData.street?.trim() || 'NA',
    building: input.billingData.building?.trim() || 'NA',
    shipping_method: input.billingData.shipping_method?.trim() || 'NA',
    postal_code: input.billingData.postal_code?.trim() || 'NA',
    city: input.billingData.city?.trim() || 'NA',
    country: input.billingData.country?.trim() || 'EG',
    state: input.billingData.state?.trim() || 'NA',
  };

  // 3. Create a PENDING Payment record (before calling Paymob)
  const payment = await prisma.payment.create({
    data: {
      userId: input.userId,
      tokenPackageId: tokenPackage.id,
      amount: tokenPackage.price,
      currency: tokenPackage.currency,
      status: 'PENDING',
      packageNameSnapshot: tokenPackage.name,
      tokensSnapshot: tokenPackage.tokens,
      priceSnapshot: tokenPackage.price,
      currencySnapshot: tokenPackage.currency,
      provider: 'PAYMOB',
    },
  });

  // 4. Call Paymob (outside of any database transaction)
  let paymobResult: PaymobIntentionResult;
  try {
    paymobResult = await createPaymobIntention({
      amount: amountInCents,
      currency: tokenPackage.currency,
      billing_data: normalizedBillingData,
      special_reference: payment.id,
      items: [
        {
          name: tokenPackage.name,
          amount: amountInCents,
          description: tokenPackage.description ?? undefined,
          quantity: 1,
        },
      ],
    });
  } catch (error) {
    try {
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: 'FAILED',
          failureReason: 'PAYMOB_INTENTION_CREATION_FAILED',
        },
      });
    } catch {
      // Preserve the original Paymob error.
    }
    throw error;
  }

  // 5. Update local Payment record with providerIntentionId separately.
  // Note: Paymob may already contain a valid intention if the local provider-reference update fails.
  // Reconciliation or idempotency will be handled separately.
  try {
    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        providerIntentionId: paymobResult.intentionId,
      },
    });
  } catch {
    throw new AppError(
      500,
      'Payment intention was created but could not be finalized locally',
    );
  }

  return {
    paymentId: payment.id,
    intentionId: paymobResult.intentionId,
    clientSecret: paymobResult.clientSecret,
    amount: price.toFixed(2),
    currency: tokenPackage.currency,
    tokens: tokenPackage.tokens,
    packageName: tokenPackage.name,
  };
}
