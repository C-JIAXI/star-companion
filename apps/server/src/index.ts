import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { WebSocketServer } from "ws";
import { serverConfig } from "./config.js";
import { connectDatabase, disconnectDatabase, prisma } from "./db.js";
import { errorMiddleware } from "./lib/http.js";
import { backupsRouter } from "./routes/backups.js";
import { charactersRouter } from "./routes/characters.js";
import { chatsRouter } from "./routes/chats.js";
import { messagesRouter } from "./routes/messages.js";
import { mediaRouter } from "./routes/media.js";
import { settingsRouter } from "./routes/settings.js";
import { syncRouter } from "./routes/sync.js";
import { usageRouter } from "./routes/usage.js";
import { readinessRouter } from "./routes/readiness.js";
import { storageHealthRouter } from "./routes/storageHealth.js";
import { attachChatSocket } from "./realtime/chatSocket.js";
import { getAppInfo } from "./services/appInfo.js";
import { recoverInterruptedModelCalls } from "./services/modelUsage.js";
import { cleanupExpiredDraftAttachments } from "./services/messageAttachments.js";
import { isPrivacyLocked, lockPrivacy, unlockPrivacy } from "./services/privacyLock.js";
import { cancelActiveStorageScan, registerStorageMutation } from "./services/storageHealth.js";

const APP_NAME = "Star Companion";
const app = express();
let closeWebSocketsForPrivacy = () => undefined;
let draftCleanupTimer: NodeJS.Timeout | null = null;

app.use(
  cors({
    origin: serverConfig.corsOrigin,
    credentials: true
  })
);
app.use(express.json({ limit: "25mb" }));

app.get("/api/health", async (_request, response, next) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    response.json({
      ok: true,
      app: APP_NAME,
      database: "connected",
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/app/info", async (_request, response) => {
  const info = getAppInfo();
  if (!process.env.STAR_COMPANION_MIGRATION_REPORT) {
    try {
      const applied = await prisma.$queryRawUnsafe<Array<{ migration_name: string; checksum: string }>>(
        'SELECT "migration_name", "checksum" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL ORDER BY "migration_name" DESC LIMIT 1'
      );
      const latest = applied[0];
      info.migration.status = latest?.migration_name === info.schemaVersion && latest.checksum === info.schemaChecksum
        ? "ready"
        : latest?.migration_name && latest.migration_name > info.schemaVersion ? "too_new" : "unknown";
    } catch {
      info.migration.status = "unknown";
    }
  }
  response.json({ ok: true, data: info });
});

app.get("/api/privacy/status", (_request, response) => response.json({ ok: true, data: { locked: isPrivacyLocked() } }));
app.post("/api/privacy/lock", (request, response) => {
  if (!lockPrivacy(typeof request.body?.passcode === "string" ? request.body.passcode : "")) {
    response.status(400).json({ ok: false, error: "Unlock code must contain 4 to 128 characters." });
    return;
  }
  closeWebSocketsForPrivacy();
  cancelActiveStorageScan();
  response.json({ ok: true, data: { locked: true } });
});
app.post("/api/privacy/unlock", (request, response) => {
  if (!unlockPrivacy(typeof request.body?.passcode === "string" ? request.body.passcode : "")) {
    response.status(401).json({ ok: false, error: "Incorrect unlock code." });
    return;
  }
  response.json({ ok: true, data: { locked: false } });
});

app.use("/api", (_request, response, next) => {
  if (isPrivacyLocked()) {
    response.status(423).json({ ok: false, error: "App is locked." });
    return;
  }
  next();
});
app.use("/api", (request, _response, next) => {
  const readOnlyPost = request.method === "POST" && (
    request.path === "/backups/preview" ||
    (request.path.startsWith("/sync/") && request.body?.phase === "preview")
  );
  if (request.method !== "GET" && !request.path.startsWith("/storage-health/") && !readOnlyPost) registerStorageMutation();
  next();
});

app.use("/api/characters", charactersRouter);
app.use("/api/chats", chatsRouter);
app.use("/api/messages", messagesRouter);
app.use("/api/media", mediaRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/backups", backupsRouter);
app.use("/api/sync", syncRouter);
app.use("/api/usage", usageRouter);
app.use("/api/readiness", readinessRouter);
app.use("/api/storage-health", storageHealthRouter);

if (serverConfig.webDistDir) {
  app.use(express.static(serverConfig.webDistDir));
  app.get(/^(?!\/api\/).*/, (_request, response) => {
    response.sendFile(path.join(serverConfig.webDistDir as string, "index.html"));
  });
}

app.use(errorMiddleware);

const httpServer = createServer(app);
const wsServer = new WebSocketServer({ server: httpServer, path: "/ws" });
closeWebSocketsForPrivacy = () => {
  for (const client of wsServer.clients) client.close(4403, "App locked");
};
attachChatSocket(wsServer, APP_NAME);

const start = async () => {
  await connectDatabase();
  await recoverInterruptedModelCalls();
  await cleanupExpiredDraftAttachments();
  draftCleanupTimer = setInterval(() => {
    void cleanupExpiredDraftAttachments().catch(() => undefined);
  }, 6 * 60 * 60 * 1000);
  draftCleanupTimer.unref();

  httpServer.listen(serverConfig.port, () => {
    console.log(`${APP_NAME} server listening on http://localhost:${serverConfig.port}`);
  });
};

const shutdown = async () => {
  if (draftCleanupTimer) clearInterval(draftCleanupTimer);
  wsServer.close();
  httpServer.close();
  await disconnectDatabase();
  process.exit(0);
};

process.on("SIGINT", () => {
  void shutdown();
});

process.on("SIGTERM", () => {
  void shutdown();
});

void start().catch(async (error: unknown) => {
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "SERVER_START_FAILED";
  console.error(`${APP_NAME} failed to start`, code);
  await disconnectDatabase();
  process.exit(1);
});
