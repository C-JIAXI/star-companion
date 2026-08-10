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
import { attachChatSocket } from "./realtime/chatSocket.js";
import { getAppInfo } from "./services/appInfo.js";

const APP_NAME = "Star Companion";
const app = express();

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

app.use("/api/characters", charactersRouter);
app.use("/api/chats", chatsRouter);
app.use("/api/messages", messagesRouter);
app.use("/api/media", mediaRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/backups", backupsRouter);
app.use("/api/sync", syncRouter);

if (serverConfig.webDistDir) {
  app.use(express.static(serverConfig.webDistDir));
  app.get(/^(?!\/api\/).*/, (_request, response) => {
    response.sendFile(path.join(serverConfig.webDistDir as string, "index.html"));
  });
}

app.use(errorMiddleware);

const httpServer = createServer(app);
const wsServer = new WebSocketServer({ server: httpServer, path: "/ws" });
attachChatSocket(wsServer, APP_NAME);

const start = async () => {
  await connectDatabase();

  httpServer.listen(serverConfig.port, () => {
    console.log(`${APP_NAME} server listening on http://localhost:${serverConfig.port}`);
  });
};

const shutdown = async () => {
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
  console.error(error);
  await disconnectDatabase();
  process.exit(1);
});
