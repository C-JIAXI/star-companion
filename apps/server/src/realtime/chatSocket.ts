import type { Chat, Prisma } from "@prisma/client";
import type { RawData, WebSocket, WebSocketServer } from "ws";
import { prisma } from "../db.js";
import {
  generationRequestSchema,
  regenerateRequestSchema,
  stopGenerationRequestSchema
} from "../schemas.js";
import { serializeMessage } from "../serializers.js";
import { getOrCreateSettings } from "../routes/settings.js";
import { estimateTokenUsage, streamChatCompletion, type TokenUsage } from "../services/openaiCompatible.js";
import { appendVariant, buildPromptContext, type MatchedLoreEntry } from "../services/promptBuilder.js";
import { updateUserProfileFromChat } from "../services/userProfileMemory.js";

const controllers = new Map<string, AbortController>();

const sendJson = (socket: WebSocket, value: unknown) => {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(value));
  }
};

const toStringArray = (value: Prisma.JsonValue): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
};

const stripThinkingTags = (content: string): string => {
  let result = content;
  for (const [startTag, endTag] of [["thinking", "/thinking"] as const]) {
    while (true) {
      const startIdx = result.toLowerCase().indexOf(startTag);
      if (startIdx === -1) break;
      const endIdx = result.toLowerCase().indexOf(endTag, startIdx + startTag.length);
      if (endIdx === -1) {
        result = result.slice(0, startIdx);
        break;
      }
      result = result.slice(0, startIdx) + result.slice(endIdx + endTag.length);
    }
  }
  return result.trim();
};

const getReplyCharacterIds = async (chat: Chat, targetCharacterId?: string | null) => {
  if (targetCharacterId) {
    return [targetCharacterId];
  }

  const characterIds = toStringArray(chat.characterIds);
  if (chat.mode !== "group" || characterIds.length === 0) {
    return [characterIds[0] ?? null];
  }

  const recentMessages = await prisma.message.findMany({
    where: { chatId: chat.id },
    orderBy: { createdAt: "desc" },
    take: 20
  });

  const mentionCount = new Map<string, number>();
  for (const cid of characterIds) {
    mentionCount.set(cid, 0);
  }

  const characterNames = new Map<string, string>();
  if (characterIds.length > 0) {
    const chars = await prisma.character.findMany({
      where: { id: { in: characterIds } }
    });
    for (const c of chars) {
      characterNames.set(c.id, c.name.toLowerCase());
    }
  }

  const contextText = recentMessages.map((m) => m.content.toLowerCase()).join("\n");

  for (const [cid, name] of characterNames) {
    let count = 0;
    let pos = 0;
    while ((pos = contextText.indexOf(name, pos)) !== -1) {
      count++;
      pos += name.length;
    }
    mentionCount.set(cid, count);
  }

  const lastSpeakerId = recentMessages.find((m) => m.characterId)?.characterId;

  const sorted = [...characterIds].sort((a, b) => {
    if (lastSpeakerId === b) return 1;
    if (lastSpeakerId === a) return -1;
    return (mentionCount.get(b) ?? 0) - (mentionCount.get(a) ?? 0);
  });

  return sorted;
};

const streamAssistantReply = async ({
  socket,
  requestId,
  chatId,
  characterId,
  abortController,
  index,
  total,
  before,
  targetMessageId,
  excludeMessageIds
}: {
  socket: WebSocket;
  requestId: string;
  chatId: string;
  characterId: string | null;
  abortController: AbortController;
  index: number;
  total: number;
  before?: Date;
  targetMessageId?: string;
  excludeMessageIds?: string[];
}) => {
  sendJson(socket, {
    type: "generation_character_started",
    requestId,
    characterId,
    index,
    total
  });

  const settings = await getOrCreateSettings();
  const context = await buildPromptContext({
    chatId,
    characterId,
    before,
    excludeMessageIds
  });
  sendJson(socket, {
    type: "lore_matches",
    requestId,
    entries: context.matchedLoreEntries
  });

  let assistantContent = "";
  let stopped = false;
  let tokenUsage: TokenUsage | null = null;

  try {
    for await (const event of streamChatCompletion({
      settings,
      messages: context.messages,
      signal: abortController.signal
    })) {
      if (event.type === "usage") {
        tokenUsage = event.usage;
        continue;
      }

      assistantContent += event.content;
      sendJson(socket, { type: "token", requestId, content: event.content });
    }
  } catch (error) {
    if (abortController.signal.aborted) {
      stopped = true;
    } else {
      throw error;
    }
  }

  if (assistantContent.trim()) {
    assistantContent = stripThinkingTags(assistantContent);
    tokenUsage ??= estimateTokenUsage(context.messages, assistantContent);
    const message = targetMessageId
      ? await updateAssistantVariant(targetMessageId, assistantContent, tokenUsage, context.matchedLoreEntries)
      : await createAssistantMessage(
          chatId,
          characterId,
          assistantContent,
          tokenUsage,
          context.matchedLoreEntries
        );

    await prisma.chat.update({
      where: { id: chatId },
      data: { updatedAt: new Date() }
    });

    sendJson(socket, {
      type: "assistant_message",
      requestId,
      message: serializeMessage(message)
    });
  }

  return stopped;
};

const createAssistantMessage = (
  chatId: string,
  characterId: string | null,
  content: string,
  tokenUsage: TokenUsage,
  loreMatches: MatchedLoreEntry[]
) =>
  prisma.message.create({
    data: {
      chatId,
      role: "assistant",
      characterId,
      content,
      variants: [content],
      activeVariantIndex: 0,
      tokenUsage,
      loreMatches
    }
  });

const updateAssistantVariant = async (
  messageId: string,
  content: string,
  tokenUsage: TokenUsage,
  loreMatches: MatchedLoreEntry[]
) => {
  const targetMessage = await prisma.message.findUnique({ where: { id: messageId } });
  if (!targetMessage) {
    throw new Error("Assistant message not found");
  }

  const variants = appendVariant(targetMessage.variants, content);
  return prisma.message.update({
    where: { id: messageId },
    data: {
      content,
      variants,
      activeVariantIndex: variants.length - 1,
      tokenUsage,
      loreMatches
    }
  });
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

    const chat = await prisma.chat.findUnique({ where: { id: request.chatId } });
    if (!chat) {
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

    const replyCharacterIds = await getReplyCharacterIds(chat, request.targetCharacterId);
    let stopped = false;

    for (const [index, characterId] of replyCharacterIds.entries()) {
      stopped = await streamAssistantReply({
        socket,
        requestId: request.requestId,
        chatId: request.chatId,
        characterId,
        abortController,
        index,
        total: replyCharacterIds.length
      });

      if (stopped) {
        break;
      }
    }

    if (!stopped) {
      try {
        const settings = await getOrCreateSettings();
        const updatedSettings = await updateUserProfileFromChat({
          chatId: request.chatId,
          settings
        });
        if (updatedSettings.userProfileSummary !== settings.userProfileSummary) {
          sendJson(socket, {
            type: "user_profile_updated",
            requestId: request.requestId,
            summary: updatedSettings.userProfileSummary,
            updatedAt: updatedSettings.userProfileUpdatedAt?.toISOString() ?? null
          });
        }
      } catch {
        // User profile memory is a best-effort enhancement and must not break chat generation.
      }
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

    const stopped = await streamAssistantReply({
      socket,
      requestId: request.requestId,
      chatId: targetMessage.chatId,
      characterId: targetMessage.characterId,
      abortController,
      index: 0,
      total: 1,
      excludeMessageIds: [targetMessage.id],
      targetMessageId: targetMessage.id
    });

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
