-- CreateEnum
CREATE TYPE "WalletStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'BLOCKED');

-- CreateEnum
CREATE TYPE "TokenTransactionSource" AS ENUM ('CHAT', 'IMAGE', 'FILE_UPLOAD', 'OCR', 'VOICE', 'PURCHASE', 'ADMIN');

-- AlterEnum
BEGIN;
CREATE TYPE "TokenTransactionType_new" AS ENUM ('GRANT', 'CONSUME', 'REFUND', 'BONUS', 'ADJUSTMENT');
ALTER TABLE "TokenTransaction" ALTER COLUMN "type" TYPE "TokenTransactionType_new" USING ("type"::text::"TokenTransactionType_new");
ALTER TYPE "TokenTransactionType" RENAME TO "TokenTransactionType_old";
ALTER TYPE "TokenTransactionType_new" RENAME TO "TokenTransactionType";
DROP TYPE "public"."TokenTransactionType_old";
COMMIT;

-- DropForeignKey
ALTER TABLE "Subscription" DROP CONSTRAINT "Subscription_paymentPlanId_fkey";

-- DropForeignKey
ALTER TABLE "Subscription" DROP CONSTRAINT "Subscription_userId_fkey";

-- DropForeignKey
ALTER TABLE "TokenTransaction" DROP CONSTRAINT "TokenTransaction_subscriptionId_fkey";

-- DropForeignKey
ALTER TABLE "TokenTransaction" DROP CONSTRAINT "TokenTransaction_userId_fkey";

-- DropForeignKey
ALTER TABLE "payments" DROP CONSTRAINT "payments_paymentPlanId_fkey";

-- DropForeignKey
ALTER TABLE "payments" DROP CONSTRAINT "payments_userId_fkey";

-- DropIndex
DROP INDEX "TokenTransaction_subscriptionId_idx";

-- AlterTable
ALTER TABLE "TokenTransaction" DROP COLUMN "amount",
DROP COLUMN "subscriptionId",
ADD COLUMN     "paymentId" UUID,
ADD COLUMN     "tokens" INTEGER NOT NULL,
ADD COLUMN     "walletId" UUID NOT NULL,
DROP COLUMN "source",
ADD COLUMN     "source" "TokenTransactionSource" NOT NULL;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "deleted_at" TIMESTAMPTZ,
ADD COLUMN     "is_deleted" BOOLEAN NOT NULL DEFAULT false;

-- DropTable
DROP TABLE "Subscription";

-- DropTable
DROP TABLE "payment_plans";

-- DropTable
DROP TABLE "payments";

-- DropEnum
DROP TYPE "SubscriptionStatus";

-- CreateTable
CREATE TABLE "TokenPackage" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "code" TEXT NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "tokens" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TokenPackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenPackageId" INTEGER NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "packageNameSnapshot" TEXT NOT NULL,
    "tokensSnapshot" INTEGER NOT NULL,
    "priceSnapshot" DECIMAL(10,2) NOT NULL,
    "currencySnapshot" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'PAYMOB',
    "providerIntentionId" TEXT,
    "providerOrderId" TEXT,
    "providerTransactionId" TEXT,
    "failureReason" TEXT,
    "providerData" JSONB,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TokenWallet" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenBalance" INTEGER NOT NULL DEFAULT 0,
    "status" "WalletStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TokenWallet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TokenPackage_code_key" ON "TokenPackage"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_providerIntentionId_key" ON "Payment"("providerIntentionId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_providerTransactionId_key" ON "Payment"("providerTransactionId");

-- CreateIndex
CREATE INDEX "Payment_userId_idx" ON "Payment"("userId");

-- CreateIndex
CREATE INDEX "Payment_tokenPackageId_idx" ON "Payment"("tokenPackageId");

-- CreateIndex
CREATE INDEX "Payment_status_idx" ON "Payment"("status");

-- CreateIndex
CREATE INDEX "Payment_status_createdAt_idx" ON "Payment"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TokenWallet_userId_key" ON "TokenWallet"("userId");

-- CreateIndex
CREATE INDEX "TokenTransaction_userId_createdAt_idx" ON "TokenTransaction"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "TokenTransaction_walletId_idx" ON "TokenTransaction"("walletId");

-- CreateIndex
CREATE INDEX "TokenTransaction_paymentId_idx" ON "TokenTransaction"("paymentId");

-- CreateIndex
CREATE INDEX "TokenTransaction_createdAt_idx" ON "TokenTransaction"("createdAt");

-- CreateIndex
CREATE INDEX "TokenTransaction_source_idx" ON "TokenTransaction"("source");

-- CreateIndex
CREATE UNIQUE INDEX "TokenTransaction_source_referenceId_key" ON "TokenTransaction"("source", "referenceId");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_tokenPackageId_fkey" FOREIGN KEY ("tokenPackageId") REFERENCES "TokenPackage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TokenWallet" ADD CONSTRAINT "TokenWallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TokenTransaction" ADD CONSTRAINT "TokenTransaction_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "TokenWallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TokenTransaction" ADD CONSTRAINT "TokenTransaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TokenTransaction" ADD CONSTRAINT "TokenTransaction_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
