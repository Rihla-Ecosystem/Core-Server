/*
  Warnings:

  - You are about to drop the `subscriptions` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "TokenTransactionType" AS ENUM ('GRANT', 'CONSUME', 'REFUND', 'BONUS', 'ADJUSTMENT', 'EXPIRE');

-- DropForeignKey
ALTER TABLE "subscriptions" DROP CONSTRAINT "subscriptions_paymentPlanId_fkey";

-- DropForeignKey
ALTER TABLE "subscriptions" DROP CONSTRAINT "subscriptions_userId_fkey";

-- AlterTable
ALTER TABLE "payment_plans" ADD COLUMN     "maxMassegsInChat" INTEGER,
ADD COLUMN     "maxRemper" INTEGER,
ADD COLUMN     "tokens" INTEGER;

-- DropTable
DROP TABLE "subscriptions";

-- CreateTable
CREATE TABLE "Subscription" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "paymentPlanId" INTEGER NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TokenTransaction" (
    "id" UUID NOT NULL,
    "subscriptionId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "TokenTransactionType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "source" TEXT,
    "referenceId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TokenTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_userId_key" ON "Subscription"("userId");

-- CreateIndex
CREATE INDEX "TokenTransaction_subscriptionId_idx" ON "TokenTransaction"("subscriptionId");

-- CreateIndex
CREATE INDEX "TokenTransaction_userId_idx" ON "TokenTransaction"("userId");

-- CreateIndex
CREATE INDEX "TokenTransaction_type_idx" ON "TokenTransaction"("type");

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_paymentPlanId_fkey" FOREIGN KEY ("paymentPlanId") REFERENCES "payment_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TokenTransaction" ADD CONSTRAINT "TokenTransaction_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TokenTransaction" ADD CONSTRAINT "TokenTransaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
