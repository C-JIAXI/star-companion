-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_UserSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "activeProvider" TEXT NOT NULL DEFAULT 'openai-compatible',
    "apiBaseUrl" TEXT NOT NULL DEFAULT 'https://api.openai.com/v1',
    "apiKey" TEXT,
    "model" TEXT NOT NULL DEFAULT 'gpt-4o-mini',
    "temperature" REAL NOT NULL DEFAULT 0.8,
    "maxTokens" INTEGER NOT NULL DEFAULT 800,
    "topP" REAL NOT NULL DEFAULT 1,
    "language" TEXT NOT NULL DEFAULT 'zh-CN',
    "models" JSONB DEFAULT [],
    "userProfileSummary" TEXT NOT NULL DEFAULT '',
    "autoSummarizeUser" BOOLEAN NOT NULL DEFAULT true,
    "showMessageAvatars" BOOLEAN NOT NULL DEFAULT true,
    "userProfileUpdatedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_UserSettings" (
    "activeProvider",
    "apiBaseUrl",
    "apiKey",
    "autoSummarizeUser",
    "createdAt",
    "id",
    "language",
    "maxTokens",
    "model",
    "models",
    "showMessageAvatars",
    "temperature",
    "topP",
    "updatedAt",
    "userProfileSummary",
    "userProfileUpdatedAt"
)
SELECT
    "activeProvider",
    "apiBaseUrl",
    "apiKey",
    "autoSummarizeUser",
    "createdAt",
    "id",
    "language",
    "maxTokens",
    "model",
    COALESCE("models", '[]'),
    "showMessageAvatars",
    "temperature",
    "topP",
    "updatedAt",
    "userProfileSummary",
    "userProfileUpdatedAt"
FROM "UserSettings";
DROP TABLE "UserSettings";
ALTER TABLE "new_UserSettings" RENAME TO "UserSettings";

CREATE TABLE "new_Chat" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "characterId" TEXT,
    "memoryTurns" INTEGER NOT NULL DEFAULT 12,
    "userPersona" TEXT NOT NULL DEFAULT '',
    "userProfileSummary" TEXT NOT NULL DEFAULT '',
    "userProfileUpdatedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Chat_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Chat" (
    "characterId",
    "createdAt",
    "id",
    "memoryTurns",
    "title",
    "updatedAt",
    "userPersona",
    "userProfileSummary",
    "userProfileUpdatedAt"
)
SELECT
    CASE
        WHEN json_valid("characterIds")
          AND json_type("characterIds") = 'array'
          AND json_extract("characterIds", '$[0]') IN (SELECT id FROM "Character")
        THEN json_extract("characterIds", '$[0]')
        ELSE NULL
    END,
    "createdAt",
    "id",
    "memoryTurns",
    "title",
    "updatedAt",
    "userPersona",
    "userProfileSummary",
    "userProfileUpdatedAt"
FROM "Chat";
DROP TABLE "Chat";
ALTER TABLE "new_Chat" RENAME TO "Chat";
CREATE INDEX "Chat_characterId_idx" ON "Chat"("characterId");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
