ALTER TABLE "UserSettings" ADD COLUMN "userProfileSummary" TEXT NOT NULL DEFAULT '';

ALTER TABLE "UserSettings" ADD COLUMN "autoSummarizeUser" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "UserSettings" ADD COLUMN "userProfileUpdatedAt" DATETIME;
