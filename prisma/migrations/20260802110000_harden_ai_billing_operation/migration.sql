-- Harden AIBillingOperation evidence model.
-- Rename existing identity columns to explicit actual identity columns.
ALTER TABLE "AIBillingOperation" RENAME COLUMN "provider" TO "actualProvider";

ALTER TABLE "AIBillingOperation" RENAME COLUMN "model" TO "actualModel";

-- Replace free-text review reason with a bounded machine-readable code.
ALTER TABLE "AIBillingOperation" RENAME COLUMN "reviewReason" TO "reviewReasonCode";

-- Drop the unsafe raw failure text column.
ALTER TABLE "AIBillingOperation" DROP COLUMN "failureReason";

-- Add explicit external operation identity, immutable reservation snapshot,
-- requested identity, dispatch evidence, and finalization evidence.
-- The table is verified empty before applying these NOT NULL columns.
ALTER TABLE "AIBillingOperation" ADD COLUMN "operationId" TEXT NOT NULL;

ALTER TABLE "AIBillingOperation" ADD COLUMN "reservedTokens" INTEGER NOT NULL;

ALTER TABLE "AIBillingOperation" ADD COLUMN "reservationPricingVersion" INTEGER NOT NULL;

ALTER TABLE "AIBillingOperation" ADD COLUMN "requestedProvider" TEXT;

ALTER TABLE "AIBillingOperation" ADD COLUMN "requestedModel" TEXT;

ALTER TABLE "AIBillingOperation" ADD COLUMN "providerRequestSent" BOOLEAN;

ALTER TABLE "AIBillingOperation" ADD COLUMN "consumeTransactionId" TEXT;

-- Remove obsolete single-column indexes (replaced by compound indexes below).
DROP INDEX "AIBillingOperation_userId_idx";

DROP INDEX "AIBillingOperation_walletId_idx";

DROP INDEX "AIBillingOperation_status_idx";

-- CreateIndex
CREATE UNIQUE INDEX "AIBillingOperation_operationId_key" ON "AIBillingOperation"("operationId");

-- CreateIndex
CREATE INDEX "AIBillingOperation_status_updatedAt_idx" ON "AIBillingOperation"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "AIBillingOperation_walletId_status_idx" ON "AIBillingOperation"("walletId", "status");

-- CreateIndex
CREATE INDEX "AIBillingOperation_userId_createdAt_idx" ON "AIBillingOperation"("userId", "createdAt");
