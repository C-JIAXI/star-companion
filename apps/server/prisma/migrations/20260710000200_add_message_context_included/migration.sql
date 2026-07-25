ALTER TABLE "Message" ADD COLUMN "contextIncluded" BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX "Message_chatId_contextIncluded_createdAt_idx" ON "Message"("chatId", "contextIncluded", "createdAt");
