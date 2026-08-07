-- CreateEnum
CREATE TYPE "notification_category" AS ENUM ('SAFETY', 'SECURITY', 'WEATHER', 'TRAFFIC', 'TOURIST', 'HISTORICAL', 'EMERGENCY', 'RESTRICTED_AREA', 'PHOTOGRAPHY', 'RECOMMENDATION', 'SYSTEM');

-- CreateEnum
CREATE TYPE "notification_priority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "notification_source" AS ENUM ('SYSTEM', 'AI', 'ADMIN', 'CONTEXT', 'EMERGENCY');

-- CreateEnum
CREATE TYPE "notification_status" AS ENUM ('SCHEDULED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "notification_templates" (
    "id" UUID NOT NULL,
    "code" VARCHAR(100) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "message" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL DEFAULT 'INFO',
    "category" "notification_category" NOT NULL DEFAULT 'SYSTEM',
    "priority" "notification_priority" NOT NULL DEFAULT 'NORMAL',
    "variables" JSONB,
    "data" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "notification_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_history" (
    "id" UUID NOT NULL,
    "template_id" UUID,
    "title" VARCHAR(200) NOT NULL,
    "message" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL DEFAULT 'INFO',
    "category" "notification_category" NOT NULL DEFAULT 'SYSTEM',
    "priority" "notification_priority" NOT NULL DEFAULT 'NORMAL',
    "source" "notification_source" NOT NULL DEFAULT 'ADMIN',
    "audience" JSONB NOT NULL DEFAULT '{}',
    "schedule" JSONB,
    "status" "notification_status" NOT NULL DEFAULT 'SCHEDULED',
    "scheduled_at" TIMESTAMPTZ,
    "sent_at" TIMESTAMPTZ,
    "recipients" INTEGER NOT NULL DEFAULT 0,
    "delivered" INTEGER NOT NULL DEFAULT 0,
    "read" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "notification_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_inbox" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "history_id" UUID,
    "template_id" UUID,
    "context_report_id" UUID,
    "type" "NotificationType" NOT NULL DEFAULT 'INFO',
    "category" "notification_category" NOT NULL DEFAULT 'SYSTEM',
    "priority" "notification_priority" NOT NULL DEFAULT 'NORMAL',
    "source" "notification_source" NOT NULL DEFAULT 'SYSTEM',
    "title" VARCHAR(200) NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB,
    "cooldown_key" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "read_at" TIMESTAMPTZ,
    "delivered_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_inbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_analytics" (
    "id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "total_sent" INTEGER NOT NULL DEFAULT 0,
    "total_delivered" INTEGER NOT NULL DEFAULT 0,
    "total_read" INTEGER NOT NULL DEFAULT 0,
    "total_unread" INTEGER NOT NULL DEFAULT 0,
    "byCategory" JSONB,
    "byPriority" JSONB,
    "bySource" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "notification_analytics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_logs" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "notification_id" UUID,
    "history_id" UUID,
    "event" VARCHAR(50) NOT NULL,
    "detail" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_notification_status" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "last_lat" DOUBLE PRECISION,
    "last_lng" DOUBLE PRECISION,
    "last_reported_at" TIMESTAMPTZ,
    "last_sync_at" TIMESTAMPTZ,
    "active_geofences" JSONB,
    "preferences" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "user_notification_status_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "context_reports" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "area_name" TEXT,
    "context" JSONB,
    "report" JSONB,
    "notifications" JSONB,
    "summary" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "context_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notification_templates_code_key" ON "notification_templates"("code");

-- CreateIndex
CREATE INDEX "notification_templates_category_idx" ON "notification_templates"("category");

-- CreateIndex
CREATE INDEX "notification_templates_is_active_idx" ON "notification_templates"("is_active");

-- CreateIndex
CREATE INDEX "notification_history_status_idx" ON "notification_history"("status");

-- CreateIndex
CREATE INDEX "notification_history_category_idx" ON "notification_history"("category");

-- CreateIndex
CREATE INDEX "notification_history_created_at_idx" ON "notification_history"("created_at");

-- CreateIndex
CREATE INDEX "notification_inbox_user_id_is_read_idx" ON "notification_inbox"("user_id", "is_read");

-- CreateIndex
CREATE INDEX "notification_inbox_user_id_created_at_idx" ON "notification_inbox"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "notification_inbox_history_id_idx" ON "notification_inbox"("history_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_inbox_user_id_cooldown_key_key" ON "notification_inbox"("user_id", "cooldown_key");

-- CreateIndex
CREATE UNIQUE INDEX "notification_analytics_date_key" ON "notification_analytics"("date");

-- CreateIndex
CREATE INDEX "notification_logs_user_id_created_at_idx" ON "notification_logs"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "notification_logs_history_id_idx" ON "notification_logs"("history_id");

-- CreateIndex
CREATE INDEX "notification_logs_notification_id_idx" ON "notification_logs"("notification_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_notification_status_user_id_key" ON "user_notification_status"("user_id");

-- CreateIndex
CREATE INDEX "context_reports_user_id_created_at_idx" ON "context_reports"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "notification_templates" ADD CONSTRAINT "notification_templates_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_history" ADD CONSTRAINT "notification_history_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_history" ADD CONSTRAINT "notification_history_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "notification_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_inbox" ADD CONSTRAINT "notification_inbox_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_inbox" ADD CONSTRAINT "notification_inbox_history_id_fkey" FOREIGN KEY ("history_id") REFERENCES "notification_history"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_inbox" ADD CONSTRAINT "notification_inbox_context_report_id_fkey" FOREIGN KEY ("context_report_id") REFERENCES "context_reports"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_notification_status" ADD CONSTRAINT "user_notification_status_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "context_reports" ADD CONSTRAINT "context_reports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
