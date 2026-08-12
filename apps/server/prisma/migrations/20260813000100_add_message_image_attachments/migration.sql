CREATE TABLE "MediaAsset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contentHash" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "data" BLOB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "MessageAttachment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "messageId" TEXT,
    "draftId" TEXT,
    "assetId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "originalFilename" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MessageAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MessageAttachment_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "MediaAsset" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "MediaAsset_contentHash_key" ON "MediaAsset"("contentHash");
CREATE UNIQUE INDEX "MediaAsset_storageKey_key" ON "MediaAsset"("storageKey");
CREATE INDEX "MediaAsset_createdAt_idx" ON "MediaAsset"("createdAt");
CREATE INDEX "MessageAttachment_messageId_sortOrder_idx" ON "MessageAttachment"("messageId", "sortOrder");
CREATE INDEX "MessageAttachment_draftId_sortOrder_idx" ON "MessageAttachment"("draftId", "sortOrder");
CREATE INDEX "MessageAttachment_assetId_idx" ON "MessageAttachment"("assetId");
CREATE UNIQUE INDEX "MessageAttachment_messageId_sortOrder_key" ON "MessageAttachment"("messageId", "sortOrder");
CREATE UNIQUE INDEX "MessageAttachment_draftId_sortOrder_key" ON "MessageAttachment"("draftId", "sortOrder");
