ALTER TABLE "ChatMemory" ADD COLUMN "embedding" JSONB;
ALTER TABLE "ChatMemory" ADD COLUMN "embeddingModel" TEXT;
ALTER TABLE "ChatMemory" ADD COLUMN "embeddingUpdatedAt" DATETIME;
