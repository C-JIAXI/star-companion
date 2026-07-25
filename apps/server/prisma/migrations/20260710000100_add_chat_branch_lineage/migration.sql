ALTER TABLE "Chat" ADD COLUMN "parentChatId" TEXT;
ALTER TABLE "Chat" ADD COLUMN "branchSourceMessageId" TEXT;

CREATE INDEX "Chat_parentChatId_idx" ON "Chat"("parentChatId");
