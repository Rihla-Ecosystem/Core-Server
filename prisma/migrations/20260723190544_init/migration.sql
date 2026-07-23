/*
  Warnings:

  - You are about to drop the column `tokens_remaining` on the `subscriptions` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "subscriptions" DROP COLUMN "tokens_remaining",
ADD COLUMN     "tokensRemaining" INTEGER NOT NULL DEFAULT 0;
