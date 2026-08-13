CREATE TYPE "PaymentRefundStatus" AS ENUM ('HOLD_CREATED', 'PROVIDER_PENDING', 'SUCCEEDED', 'FAILED', 'INDETERMINATE', 'REVIEW_REQUIRED');

ALTER TABLE "TokenFundingLot"
  ADD COLUMN "refundHeldTokens" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "refundedTokens" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "TokenFundingLot" DROP CONSTRAINT "TokenFundingLot_nonnegative";
ALTER TABLE "TokenFundingLot" DROP CONSTRAINT "TokenFundingLot_reconciles";
ALTER TABLE "TokenFundingLot" ADD CONSTRAINT "TokenFundingLot_nonnegative"
  CHECK ("originalTokens" > 0 AND "availableTokens" >= 0 AND "reservedTokens" >= 0 AND "refundHeldTokens" >= 0 AND "consumedTokens" >= 0 AND "refundedTokens" >= 0);
ALTER TABLE "TokenFundingLot" ADD CONSTRAINT "TokenFundingLot_reconciles"
  CHECK ("originalTokens" = "availableTokens" + "reservedTokens" + "refundHeldTokens" + "consumedTokens" + "refundedTokens");

CREATE TABLE "PaymentRefund" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "paymentId" UUID NOT NULL,
  "fundingLotId" UUID NOT NULL,
  "requestedByAdminId" UUID,
  "tokenAmount" INTEGER NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "originalProviderTransactionId" TEXT NOT NULL,
  "providerRefundTransactionId" TEXT,
  "status" "PaymentRefundStatus" NOT NULL DEFAULT 'HOLD_CREATED',
  "failureReason" TEXT,
  "providerData" JSONB,
  "completedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "PaymentRefund_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PaymentRefund_paymentId_key" UNIQUE ("paymentId"),
  CONSTRAINT "PaymentRefund_fundingLotId_key" UNIQUE ("fundingLotId"),
  CONSTRAINT "PaymentRefund_providerRefundTransactionId_key" UNIQUE ("providerRefundTransactionId"),
  CONSTRAINT "PaymentRefund_amounts_positive" CHECK ("tokenAmount" > 0 AND "amountCents" > 0)
);
CREATE INDEX "PaymentRefund_status_updatedAt_idx" ON "PaymentRefund"("status", "updatedAt");
CREATE INDEX "PaymentRefund_requestedByAdminId_idx" ON "PaymentRefund"("requestedByAdminId");
ALTER TABLE "PaymentRefund" ADD CONSTRAINT "PaymentRefund_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentRefund" ADD CONSTRAINT "PaymentRefund_fundingLotId_fkey" FOREIGN KEY ("fundingLotId") REFERENCES "TokenFundingLot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentRefund" ADD CONSTRAINT "PaymentRefund_requestedByAdminId_fkey" FOREIGN KEY ("requestedByAdminId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
