import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { env } from '../config/env.js';
import { prisma } from '../config/prisma.js';
import { AppError } from '../middleware/errorHandler.js';

export interface ValidatedPaymobWebhookData {
  transactionId: string;
  amountCents: number;
  currency: string;
  integrationId: number;
  success: boolean;
  pending: boolean;
  errorOccured: boolean;
  isRefunded: boolean;
  isVoided: boolean;
  paymentId: string;
}

/**
 * Type guard for non-null, non-array objects.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates whether a string is a syntactically valid UUID (v1-v5).
 */
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

/**
 * Verifies Paymob SHA-512 HMAC signature using timing-safe comparison on decoded hex bytes.
 */
export function verifyPaymobHmac(payload: unknown, hmacParam: unknown): boolean {
  if (typeof hmacParam !== 'string' || !hmacParam.trim()) {
    return false;
  }

  const cleanHmac = hmacParam.trim().toLowerCase();
  // SHA-512 hex string length is exactly 128 characters
  if (!/^[0-9a-f]{128}$/.test(cleanHmac)) {
    return false;
  }

  if (!isRecord(payload)) {
    return false;
  }

  if (payload.type !== 'TRANSACTION' || !isRecord(payload.obj)) {
    return false;
  }

  const obj = payload.obj;
  if (!isRecord(obj.order) || !isRecord(obj.source_data)) {
    return false;
  }

  const orderObj = obj.order;
  const sourceDataObj = obj.source_data;

  // Strict validation of all 20 fields prior to HMAC calculation
  const booleanFields = [
    obj.error_occured,
    obj.has_parent_transaction,
    obj.is_3d_secure,
    obj.is_auth,
    obj.is_capture,
    obj.is_refunded,
    obj.is_standalone_payment,
    obj.is_voided,
    obj.pending,
    obj.success,
  ];

  for (const bf of booleanFields) {
    if (typeof bf !== 'boolean') {
      return false;
    }
  }

  if (
    typeof obj.amount_cents !== 'number' ||
    !Number.isInteger(obj.amount_cents) ||
    !Number.isSafeInteger(obj.amount_cents) ||
    obj.amount_cents <= 0
  ) {
    return false;
  }

  if (
    typeof obj.integration_id !== 'number' ||
    !Number.isInteger(obj.integration_id) ||
    !Number.isSafeInteger(obj.integration_id) ||
    obj.integration_id <= 0
  ) {
    return false;
  }

  if (
    (typeof obj.id !== 'number' || !Number.isFinite(obj.id)) &&
    (typeof obj.id !== 'string' || !obj.id.trim())
  ) {
    return false;
  }

  if (
    (typeof orderObj.id !== 'number' || !Number.isFinite(orderObj.id)) &&
    (typeof orderObj.id !== 'string' || !orderObj.id.trim())
  ) {
    return false;
  }

  if (
    (typeof obj.owner !== 'number' || !Number.isFinite(obj.owner)) &&
    (typeof obj.owner !== 'string' || !obj.owner.trim())
  ) {
    return false;
  }

  if (typeof obj.created_at !== 'string' || !obj.created_at.trim()) {
    return false;
  }

  if (typeof obj.currency !== 'string' || !obj.currency.trim()) {
    return false;
  }

  if (typeof sourceDataObj.pan !== 'string') {
    return false;
  }

  if (typeof sourceDataObj.sub_type !== 'string') {
    return false;
  }

  if (typeof sourceDataObj.type !== 'string') {
    return false;
  }

  // Exact 20 HMAC fields in documented order
  const fields = [
    obj.amount_cents,
    obj.created_at,
    obj.currency,
    obj.error_occured,
    obj.has_parent_transaction,
    obj.id,
    obj.integration_id,
    obj.is_3d_secure,
    obj.is_auth,
    obj.is_capture,
    obj.is_refunded,
    obj.is_standalone_payment,
    obj.is_voided,
    orderObj.id,
    obj.owner,
    obj.pending,
    sourceDataObj.pan,
    sourceDataObj.sub_type,
    sourceDataObj.type,
    obj.success,
  ];

  const concatenated = fields.map((v) => String(v)).join('');
  const calculatedHex = crypto
    .createHmac('sha512', env.PAYMOB_HMAC_SECRET)
    .update(concatenated)
    .digest('hex')
    .toLowerCase();

  const calculatedBuffer = Buffer.from(calculatedHex, 'hex');
  const receivedBuffer = Buffer.from(cleanHmac, 'hex');

  if (calculatedBuffer.length !== receivedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(calculatedBuffer, receivedBuffer);
}

/**
 * Validates the runtime shape of the Paymob transaction processed callback.
 */
export function validateWebhookPayload(payload: unknown): ValidatedPaymobWebhookData {
  if (!isRecord(payload)) {
    throw new AppError(400, 'Invalid webhook payload format');
  }

  if (payload.type !== 'TRANSACTION') {
    throw new AppError(400, 'Unsupported webhook callback type');
  }

  if (!isRecord(payload.obj)) {
    throw new AppError(400, 'Invalid transaction object in webhook payload');
  }

  const obj = payload.obj;

  if (!isRecord(obj.order)) {
    throw new AppError(400, 'Invalid order structure in webhook payload');
  }

  const rawTxId = obj.id;
  if (
    (typeof rawTxId !== 'string' || !rawTxId.trim()) &&
    (typeof rawTxId !== 'number' || !Number.isFinite(rawTxId))
  ) {
    throw new AppError(400, 'Missing or invalid transaction ID');
  }
  const transactionId = String(rawTxId).trim();

  if (typeof obj.success !== 'boolean') {
    throw new AppError(400, 'Invalid or missing success flag');
  }
  if (typeof obj.pending !== 'boolean') {
    throw new AppError(400, 'Invalid or missing pending flag');
  }
  if (typeof obj.error_occured !== 'boolean') {
    throw new AppError(400, 'Invalid or missing error_occured flag');
  }
  if (typeof obj.is_refunded !== 'boolean') {
    throw new AppError(400, 'Invalid or missing is_refunded flag');
  }
  if (typeof obj.is_voided !== 'boolean') {
    throw new AppError(400, 'Invalid or missing is_voided flag');
  }

  const amountCents = obj.amount_cents;
  if (
    typeof amountCents !== 'number' ||
    !Number.isInteger(amountCents) ||
    !Number.isSafeInteger(amountCents) ||
    amountCents <= 0
  ) {
    throw new AppError(400, 'Invalid amount_cents in webhook payload');
  }

  if (typeof obj.currency !== 'string' || !obj.currency.trim()) {
    throw new AppError(400, 'Invalid currency in webhook payload');
  }
  const currency = obj.currency.trim().toUpperCase();

  if (
    typeof obj.integration_id !== 'number' ||
    !Number.isInteger(obj.integration_id) ||
    !Number.isSafeInteger(obj.integration_id) ||
    obj.integration_id <= 0
  ) {
    throw new AppError(400, 'Invalid integration_id in webhook payload');
  }
  const integrationId = obj.integration_id;

  const merchantOrderId = obj.order.merchant_order_id;
  if (
    typeof merchantOrderId !== 'string' ||
    !merchantOrderId.trim() ||
    !isUuid(merchantOrderId.trim())
  ) {
    throw new AppError(400, 'Invalid payment reference in webhook payload');
  }
  const paymentId = merchantOrderId.trim();

  return {
    transactionId,
    amountCents,
    currency,
    integrationId,
    success: obj.success,
    pending: obj.pending,
    errorOccured: obj.error_occured,
    isRefunded: obj.is_refunded,
    isVoided: obj.is_voided,
    paymentId,
  };
}

/**
 * Converts Decimal price to smallest unit (cents/piasters) with precision checks.
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
 * Processes Paymob Transaction Processed webhook payload with HMAC verification,
 * business validations, atomic status claim, wallet crediting, and TokenTransaction creation.
 */
export async function processPaymobWebhook(payload: unknown, hmacParam: unknown): Promise<void> {
  // 1. Verify HMAC signature BEFORE any database access
  if (!verifyPaymobHmac(payload, hmacParam)) {
    throw new AppError(403, 'Invalid HMAC signature');
  }

  // 2. Validate webhook callback structure
  const data = validateWebhookPayload(payload);

  // 3. Locate Payment by internal Payment ID
  const payment = await prisma.payment.findUnique({
    where: { id: data.paymentId },
  });

  if (!payment) {
    // Safe acknowledgment for unrecognized payment ID
    return;
  }

  // 4. Business validations - throw 409 mismatch if payment state or parameters do not align
  if (payment.provider !== 'PAYMOB') {
    throw new AppError(409, 'Webhook transaction does not match the payment');
  }

  if (data.integrationId !== env.PAYMOB_CARD_INTEGRATION_ID) {
    throw new AppError(409, 'Webhook transaction does not match the payment');
  }

  if (!payment.priceSnapshot || !payment.currencySnapshot || !payment.tokensSnapshot || payment.tokensSnapshot <= 0) {
    throw new AppError(409, 'Webhook transaction does not match the payment');
  }

  const expectedCurrency = payment.currencySnapshot.trim().toUpperCase();
  if (data.currency !== expectedCurrency) {
    throw new AppError(409, 'Webhook transaction does not match the payment');
  }

  const expectedPriceDecimal = new Prisma.Decimal(payment.priceSnapshot);
  const expectedCents = priceToSmallestUnit(expectedPriceDecimal);
  if (data.amountCents !== expectedCents) {
    throw new AppError(409, 'Webhook transaction does not match the payment');
  }

  // 5. Handle Refund / Void flags
  if (data.isRefunded || data.isVoided) {
    // Safely acknowledge; refund/void handling is out of scope for this phase
    return;
  }

  // 6. Handle pending transactions
  if (data.pending) {
    // Leave Payment as PENDING; do not alter wallet or create transactions
    return;
  }

  // 7. Evaluate transaction result for failure
  const isSuccessful = data.success === true && data.errorOccured === false;

  if (!isSuccessful) {
    // Transaction failed or declined (pending === false, success === false or errorOccured === true)
    await prisma.payment.updateMany({
      where: {
        id: payment.id,
        status: 'PENDING',
      },
      data: {
        status: 'FAILED',
        providerTransactionId: data.transactionId,
        failureReason: 'PAYMOB_PAYMENT_FAILED',
      },
    });
    return;
  }

  // 8. Atomic transaction for successful payment completion
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Claim Payment status atomically
    const updateResult = await tx.payment.updateMany({
      where: {
        id: payment.id,
        status: 'PENDING',
      },
      data: {
        status: 'COMPLETED',
        providerTransactionId: data.transactionId,
        paidAt: new Date(),
        failureReason: null,
      },
    });

    if (updateResult.count === 0) {
      const currentPayment = await tx.payment.findUnique({
        where: { id: payment.id },
      });

      if (currentPayment?.status === 'COMPLETED') {
        if (currentPayment.providerTransactionId === data.transactionId) {
          // Idempotent retry of already processed transaction
          return;
        }
        throw new AppError(409, 'Webhook transaction does not match the payment');
      }
      return;
    }

    // Upsert TokenWallet
    const wallet = await tx.tokenWallet.upsert({
      where: { userId: payment.userId },
      create: {
        userId: payment.userId,
        tokenBalance: payment.tokensSnapshot,
        status: 'ACTIVE',
      },
      update: {
        tokenBalance: {
          increment: payment.tokensSnapshot,
        },
      },
    });

    // Create TokenTransaction
    await tx.tokenTransaction.create({
      data: {
        walletId: wallet.id,
        userId: payment.userId,
        type: 'GRANT',
        tokens: payment.tokensSnapshot,
        source: 'PURCHASE',
        paymentId: payment.id,
        referenceId: data.transactionId,
        metadata: {
          paymentId: payment.id,
          tokenPackageId: payment.tokenPackageId,
          packageNameSnapshot: payment.packageNameSnapshot,
        },
      },
    });
  });
}
