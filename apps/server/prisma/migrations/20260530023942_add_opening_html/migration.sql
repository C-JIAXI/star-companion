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
    "openingHtml" TEXT NOT NULL DEFAULT '',
    "loreEntries" JSONB NOT NULL DEFAULT [],
    "quickReplies" JSONB NOT NULL DEFAULT [],
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Character" ("avatar", "createdAt", "description", "htmlCss", "id", "loreEntries", "name", "prefix", "prompt", "quickReplies", "suffix", "updatedAt") SELECT "avatar", "createdAt", "description", "htmlCss", "id", "loreEntries", "name", "prefix", "prompt", "quickReplies", "suffix", "updatedAt" FROM "Character";
DROP TABLE "Character";
ALTER TABLE "new_Character" RENAME TO "Character";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
