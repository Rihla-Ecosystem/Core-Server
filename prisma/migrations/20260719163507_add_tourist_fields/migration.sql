-- CreateEnum
CREATE TYPE "gender" AS ENUM ('MALE', 'FEMALE');

-- AlterTable: add columns (nullable first for existing rows)
ALTER TABLE "users"
  ADD COLUMN "accommodation_type" VARCHAR(50),
  ADD COLUMN "arrival_date" DATE,
  ADD COLUMN "budget_level" VARCHAR(50),
  ADD COLUMN "departure_date" DATE,
  ADD COLUMN "gender" "gender",
  ADD COLUMN "interests" JSONB DEFAULT '[]',
  ADD COLUMN "languages" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "nationality" VARCHAR(100),
  ADD COLUMN "travel_style" VARCHAR(50);

-- Backfill existing rows
UPDATE "users" SET "gender" = 'MALE' WHERE "gender" IS NULL;
UPDATE "users" SET "nationality" = 'Unknown' WHERE "nationality" IS NULL;

-- Make columns required
ALTER TABLE "users" ALTER COLUMN "gender" SET NOT NULL;
ALTER TABLE "users" ALTER COLUMN "nationality" SET NOT NULL;
