-- CreateTable
CREATE TABLE "favorite_places" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "place_id" VARCHAR(255) NOT NULL,
    "place_name" VARCHAR(255) NOT NULL,
    "category" VARCHAR(100),
    "governorate" VARCHAR(100),
    "lat" DOUBLE PRECISION,
    "lon" DOUBLE PRECISION,
    "img" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "favorite_places_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "favorite_places_user_id_updated_at_idx" ON "favorite_places"("user_id", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "favorite_places_user_id_place_id_key" ON "favorite_places"("user_id", "place_id");

-- AddForeignKey
ALTER TABLE "favorite_places" ADD CONSTRAINT "favorite_places_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
