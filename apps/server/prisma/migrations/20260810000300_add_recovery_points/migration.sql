CREATE TABLE "RecoveryPoint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reason" TEXT NOT NULL,
    "summary" JSONB NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "RecoveryPoint_createdAt_idx" ON "RecoveryPoint"("createdAt");
