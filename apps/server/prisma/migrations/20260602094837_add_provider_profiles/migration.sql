-- AlterTable
ALTER TABLE "UserSettings" ADD COLUMN "activeModelId" TEXT DEFAULT '';
ALTER TABLE "UserSettings" ADD COLUMN "activeProviderId" TEXT DEFAULT '';
ALTER TABLE "UserSettings" ADD COLUMN "providers" JSONB DEFAULT [];

-- CreateIndex
CREATE INDEX "Message_chatId_createdAt_idx" ON "Message"("chatId", "createdAt");
