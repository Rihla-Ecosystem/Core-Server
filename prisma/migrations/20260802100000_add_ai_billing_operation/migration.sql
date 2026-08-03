-- CreateEnum
CREATE TYPE "AIBillingOperationStatus" AS ENUM ('RESERVED', 'EXECUTION_SUCCEEDED', 'PRICED', 'NON_BILLABLE_CONFIRMED', 'INDETERMINATE', 'REVIEW_REQUIRED', 'SETTLED', 'RELEASED');

-- CreateEnum
CREATE TYPE "AIBillingOperationFailureKind" AS ENUM ('NON_BILLABLE', 'INDETERMINATE');

-- CreateTable
CREATE TABLE "AIBillingOperation" (
    "id" UUID NOT NULL,
    "reservationId" UUID NOT NULL,
    "walletId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "feature" TEXT NOT NULL,
    "source" "TokenTransactionSource" NOT NULL,
    "status" "AIBillingOperationStatus" NOT NULL DEFAULT 'RESERVED',
    "provider" TEXT,
    "model" TEXT,
    "providerRequestId" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "totalTokens" INTEGER,
    "cached" BOOLEAN,
    "audioSeconds" DOUBLE PRECISION,
    "pricingMode" TEXT,
    "pricingFallbackReason" TEXT,
    "actualWalletTokens" INTEGER,
    "billingCurrency" TEXT,
    "rateCardVersion" TEXT,
    "walletPolicyVersion" TEXT,
    "failureKind" "AIBillingOperationFailureKind",
    "failureCode" TEXT,
    "retryable" BOOLEAN,
    "failureReason" TEXT,
    "reviewReason" TEXT,
    "executedAt" TIMESTAMP(3),
    "pricedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AIBillingOperation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AIBillingOperation_reservationId_key" ON "AIBillingOperation"("reservationId");

-- CreateIndex
CREATE INDEX "AIBillingOperation_userId_idx" ON "AIBillingOperation"("userId");

-- CreateIndex
CREATE INDEX "AIBillingOperation_walletId_idx" ON "AIBillingOperation"("walletId");

-- CreateIndex
CREATE INDEX "AIBillingOperation_status_idx" ON "AIBillingOperation"("status");

-- AddForeignKey
ALTER TABLE "AIBillingOperation" ADD CONSTRAINT "AIBillingOperation_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "TokenReservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
