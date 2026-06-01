ALTER TABLE "Chat" ADD COLUMN "autoMemoryEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Chat" ADD COLUMN "memoryUpdatedAt" DATETIME;
ALTER TABLE "Message" ADD COLUMN "memoryMatches" JSONB;

CREATE TABLE "ChatMemory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chatId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "keywords" JSONB NOT NULL DEFAULT [],
    "importance" INTEGER NOT NULL DEFAULT 3,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sourceMessageIds" JSONB NOT NULL DEFAULT [],
    "lastMatchedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ChatMemory_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ChatMemory_chatId_idx" ON "ChatMemory"("chatId");
CREATE INDEX "ChatMemory_chatId_enabled_idx" ON "ChatMemory"("chatId", "enabled");
CREATE INDEX "ChatMemory_chatId_updatedAt_idx" ON "ChatMemory"("chatId", "updatedAt");
