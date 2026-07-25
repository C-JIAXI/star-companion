ALTER TABLE "Message" ADD COLUMN "isBookmarked" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "Message_chatId_isBookmarked_createdAt_idx" ON "Message"("chatId", "isBookmarked", "createdAt");
