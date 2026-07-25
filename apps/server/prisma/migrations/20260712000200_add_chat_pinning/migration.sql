ALTER TABLE "Chat" ADD COLUMN "isPinned" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "Chat_isPinned_updatedAt_idx" ON "Chat"("isPinned", "updatedAt");
