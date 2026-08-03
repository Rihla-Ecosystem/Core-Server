-- CreateEnum
CREATE TYPE "TokenReservationStatus" AS ENUM ('PENDING', 'COMPLETED', 'RELEASED');

-- AlterTable
ALTER TABLE "TokenWallet" ADD COLUMN     "reservedBalance" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "TokenReservation" (
    "id" UUID NOT NULL,
    "walletId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "feature" TEXT NOT NULL,
    "source" "TokenTransactionSource" NOT NULL,
    "tokens" INTEGER NOT NULL,
    "pricingVersion" INTEGER NOT NULL DEFAULT 1,
    "idempotencyKey" TEXT NOT NULL,
    "referenceId" TEXT NOT NULL,
    "status" "TokenReservationStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "settledAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "releaseReason" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TokenReservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TokenReservation_walletId_idx" ON "TokenReservation"("walletId");

-- CreateIndex
CREATE INDEX "TokenReservation_userId_idx" ON "TokenReservation"("userId");

-- CreateIndex
CREATE INDEX "TokenReservation_status_idx" ON "TokenReservation"("status");

-- CreateIndex
CREATE INDEX "TokenReservation_expiresAt_idx" ON "TokenReservation"("expiresAt");

-- CreateIndex
CREATE INDEX "TokenReservation_userId_status_idx" ON "TokenReservation"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TokenReservation_referenceId_key" ON "TokenReservation"("referenceId");

-- CreateIndex
CREATE UNIQUE INDEX "TokenReservation_userId_feature_idempotencyKey_key" ON "TokenReservation"("userId", "feature", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "TokenReservation" ADD CONSTRAINT "TokenReservation_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "TokenWallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TokenReservation" ADD CONSTRAINT "TokenReservation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
