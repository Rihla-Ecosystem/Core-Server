-- Phase 2F-A versioned provider rate-card snapshots.
-- Immutable versioned copies of the provider-neutral rate card; the active
-- snapshot is materialized at read time. Monetary rates are BIGINT integer
-- micro-USD per 1M units (never decimal money, never Float). The database
-- enforces structural financial safety (non-negative money, positive
-- conversion ratio, valid windows, lifecycle) with CHECK constraints; the pure
-- validator (src/utils/provider-pricing/snapshot.ts) enforces complete domain
-- coherence.
--
-- Entry lookup identity is aligned with the Pricing Engine resolveRate lookup:
-- (provider + model/alias + tier + effective window). billingUnit is NOT an
-- engine resolution dimension, so the unique identity is
-- (snapshotId, provider, model, tier) -- never (…, billingUnit).

-- CreateEnum
CREATE TYPE "provider_rate_card_snapshot_status" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "provider_rate_card_entry_status" AS ENUM ('STABLE', 'PREVIEW', 'DEPRECATED', 'LIMITED_AVAILABILITY');

-- CreateEnum
CREATE TYPE "provider_rate_card_tier" AS ENUM ('STANDARD', 'BATCH', 'PRIORITY', 'FAST_MODE');

-- CreateEnum
CREATE TYPE "provider_rate_card_billing_unit" AS ENUM ('TOKEN', 'IMAGE', 'SECOND', 'MINUTE', 'CHARACTER');

-- CreateEnum
CREATE TYPE "cached_input_accounting_semantic" AS ENUM ('DISJOINT', 'INCLUDED_IN_INPUT');

-- CreateTable
CREATE TABLE "ProviderRateCardSnapshot" (
    "id" UUID NOT NULL,
    "version" TEXT NOT NULL,
    "status" "provider_rate_card_snapshot_status" NOT NULL DEFAULT 'DRAFT',
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "storageUnit" TEXT NOT NULL DEFAULT 'MICROS',
    "engineUnit" TEXT NOT NULL DEFAULT 'NANO_USD',
    "source" TEXT NOT NULL,
    "generatedAt" DATE NOT NULL,
    "provenance" TEXT NOT NULL DEFAULT 'RESEARCH_SNAPSHOT',
    "effectiveFrom" DATE,
    "effectiveTo" DATE,
    "publishedAt" TIMESTAMPTZ,
    "retiredAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderRateCardSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderRateCardEntry" (
    "id" UUID NOT NULL,
    "snapshotId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "status" "provider_rate_card_entry_status" NOT NULL,
    "tier" "provider_rate_card_tier" NOT NULL DEFAULT 'STANDARD',
    "billingUnit" "provider_rate_card_billing_unit" NOT NULL,
    "inputMicrosPerMillion" BIGINT,
    "outputMicrosPerMillion" BIGINT,
    "cachedInputMicrosPerMillion" BIGINT,
    "cachedOutputMicrosPerMillion" BIGINT,
    "perUnitMicros" BIGINT,
    "audioInputMicrosPerMillion" BIGINT,
    "audioOutputMicrosPerMillion" BIGINT,
    "tokensPerSecond" DOUBLE PRECISION,
    "cachedInputAccounting" "cached_input_accounting_semantic",
    "aliases" JSONB,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "inactive" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT,
    "verifiedAt" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderRateCardEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProviderRateCardSnapshot_version_key" ON "ProviderRateCardSnapshot"("version");

-- CreateIndex
CREATE INDEX "ProviderRateCardSnapshot_status_createdAt_idx" ON "ProviderRateCardSnapshot"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ProviderRateCardSnapshot_status_effectiveFrom_effectiveTo_idx" ON "ProviderRateCardSnapshot"("status", "effectiveFrom", "effectiveTo");

-- CreateIndex
CREATE INDEX "ProviderRateCardEntry_snapshotId_idx" ON "ProviderRateCardEntry"("snapshotId");

-- CreateIndex
CREATE INDEX "ProviderRateCardEntry_provider_model_status_idx" ON "ProviderRateCardEntry"("provider", "model", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderRateCardEntry_snapshotId_provider_model_tier_key" ON "ProviderRateCardEntry"("snapshotId", "provider", "model", "tier");

-- AddForeignKey
ALTER TABLE "ProviderRateCardEntry" ADD CONSTRAINT "ProviderRateCardEntry_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "ProviderRateCardSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Structural financial safety (CHECK constraints) ---------------------------

-- All monetary rate columns must be NULL (unpublished) or non-negative.
ALTER TABLE "ProviderRateCardEntry"
  ADD CONSTRAINT "ProviderRateCardEntry_rates_non_negative_ck" CHECK (
    ("inputMicrosPerMillion" IS NULL OR "inputMicrosPerMillion" >= 0)
    AND ("outputMicrosPerMillion" IS NULL OR "outputMicrosPerMillion" >= 0)
    AND ("cachedInputMicrosPerMillion" IS NULL OR "cachedInputMicrosPerMillion" >= 0)
    AND ("cachedOutputMicrosPerMillion" IS NULL OR "cachedOutputMicrosPerMillion" >= 0)
    AND ("perUnitMicros" IS NULL OR "perUnitMicros" >= 0)
    AND ("audioInputMicrosPerMillion" IS NULL OR "audioInputMicrosPerMillion" >= 0)
    AND ("audioOutputMicrosPerMillion" IS NULL OR "audioOutputMicrosPerMillion" >= 0)
  );

-- tokensPerSecond is a conversion ratio, not money: it must be positive.
ALTER TABLE "ProviderRateCardEntry"
  ADD CONSTRAINT "ProviderRateCardEntry_tokens_per_second_positive_ck" CHECK (
    "tokensPerSecond" IS NULL OR "tokensPerSecond" > 0
  );

-- Entry effective window must not be inverted.
ALTER TABLE "ProviderRateCardEntry"
  ADD CONSTRAINT "ProviderRateCardEntry_effective_window_ck" CHECK (
    "effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom"
  );

-- Rate shape derived directly from the engine validator (rate-card.ts):
-- TOKEN entries carry token rates only (no perUnitMicros) and need at least
-- one token rate; non-TOKEN entries carry perUnitMicros only and no
-- token-module rates (modalityRates / tts / cachedInputAccounting).
ALTER TABLE "ProviderRateCardEntry"
  ADD CONSTRAINT "ProviderRateCardEntry_rate_shape_ck" CHECK (
    (
      "billingUnit" = 'TOKEN'
      AND "perUnitMicros" IS NULL
      AND (
        "inputMicrosPerMillion" IS NOT NULL
        OR "outputMicrosPerMillion" IS NOT NULL
        OR "cachedInputMicrosPerMillion" IS NOT NULL
        OR "cachedOutputMicrosPerMillion" IS NOT NULL
      )
    )
    OR (
      "billingUnit" <> 'TOKEN'
      AND "perUnitMicros" IS NOT NULL
      AND "inputMicrosPerMillion" IS NULL
      AND "outputMicrosPerMillion" IS NULL
      AND "cachedInputMicrosPerMillion" IS NULL
      AND "cachedOutputMicrosPerMillion" IS NULL
      AND "audioInputMicrosPerMillion" IS NULL
      AND "audioOutputMicrosPerMillion" IS NULL
      AND "tokensPerSecond" IS NULL
      AND "cachedInputAccounting" IS NULL
    )
  );

-- A declared cached-input accounting semantic requires its cached-input rate.
ALTER TABLE "ProviderRateCardEntry"
  ADD CONSTRAINT "ProviderRateCardEntry_cached_semantic_requires_rate_ck" CHECK (
    "cachedInputAccounting" IS NULL OR "cachedInputMicrosPerMillion" IS NOT NULL
  );

-- Snapshot business validity window must not be inverted (effectiveTo set
-- requires an effectiveFrom no later than it).
ALTER TABLE "ProviderRateCardSnapshot"
  ADD CONSTRAINT "ProviderRateCardSnapshot_effective_window_ck" CHECK (
    "effectiveTo" IS NULL
    OR ("effectiveFrom" IS NOT NULL AND "effectiveTo" >= "effectiveFrom")
  );

-- Snapshot lifecycle consistency:
--  - DRAFT:   never published, never retired.
--  - ACTIVE:  published, has an effectiveFrom, never retired.
--  - RETIRED: published, has an effectiveFrom, retired at or after publish.
-- Overlapping ACTIVE effective windows are validated transactionally in the
-- publishing/service layer (Phase 2F-B/2F-C), not with a wall-clock CHECK.
ALTER TABLE "ProviderRateCardSnapshot"
  ADD CONSTRAINT "ProviderRateCardSnapshot_lifecycle_ck" CHECK (
    ("status" = 'DRAFT' AND "publishedAt" IS NULL AND "retiredAt" IS NULL)
    OR (
      "status" = 'ACTIVE'
      AND "publishedAt" IS NOT NULL
      AND "effectiveFrom" IS NOT NULL
      AND "retiredAt" IS NULL
    )
    OR (
      "status" = 'RETIRED'
      AND "publishedAt" IS NOT NULL
      AND "effectiveFrom" IS NOT NULL
      AND "retiredAt" IS NOT NULL
      AND "retiredAt" >= "publishedAt"
    )
  );
