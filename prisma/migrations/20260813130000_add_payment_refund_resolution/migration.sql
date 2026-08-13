ALTER TABLE "PaymentRefund"
  ADD COLUMN "resolvedAt" TIMESTAMPTZ,
  ADD COLUMN "resolvedByAdminId" UUID,
  ADD COLUMN "resolutionNote" TEXT;
CREATE INDEX "PaymentRefund_resolvedByAdminId_idx" ON "PaymentRefund"("resolvedByAdminId");
ALTER TABLE "PaymentRefund" ADD CONSTRAINT "PaymentRefund_resolvedByAdminId_fkey"
  FOREIGN KEY ("resolvedByAdminId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
