ALTER TABLE "Character" ADD COLUMN "tags" JSONB DEFAULT '[]';
ALTER TABLE "Character" ADD COLUMN "cardId" TEXT NOT NULL;
CREATE UNIQUE INDEX "Character_cardId_key" ON "Character"("cardId");
