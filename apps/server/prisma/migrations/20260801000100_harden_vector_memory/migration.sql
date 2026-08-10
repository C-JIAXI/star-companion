ALTER TABLE "ChatMemory" ADD COLUMN "embeddingSource" TEXT;
ALTER TABLE "ChatMemory" ADD COLUMN "embeddingDimensions" INTEGER;
ALTER TABLE "ChatMemory" ADD COLUMN "embeddingStatus" TEXT NOT NULL DEFAULT 'stale';

UPDATE "ChatMemory"
SET "embeddingStatus" = CASE
  WHEN "embedding" IS NULL THEN 'stale'
  ELSE 'ready'
END;
