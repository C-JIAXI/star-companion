CREATE TABLE "RecoveryPointMediaAsset" (
  "recoveryPointId" TEXT NOT NULL,
  "assetId" TEXT NOT NULL,
  CONSTRAINT "RecoveryPointMediaAsset_recoveryPointId_fkey" FOREIGN KEY ("recoveryPointId") REFERENCES "RecoveryPoint" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "RecoveryPointMediaAsset_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "MediaAsset" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  PRIMARY KEY ("recoveryPointId", "assetId")
);

CREATE INDEX "RecoveryPointMediaAsset_assetId_idx" ON "RecoveryPointMediaAsset"("assetId");
