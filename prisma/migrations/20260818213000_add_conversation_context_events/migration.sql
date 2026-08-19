-- CreateEnum
CREATE TYPE "ConversationContextEventStatus" AS ENUM ('PENDING', 'MATERIALIZED', 'FAILED');

-- CreateTable
CREATE TABLE "conversation_context_events" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "business_request_id" VARCHAR(255) NOT NULL,
    "feature" VARCHAR(50) NOT NULL,
    "user_content" TEXT NOT NULL,
    "assistant_content" TEXT NOT NULL,
    "status" "ConversationContextEventStatus" NOT NULL DEFAULT 'PENDING',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "materialized_at" TIMESTAMPTZ,

    CONSTRAINT "conversation_context_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "conversation_context_events_conversation_id_idx" ON "conversation_context_events"("conversation_id");

-- CreateIndex
CREATE INDEX "conversation_context_events_status_idx" ON "conversation_context_events"("status");

-- CreateIndex
CREATE UNIQUE INDEX "unique_conv_br_feature" ON "conversation_context_events"("conversation_id", "business_request_id", "feature");

-- AddForeignKey
ALTER TABLE "conversation_context_events" ADD CONSTRAINT "conversation_context_events_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
