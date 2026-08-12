ALTER TABLE "UserSettings" ADD COLUMN "modelReliability" JSONB DEFAULT '{}';
ALTER TABLE "UserSettings" ADD COLUMN "usageBudgets" JSONB DEFAULT '{}';
ALTER TABLE "UserSettings" ADD COLUMN "usageTimezone" TEXT NOT NULL DEFAULT 'UTC';

ALTER TABLE "Message" ADD COLUMN "generationMetadata" JSONB;
ALTER TABLE "Message" ADD COLUMN "variantMetadata" JSONB NOT NULL DEFAULT '[]';

CREATE TABLE "ModelRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "module" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "chatId" TEXT,
    "messageId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "activeAttemptId" TEXT,
    "outputStarted" BOOLEAN NOT NULL DEFAULT false,
    "errorCode" TEXT,
    "errorSummary" TEXT,
    "diagnosticId" TEXT,
    "overrideHardBudget" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ModelRequest_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ModelRequest_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "ModelUsageAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requestId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "module" TEXT NOT NULL,
    "chatId" TEXT,
    "messageId" TEXT,
    "providerId" TEXT NOT NULL,
    "providerType" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "promptTokens" INTEGER,
    "outputTokens" INTEGER,
    "totalTokens" INTEGER,
    "usageSource" TEXT,
    "inputPriceMicros" INTEGER,
    "outputPriceMicros" INTEGER,
    "estimatedCostMicros" INTEGER,
    "currency" TEXT,
    "specialTokensUnknown" BOOLEAN NOT NULL DEFAULT false,
    "usedFallback" BOOLEAN NOT NULL DEFAULT false,
    "fallbackFromProviderId" TEXT,
    "fallbackFromModelId" TEXT,
    "errorCode" TEXT,
    "diagnosticId" TEXT,
    "reservedCostMicros" INTEGER NOT NULL DEFAULT 0,
    "reservationDay" TEXT,
    "reservationMonth" TEXT,
    CONSTRAINT "ModelUsageAttempt_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ModelRequest" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ModelUsageAttempt_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ModelUsageAttempt_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "ModelRequest_status_updatedAt_idx" ON "ModelRequest"("status", "updatedAt");
CREATE INDEX "ModelRequest_chatId_createdAt_idx" ON "ModelRequest"("chatId", "createdAt");
CREATE INDEX "ModelRequest_module_createdAt_idx" ON "ModelRequest"("module", "createdAt");
CREATE UNIQUE INDEX "ModelUsageAttempt_requestId_attemptNumber_key" ON "ModelUsageAttempt"("requestId", "attemptNumber");
CREATE INDEX "ModelUsageAttempt_startedAt_idx" ON "ModelUsageAttempt"("startedAt");
CREATE INDEX "ModelUsageAttempt_module_startedAt_idx" ON "ModelUsageAttempt"("module", "startedAt");
CREATE INDEX "ModelUsageAttempt_providerId_modelId_startedAt_idx" ON "ModelUsageAttempt"("providerId", "modelId", "startedAt");
CREATE INDEX "ModelUsageAttempt_chatId_startedAt_idx" ON "ModelUsageAttempt"("chatId", "startedAt");
CREATE INDEX "ModelUsageAttempt_reservationDay_status_idx" ON "ModelUsageAttempt"("reservationDay", "status");
CREATE INDEX "ModelUsageAttempt_reservationMonth_status_idx" ON "ModelUsageAttempt"("reservationMonth", "status");
