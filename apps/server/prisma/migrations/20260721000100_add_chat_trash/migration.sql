ALTER TABLE "Chat" ADD COLUMN "deletedAt" DATETIME;

DROP INDEX "Chat_isArchived_isPinned_updatedAt_idx";

CREATE INDEX "Chat_deletedAt_isArchived_isPinned_updatedAt_idx" ON "Chat"("deletedAt", "isArchived", "isPinned", "updatedAt");
