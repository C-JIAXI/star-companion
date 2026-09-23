CREATE TABLE "McpConnection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "endpointUrl" TEXT NOT NULL,
    "allowPrivateNetwork" BOOLEAN NOT NULL DEFAULT false,
    "bearerEncrypted" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "toolDefinitions" JSONB NOT NULL DEFAULT '[]',
    "enabledToolNames" JSONB NOT NULL DEFAULT '[]',
    "version" INTEGER NOT NULL DEFAULT 1,
    "lastCheckedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "McpConnection_name_key" ON "McpConnection"("name");
