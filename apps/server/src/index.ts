import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { serverConfig } from "./config.js";
import { connectDatabase, disconnectDatabase, prisma } from "./db.js";
import { errorMiddleware } from "./lib/http.js";
import { charactersRouter } from "./routes/characters.js";
import { chatsRouter } from "./routes/chats.js";
import { lorebooksRouter } from "./routes/lorebooks.js";
import { messagesRouter } from "./routes/messages.js";
import { settingsRouter } from "./routes/settings.js";
import { attachChatSocket } from "./realtime/chatSocket.js";

const APP_NAME = "Local Roleplay Platform";
const app = express();

app.use(
  cors({
    origin: serverConfig.corsOrigin,
    credentials: true
  })
);
app.use(express.json({ limit: "1mb" }));

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

app.use("/api/characters", charactersRouter);
app.use("/api/chats", chatsRouter);
app.use("/api/messages", messagesRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/lorebooks", lorebooksRouter);

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
