ALTER TABLE "Chat" ADD COLUMN "isArchived" BOOLEAN NOT NULL DEFAULT false;

DROP INDEX "Chat_isPinned_updatedAt_idx";

CREATE INDEX "Chat_isArchived_isPinned_updatedAt_idx" ON "Chat"("isArchived", "isPinned", "updatedAt");
