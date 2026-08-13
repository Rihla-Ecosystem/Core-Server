-- Phase 8B: no backfill is performed. Existing development wallets without
-- deterministic historical allocations must be reset/reconciled before this
-- migration is applied; guessing purchase ownership would make refunds unsafe.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "TokenWallet"
        WHERE "tokenBalance" <> 0 OR "reservedBalance" <> 0
    ) THEN
        RAISE EXCEPTION
            'Phase 8B requires a reset/reconciled development wallet before migration; historical non-zero balances cannot be assigned to funding lots safely.';
    END IF;
END $$;

CREATE TABLE "TokenFundingLot" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "walletId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "source" "TokenTransactionSource" NOT NULL,
    "sourceTransactionId" UUID NOT NULL,
    "paymentId" UUID,
    "originalTokens" INTEGER NOT NULL,
    "availableTokens" INTEGER NOT NULL,
    "reservedTokens" INTEGER NOT NULL DEFAULT 0,
    "consumedTokens" INTEGER NOT NULL DEFAULT 0,
    "refundedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,
    CONSTRAINT "TokenFundingLot_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TokenFundingLot_sourceTransactionId_key" UNIQUE ("sourceTransactionId"),
    CONSTRAINT "TokenFundingLot_paymentId_key" UNIQUE ("paymentId"),
    CONSTRAINT "TokenFundingLot_nonnegative" CHECK ("originalTokens" > 0 AND "availableTokens" >= 0 AND "reservedTokens" >= 0 AND "consumedTokens" >= 0),
    CONSTRAINT "TokenFundingLot_reconciles" CHECK ("originalTokens" = "availableTokens" + "reservedTokens" + "consumedTokens")
);
CREATE INDEX "TokenFundingLot_walletId_createdAt_id_idx" ON "TokenFundingLot"("walletId", "createdAt", "id");
CREATE INDEX "TokenFundingLot_userId_paymentId_idx" ON "TokenFundingLot"("userId", "paymentId");
ALTER TABLE "TokenFundingLot" ADD CONSTRAINT "TokenFundingLot_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "TokenWallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TokenFundingLot" ADD CONSTRAINT "TokenFundingLot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TokenFundingLot" ADD CONSTRAINT "TokenFundingLot_sourceTransactionId_fkey" FOREIGN KEY ("sourceTransactionId") REFERENCES "TokenTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TokenFundingLot" ADD CONSTRAINT "TokenFundingLot_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "TokenReservationFundingAllocation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "reservationId" UUID NOT NULL,
    "fundingLotId" UUID NOT NULL,
    "reservedTokens" INTEGER NOT NULL,
    "consumedTokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,
    CONSTRAINT "TokenReservationFundingAllocation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TokenReservationFundingAllocation_reservationId_fundingLotId_key" UNIQUE ("reservationId", "fundingLotId"),
    CONSTRAINT "TokenReservationFundingAllocation_nonnegative" CHECK ("reservedTokens" > 0 AND "consumedTokens" >= 0 AND "consumedTokens" <= "reservedTokens")
);
CREATE INDEX "TokenReservationFundingAllocation_reservationId_createdAt_id_idx" ON "TokenReservationFundingAllocation"("reservationId", "createdAt", "id");
CREATE INDEX "TokenReservationFundingAllocation_fundingLotId_idx" ON "TokenReservationFundingAllocation"("fundingLotId");
ALTER TABLE "TokenReservationFundingAllocation" ADD CONSTRAINT "TokenReservationFundingAllocation_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "TokenReservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TokenReservationFundingAllocation" ADD CONSTRAINT "TokenReservationFundingAllocation_fundingLotId_fkey" FOREIGN KEY ("fundingLotId") REFERENCES "TokenFundingLot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
