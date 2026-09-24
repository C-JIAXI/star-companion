CREATE TABLE "WebSearchConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "apiKeyEncrypted" TEXT,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
