ALTER TABLE "Chat" ADD COLUMN "profileRevision" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "ChatMemory" ADD COLUMN "deletedAt" DATETIME;
ALTER TABLE "ChatMemory" ADD COLUMN "currentRevision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ChatMemory" ADD COLUMN "lastActor" TEXT;
ALTER TABLE "ChatMemory" ADD COLUMN "lastAction" TEXT;

CREATE TABLE "MemoryRevision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "memoryId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "beforeSnapshot" JSONB,
    "afterSnapshot" JSONB,
    "sourceMessageIds" JSONB NOT NULL DEFAULT '[]',
    "operationId" TEXT,
    "reasonCode" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MemoryRevision_memoryId_fkey" FOREIGN KEY ("memoryId") REFERENCES "ChatMemory" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "MemoryOperation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chatId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "createdCount" INTEGER NOT NULL DEFAULT 0,
    "updatedCount" INTEGER NOT NULL DEFAULT 0,
    "disabledCount" INTEGER NOT NULL DEFAULT 0,
    "unchangedCount" INTEGER NOT NULL DEFAULT 0,
    "sourceMessageIds" JSONB NOT NULL DEFAULT '[]',
    "errorCode" TEXT,
    "undoneAt" DATETIME,
    "undoOperationId" TEXT,
    CONSTRAINT "MemoryOperation_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ProfileSummaryRevision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chatId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "sourceMessageIds" JSONB NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProfileSummaryRevision_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "MemoryRevision_memoryId_revision_key" ON "MemoryRevision"("memoryId", "revision");
CREATE INDEX "MemoryRevision_chatId_createdAt_idx" ON "MemoryRevision"("chatId", "createdAt");
CREATE INDEX "MemoryRevision_memoryId_createdAt_idx" ON "MemoryRevision"("memoryId", "createdAt");
CREATE INDEX "MemoryRevision_operationId_createdAt_idx" ON "MemoryRevision"("operationId", "createdAt");
CREATE INDEX "MemoryOperation_chatId_startedAt_idx" ON "MemoryOperation"("chatId", "startedAt");
CREATE INDEX "MemoryOperation_status_startedAt_idx" ON "MemoryOperation"("status", "startedAt");
CREATE INDEX "MemoryOperation_undoOperationId_idx" ON "MemoryOperation"("undoOperationId");
CREATE UNIQUE INDEX "ProfileSummaryRevision_chatId_revision_key" ON "ProfileSummaryRevision"("chatId", "revision");
CREATE INDEX "ProfileSummaryRevision_chatId_createdAt_idx" ON "ProfileSummaryRevision"("chatId", "createdAt");

DROP INDEX "ChatMemory_chatId_enabled_idx";
CREATE INDEX "ChatMemory_chatId_deletedAt_enabled_idx" ON "ChatMemory"("chatId", "deletedAt", "enabled");

UPDATE "ChatMemory"
SET "currentRevision" = 1,
    "lastActor" = 'restore',
    "lastAction" = 'baseline';

INSERT INTO "MemoryRevision" (
    "id", "memoryId", "chatId", "revision", "action", "actor",
    "beforeSnapshot", "afterSnapshot", "sourceMessageIds", "operationId", "reasonCode", "createdAt"
)
SELECT
    'baseline:' || "id",
    "id",
    "chatId",
    1,
    'baseline',
    'restore',
    NULL,
    json_object(
      'title', "title",
      'content', "content",
      'keywords', json("keywords"),
      'importance', "importance",
      'enabled', json(CASE WHEN "enabled" THEN 'true' ELSE 'false' END),
      'sourceMessageIds', json("sourceMessageIds")
    ),
    "sourceMessageIds",
    NULL,
    'existing_data_baseline',
    "createdAt"
FROM "ChatMemory";

UPDATE "Chat"
SET "profileRevision" = 1
WHERE length(trim("userProfileSummary")) > 0;

INSERT INTO "ProfileSummaryRevision" (
    "id", "chatId", "revision", "action", "actor", "summary", "sourceMessageIds", "createdAt"
)
SELECT
    'baseline:' || "id",
    "id",
    1,
    'baseline',
    'restore',
    "userProfileSummary",
    '[]',
    COALESCE("userProfileUpdatedAt", "createdAt")
FROM "Chat"
WHERE length(trim("userProfileSummary")) > 0;
