-- CreateEnum
CREATE TYPE "IncidentReportType" AS ENUM ('SAFETY', 'SCAM', 'SERVICE', 'DAMAGE', 'ACCESSIBILITY', 'OTHER');

-- CreateEnum
CREATE TYPE "IncidentReportSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "IncidentReportStatus" AS ENUM ('PENDING', 'IN_REVIEW', 'RESOLVED', 'REJECTED');

-- CreateTable
CREATE TABLE "incident_reports" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "IncidentReportType" NOT NULL,
    "severity" "IncidentReportSeverity" NOT NULL,
    "description" TEXT NOT NULL,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "related_site_name" VARCHAR(255),
    "status" "IncidentReportStatus" NOT NULL DEFAULT 'PENDING',
    "admin_notes" TEXT,
    "reviewed_by" VARCHAR(255),
    "reviewed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "incident_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "incident_reports_user_id_created_at_idx" ON "incident_reports"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "incident_reports_status_idx" ON "incident_reports"("status");

-- AddForeignKey
ALTER TABLE "incident_reports" ADD CONSTRAINT "incident_reports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
