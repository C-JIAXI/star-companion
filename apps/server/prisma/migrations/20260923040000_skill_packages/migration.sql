CREATE TABLE "SkillPackage" (
    "name" TEXT NOT NULL PRIMARY KEY,
    "description" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "digest" TEXT NOT NULL,
    "skillMd" TEXT NOT NULL,
    "references" JSONB NOT NULL DEFAULT '{}',
    "compatibility" TEXT,
    "unsupportedFiles" JSONB NOT NULL DEFAULT '[]',
    "agentEnabled" BOOLEAN NOT NULL DEFAULT false,
    "enabledChatIds" JSONB NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
