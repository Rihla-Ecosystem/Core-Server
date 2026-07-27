-- CreateTable
CREATE TABLE "journeys" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(100) NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "xp_reward" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "journeys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journey_steps" (
    "id" UUID NOT NULL,
    "journey_id" UUID NOT NULL,
    "step_number" INTEGER NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "content" TEXT NOT NULL,
    "xp_reward" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "journey_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_journeys" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "journey_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ,

    CONSTRAINT "user_journeys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_journey_steps" (
    "id" UUID NOT NULL,
    "user_journey_id" UUID NOT NULL,
    "step_id" UUID NOT NULL,
    "completed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_journey_steps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "journeys_slug_key" ON "journeys"("slug");
CREATE UNIQUE INDEX "journey_steps_journey_id_step_number_key" ON "journey_steps"("journey_id", "step_number");
CREATE INDEX "journey_steps_journey_id_idx" ON "journey_steps"("journey_id");
CREATE UNIQUE INDEX "user_journeys_user_id_journey_id_key" ON "user_journeys"("user_id", "journey_id");
CREATE INDEX "user_journeys_user_id_idx" ON "user_journeys"("user_id");
CREATE UNIQUE INDEX "user_journey_steps_user_journey_id_step_id_key" ON "user_journey_steps"("user_journey_id", "step_id");
CREATE INDEX "user_journey_steps_user_journey_id_idx" ON "user_journey_steps"("user_journey_id");

-- AddForeignKey
ALTER TABLE "journey_steps" ADD CONSTRAINT "journey_steps_journey_id_fkey" FOREIGN KEY ("journey_id") REFERENCES "journeys"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_journeys" ADD CONSTRAINT "user_journeys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_journeys" ADD CONSTRAINT "user_journeys_journey_id_fkey" FOREIGN KEY ("journey_id") REFERENCES "journeys"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_journey_steps" ADD CONSTRAINT "user_journey_steps_user_journey_id_fkey" FOREIGN KEY ("user_journey_id") REFERENCES "user_journeys"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_journey_steps" ADD CONSTRAINT "user_journey_steps_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "journey_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE;
