/*
  Warnings:

  - You are about to drop the column `paymentMethod` on the `payments` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "payments" DROP COLUMN "paymentMethod";

-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN     "tokens_remaining" INTEGER NOT NULL DEFAULT 0;

-- DropEnum
DROP TYPE "PaymentMethod";
