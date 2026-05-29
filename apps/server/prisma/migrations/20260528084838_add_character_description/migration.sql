/*
  Warnings:

  - You are about to drop the `LoreEntry` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Lorebook` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the column `lorebookIds` on the `Chat` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "LoreEntry_lorebookId_idx";

-- AlterTable
ALTER TABLE "UserSettings" ADD COLUMN "models" JSONB DEFAULT [];

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "LoreEntry";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "Lorebook";
PRAGMA foreign_keys=on;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Character" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "avatar" TEXT,
    "description" TEXT NOT NULL DEFAULT '',
    "prefix" TEXT NOT NULL DEFAULT '',
    "prompt" TEXT NOT NULL DEFAULT '',
    "suffix" TEXT NOT NULL DEFAULT '',
    "htmlCss" TEXT NOT NULL DEFAULT '',
    "loreEntries" JSONB NOT NULL DEFAULT [],
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Character" ("avatar", "createdAt", "htmlCss", "id", "name", "prefix", "prompt", "suffix", "updatedAt") SELECT "avatar", "createdAt", "htmlCss", "id", "name", "prefix", "prompt", "suffix", "updatedAt" FROM "Character";
DROP TABLE "Character";
ALTER TABLE "new_Character" RENAME TO "Character";
CREATE TABLE "new_Chat" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'single',
    "characterIds" JSONB NOT NULL DEFAULT [],
    "memoryTurns" INTEGER NOT NULL DEFAULT 12,
    "userPersona" TEXT NOT NULL DEFAULT '',
    "userProfileSummary" TEXT NOT NULL DEFAULT '',
    "userProfileUpdatedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Chat" ("characterIds", "createdAt", "id", "memoryTurns", "mode", "title", "updatedAt", "userPersona") SELECT "characterIds", "createdAt", "id", "memoryTurns", "mode", "title", "updatedAt", "userPersona" FROM "Chat";
DROP TABLE "Chat";
ALTER TABLE "new_Chat" RENAME TO "Chat";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
