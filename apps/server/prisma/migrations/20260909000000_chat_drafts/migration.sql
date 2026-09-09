CREATE TABLE "ChatDraft" (
    "chatId" TEXT NOT NULL PRIMARY KEY,
    "draftId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "content" TEXT NOT NULL DEFAULT '',
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "lastMutationId" TEXT NOT NULL,
    "lastMutationHash" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ChatDraft_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ChatDraft_draftId_key" ON "ChatDraft"("draftId");
ALTER TABLE "MessageAttachment" ADD COLUMN "composerChatId" TEXT REFERENCES "ChatDraft"("chatId") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "MessageAttachment_composerChatId_idx" ON "MessageAttachment"("composerChatId");
