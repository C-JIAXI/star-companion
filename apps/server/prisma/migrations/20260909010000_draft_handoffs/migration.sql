CREATE TABLE "DraftHandoff" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "chatId" TEXT NOT NULL,
  "originVersion" INTEGER NOT NULL,
  "purpose" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "attachments" JSONB NOT NULL DEFAULT '[]',
  "messageId" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "committedAt" DATETIME,
  "disposedAt" DATETIME,
  "disposition" TEXT,
  "restoreMutationId" TEXT,
  CONSTRAINT "DraftHandoff_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "DraftHandoff_chatId_createdAt_idx" ON "DraftHandoff"("chatId", "createdAt");
ALTER TABLE "MessageAttachment" ADD COLUMN "handoffId" TEXT REFERENCES "DraftHandoff"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "MessageAttachment_handoffId_idx" ON "MessageAttachment"("handoffId");
