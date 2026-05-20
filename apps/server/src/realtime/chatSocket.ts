import type { RawData, WebSocket, WebSocketServer } from "ws";
import { prisma } from "../db.js";
import {
  generationRequestSchema,
  regenerateRequestSchema,
  stopGenerationRequestSchema
} from "../schemas.js";
import { serializeMessage } from "../serializers.js";
import { getOrCreateSettings } from "../routes/settings.js";
import { streamChatCompletion } from "../services/openaiCompatible.js";
import { appendVariant, buildPromptContext, resolveChatCharacterId } from "../services/promptBuilder.js";

const controllers = new Map<string, AbortController>();

const sendJson = (socket: WebSocket, value: unknown) => {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(value));
  }
};

const handleGenerate = async (socket: WebSocket, rawMessage: unknown) => {
  const parsed = generationRequestSchema.safeParse(rawMessage);
  if (!parsed.success) {
    sendJson(socket, { type: "error", error: "Invalid generation request" });
    return;
  }

  const request = parsed.data;
  const abortController = new AbortController();
  controllers.set(request.requestId, abortController);

  try {
    sendJson(socket, { type: "generation_started", requestId: request.requestId });

    const chatExists = await prisma.chat.findUnique({ where: { id: request.chatId } });
    if (!chatExists) {
      throw new Error("Chat not found");
    }

    const userMessage = await prisma.message.create({
      data: {
        chatId: request.chatId,
        role: "user",
        content: request.content,
        variants: [],
        activeVariantIndex: 0
      }
    });

    await prisma.chat.update({
      where: { id: request.chatId },
      data: { updatedAt: new Date() }
    });

    sendJson(socket, {
      type: "user_message",
      requestId: request.requestId,
      message: serializeMessage(userMessage)
    });

    const settings = await getOrCreateSettings();
    const context = await buildPromptContext({
      chatId: request.chatId,
      characterId: request.characterId
    });
    sendJson(socket, {
      type: "lore_matches",
      requestId: request.requestId,
      entries: context.matchedLoreEntries
    });
    let assistantContent = "";
    let stopped = false;

    try {
      for await (const token of streamChatCompletion({
        settings,
        messages: context.messages,
        signal: abortController.signal
      })) {
        assistantContent += token;
        sendJson(socket, { type: "token", requestId: request.requestId, content: token });
      }
    } catch (error) {
      if (abortController.signal.aborted) {
        stopped = true;
      } else {
        throw error;
      }
    }

    if (assistantContent.trim()) {
      const assistantMessage = await prisma.message.create({
        data: {
          chatId: request.chatId,
          role: "assistant",
          characterId: await resolveChatCharacterId(request.chatId, request.characterId),
          content: assistantContent,
          variants: [assistantContent],
          activeVariantIndex: 0
        }
      });

      await prisma.chat.update({
        where: { id: request.chatId },
        data: { updatedAt: new Date() }
      });

      sendJson(socket, {
        type: "assistant_message",
        requestId: request.requestId,
        message: serializeMessage(assistantMessage)
      });
    }

    sendJson(socket, {
      type: stopped ? "generation_stopped" : "generation_done",
      requestId: request.requestId
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Generation failed";
    sendJson(socket, { type: "error", requestId: request.requestId, error: message });
  } finally {
    controllers.delete(request.requestId);
  }
};

const handleRegenerate = async (socket: WebSocket, rawMessage: unknown) => {
  const parsed = regenerateRequestSchema.safeParse(rawMessage);
  if (!parsed.success) {
    sendJson(socket, { type: "error", error: "Invalid regenerate request" });
    return;
  }

  const request = parsed.data;
  const abortController = new AbortController();
  controllers.set(request.requestId, abortController);

  try {
    sendJson(socket, { type: "generation_started", requestId: request.requestId });

    const targetMessage = await prisma.message.findUnique({ where: { id: request.messageId } });
    if (!targetMessage || targetMessage.role !== "assistant") {
      throw new Error("Assistant message not found");
    }

    const settings = await getOrCreateSettings();
    const context = await buildPromptContext({
      chatId: targetMessage.chatId,
      characterId: targetMessage.characterId,
      before: targetMessage.createdAt
    });
    sendJson(socket, {
      type: "lore_matches",
      requestId: request.requestId,
      entries: context.matchedLoreEntries
    });
    let assistantContent = "";
    let stopped = false;

    try {
      for await (const token of streamChatCompletion({
        settings,
        messages: context.messages,
        signal: abortController.signal
      })) {
        assistantContent += token;
        sendJson(socket, { type: "token", requestId: request.requestId, content: token });
      }
    } catch (error) {
      if (abortController.signal.aborted) {
        stopped = true;
      } else {
        throw error;
      }
    }

    if (assistantContent.trim()) {
      const variants = appendVariant(targetMessage.variants, assistantContent);
      const updatedMessage = await prisma.message.update({
        where: { id: targetMessage.id },
        data: {
          content: assistantContent,
          variants,
          activeVariantIndex: variants.length - 1
        }
      });

      await prisma.chat.update({
        where: { id: targetMessage.chatId },
        data: { updatedAt: new Date() }
      });

      sendJson(socket, {
        type: "assistant_message",
        requestId: request.requestId,
        message: serializeMessage(updatedMessage)
      });
    }

    sendJson(socket, {
      type: stopped ? "generation_stopped" : "generation_done",
      requestId: request.requestId
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Regeneration failed";
    sendJson(socket, { type: "error", requestId: request.requestId, error: message });
  } finally {
    controllers.delete(request.requestId);
  }
};

const handleStop = (socket: WebSocket, rawMessage: unknown) => {
  const parsed = stopGenerationRequestSchema.safeParse(rawMessage);
  if (!parsed.success) {
    sendJson(socket, { type: "error", error: "Invalid stop request" });
    return;
  }

  controllers.get(parsed.data.requestId)?.abort();
};

const parseRawMessage = (message: RawData) => {
  const text = Array.isArray(message)
    ? Buffer.concat(message).toString("utf8")
    : Buffer.isBuffer(message)
      ? message.toString("utf8")
      : message.toString();

  return JSON.parse(text) as unknown;
};

export const attachChatSocket = (wsServer: WebSocketServer, appName: string) => {
  wsServer.on("connection", (socket) => {
    sendJson(socket, { type: "ready", app: appName });

    socket.on("message", (message) => {
      try {
        const parsed = parseRawMessage(message);
        const messageType = typeof parsed === "object" && parsed && "type" in parsed ? parsed.type : null;

        if (messageType === "generate") {
          void handleGenerate(socket, parsed);
          return;
        }

        if (messageType === "regenerate") {
          void handleRegenerate(socket, parsed);
          return;
        }

        if (messageType === "stop") {
          handleStop(socket, parsed);
          return;
        }

        sendJson(socket, { type: "error", error: "Unknown WebSocket message type" });
      } catch {
        sendJson(socket, { type: "error", error: "Malformed WebSocket message" });
      }
    });

    socket.on("close", () => {
      for (const controller of controllers.values()) {
        controller.abort();
      }
    });
  });
};
