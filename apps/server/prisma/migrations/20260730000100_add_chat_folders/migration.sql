ALTER TABLE "Chat" ADD COLUMN "folder" TEXT NOT NULL DEFAULT '';

DROP INDEX "Chat_deletedAt_isArchived_isPinned_updatedAt_idx";

CREATE INDEX "Chat_deletedAt_isArchived_folder_isPinned_updatedAt_idx"
ON "Chat"("deletedAt", "isArchived", "folder", "isPinned", "updatedAt");
