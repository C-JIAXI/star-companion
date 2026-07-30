import type { RawData, WebSocket, WebSocketServer } from "ws";
import { prisma } from "../db.js";
import {
  continueRequestSchema,
  generationRequestSchema,
  regenerateRequestSchema,
  resendRequestSchema,
  stopGenerationRequestSchema
} from "../schemas.js";
import { serializeMessage } from "../serializers.js";
import { getOrCreateSettings } from "../routes/settings.js";
import { estimateTokenUsage, streamChatCompletion, type TokenUsage } from "../services/completions.js";
import { updateChatMemoriesFromTurn, type MatchedMemoryEntry } from "../services/chatMemories.js";
import {
  getUserMessageResendTarget,
  prepareUserMessageResend
} from "../services/messageTimeline.js";
import { resolveModuleSettings } from "../services/moduleModels.js";
import { appendVariant, buildPromptContext, type MatchedLoreEntry } from "../services/promptBuilder.js";
import { updateUserProfileFromChat } from "../services/userProfileMemory.js";

export const GENERATION_ERROR_PREFIX = "[GENERATION_FAILED] ";

const createErrorMessage = async (chatId: string, errorText: string) => {
  const message = await prisma.message.create({
    data: {
      chatId,
      role: "system",
      content: `${GENERATION_ERROR_PREFIX}${errorText}`,
      variants: [],
      activeVariantIndex: 0
    }
  });
  return serializeMessage(message);
};

const controllers = new Map<string, AbortController>();

const sendJson = (socket: WebSocket, value: unknown) => {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(value));
  }
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
  excludeMessageIds,
  continuationTargetMessageId,
  onFirstToken,
  persistEmptyResponseError = true
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
  continuationTargetMessageId?: string;
  onFirstToken?: () => Promise<void>;
  persistEmptyResponseError?: boolean;
}) => {
  sendJson(socket, {
    type: "generation_character_started",
    requestId,
    characterId,
    index,
    total
  });

  const settings = resolveModuleSettings(await getOrCreateSettings(), "chat");
  const context = await buildPromptContext({
    chatId,
    characterId,
    before,
    excludeMessageIds,
    settings
  });
  sendJson(socket, {
    type: "lore_matches",
    requestId,
    entries: context.matchedLoreEntries
  });
  sendJson(socket, {
    type: "memory_matches",
    requestId,
    entries: context.matchedMemoryEntries
  });

  const completionMessages = continuationTargetMessageId
    ? [
        ...context.messages,
        {
          role: "user" as const,
          content:
            "Continue the immediately preceding assistant reply from its exact ending. Return only the continuation, without repeating or summarizing any existing text."
        }
      ]
    : context.messages;

  let assistantContent = "";
  let stopped = false;
  let tokenUsage: TokenUsage | null = null;

  try {
    for await (const event of streamChatCompletion({
      settings,
      messages: completionMessages,
      signal: abortController.signal
    })) {
      if (event.type === "usage") {
        tokenUsage = event.usage;
        continue;
      }

      if (event.content && !assistantContent) {
        await onFirstToken?.();
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

  if (stopped) {
    if (assistantContent.trim()) {
      assistantContent = stripThinkingTags(assistantContent);
      tokenUsage ??= estimateTokenUsage(completionMessages, assistantContent);
      const message = continuationTargetMessageId
        ? await appendAssistantContinuation(
            continuationTargetMessageId,
            assistantContent,
            tokenUsage,
            context.matchedLoreEntries,
            context.matchedMemoryEntries
          )
        : targetMessageId
        ? await updateAssistantVariant(
            targetMessageId,
            assistantContent,
            tokenUsage,
            context.matchedLoreEntries,
            context.matchedMemoryEntries
          )
        : await createAssistantMessage(
            chatId,
            characterId,
            assistantContent,
            tokenUsage,
            context.matchedLoreEntries,
            context.matchedMemoryEntries
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
  }

  assistantContent = stripThinkingTags(assistantContent);

  if (!assistantContent.trim()) {
    const errorText = "Model returned an empty response. If max tokens is very low, try increasing it.";
    if (persistEmptyResponseError) {
      const errorMessage = await createErrorMessage(chatId, errorText);
      sendJson(socket, { type: "user_message", requestId, message: errorMessage });
    }
    throw new Error(errorText);
  }

  tokenUsage ??= estimateTokenUsage(completionMessages, assistantContent);
  const message = continuationTargetMessageId
    ? await appendAssistantContinuation(
        continuationTargetMessageId,
        assistantContent,
        tokenUsage,
        context.matchedLoreEntries,
        context.matchedMemoryEntries
      )
    : targetMessageId
    ? await updateAssistantVariant(
        targetMessageId,
        assistantContent,
        tokenUsage,
        context.matchedLoreEntries,
        context.matchedMemoryEntries
      )
    : await createAssistantMessage(
        chatId,
        characterId,
        assistantContent,
        tokenUsage,
        context.matchedLoreEntries,
        context.matchedMemoryEntries
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

  return stopped;
};

const createAssistantMessage = (
  chatId: string,
  characterId: string | null,
  content: string,
  tokenUsage: TokenUsage,
  loreMatches: MatchedLoreEntry[],
  memoryMatches: MatchedMemoryEntry[]
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
      loreMatches,
      memoryMatches
    }
  });

const joinAssistantContinuation = (existing: string, continuation: string) => {
  if (!existing || !continuation || /\s$/.test(existing) || /^\s/.test(continuation)) {
    return `${existing}${continuation}`;
  }

  const needsWordBoundary = /[A-Za-z0-9.!?;:)]$/.test(existing) && /^[A-Za-z0-9]/.test(continuation);
  return `${existing}${needsWordBoundary ? " " : ""}${continuation}`;
};

const updateAssistantVariant = async (
  messageId: string,
  content: string,
  tokenUsage: TokenUsage,
  loreMatches: MatchedLoreEntry[],
  memoryMatches: MatchedMemoryEntry[]
) => {
  const targetMessage = await prisma.message.findFirst({
    where: { id: messageId, chat: { deletedAt: null } }
  });
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
      loreMatches,
      memoryMatches
    }
  });
};

const appendAssistantContinuation = async (
  messageId: string,
  continuation: string,
  tokenUsage: TokenUsage,
  loreMatches: MatchedLoreEntry[],
  memoryMatches: MatchedMemoryEntry[]
) => {
  const targetMessage = await prisma.message.findFirst({
    where: { id: messageId, chat: { deletedAt: null } }
  });
  if (!targetMessage) {
    throw new Error("Assistant message not found");
  }

  const content = joinAssistantContinuation(targetMessage.content, continuation);
  const variants = Array.isArray(targetMessage.variants)
    ? targetMessage.variants.filter((value): value is string => typeof value === "string")
    : [];
  const activeVariantIndex = Math.min(
    Math.max(targetMessage.activeVariantIndex, 0),
    Math.max(variants.length - 1, 0)
  );

  if (variants.length === 0) {
    variants.push(content);
  } else {
    variants[activeVariantIndex] = content;
  }

  return prisma.message.update({
    where: { id: messageId },
    data: {
      content,
      variants,
      activeVariantIndex,
      tokenUsage,
      loreMatches,
      memoryMatches
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

    const chat = await prisma.chat.findFirst({ where: { id: request.chatId, deletedAt: null } });
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

    const characterId = chat.characterId;

    const stopped = await streamAssistantReply({
      socket,
      requestId: request.requestId,
      chatId: request.chatId,
      characterId,
      abortController,
      index: 0,
      total: 1
    });

    if (!stopped) {
      try {
        const settings = resolveModuleSettings(await getOrCreateSettings(), "chat");
        const updatedChat = await updateUserProfileFromChat({
          chatId: request.chatId,
          settings
        });
        const memorySummary = await updateChatMemoriesFromTurn({
          chatId: request.chatId,
          settings
        });
        if (updatedChat) {
          sendJson(socket, {
            type: "user_profile_updated",
            requestId: request.requestId,
            summary: updatedChat.userProfileSummary,
            updatedAt: updatedChat.userProfileUpdatedAt?.toISOString() ?? null
          });
        }
        if (
          memorySummary &&
          memorySummary.created + memorySummary.updated + memorySummary.disabled > 0
        ) {
          sendJson(socket, {
            type: "chat_memory_updated",
            requestId: request.requestId,
            summary: memorySummary
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

    const targetMessage = await prisma.message.findFirst({
      where: { id: request.messageId, chat: { deletedAt: null } }
    });
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

const handleContinue = async (socket: WebSocket, rawMessage: unknown) => {
  const parsed = continueRequestSchema.safeParse(rawMessage);
  if (!parsed.success) {
    sendJson(socket, { type: "error", error: "Invalid continue request" });
    return;
  }

  const request = parsed.data;
  const abortController = new AbortController();
  controllers.set(request.requestId, abortController);

  try {
    sendJson(socket, { type: "generation_started", requestId: request.requestId });

    const targetMessage = await prisma.message.findFirst({
      where: { id: request.messageId, chat: { deletedAt: null } }
    });
    if (!targetMessage || targetMessage.role !== "assistant") {
      throw new Error("Assistant message not found");
    }

    const latestMessage = await prisma.message.findFirst({
      where: { chatId: targetMessage.chatId },
      orderBy: { createdAt: "desc" }
    });
    if (latestMessage?.id !== targetMessage.id) {
      throw new Error("Only the latest assistant message can be continued");
    }

    const stopped = await streamAssistantReply({
      socket,
      requestId: request.requestId,
      chatId: targetMessage.chatId,
      characterId: targetMessage.characterId,
      abortController,
      index: 0,
      total: 1,
      continuationTargetMessageId: targetMessage.id
    });

    sendJson(socket, {
      type: stopped ? "generation_stopped" : "generation_done",
      requestId: request.requestId
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Continue failed";
    sendJson(socket, { type: "error", requestId: request.requestId, error: message });
  } finally {
    controllers.delete(request.requestId);
  }
};

const handleResend = async (socket: WebSocket, rawMessage: unknown) => {
  const parsed = resendRequestSchema.safeParse(rawMessage);
  if (!parsed.success) {
    sendJson(socket, { type: "error", error: "Invalid resend request" });
    return;
  }

  const request = parsed.data;
  const abortController = new AbortController();
  controllers.set(request.requestId, abortController);

  try {
    // Validate the selected chat model before the resend transaction removes the old timeline.
    resolveModuleSettings(await getOrCreateSettings(), "chat");
    const { chat, excludedMessageIds } = await getUserMessageResendTarget(request.messageId);
    let timelinePrepared = false;

    const characterId = chat.characterId;

    const stopped = await streamAssistantReply({
      socket,
      requestId: request.requestId,
      chatId: chat.id,
      characterId,
      abortController,
      index: 0,
      total: 1,
      excludeMessageIds: excludedMessageIds,
      persistEmptyResponseError: false,
      onFirstToken: async () => {
        if (timelinePrepared) {
          return;
        }
        const { userMessage, disabledMemoryCount } = await prepareUserMessageResend(request.messageId);
        timelinePrepared = true;
        if (disabledMemoryCount > 0) {
          sendJson(socket, {
            type: "timeline_memory_invalidated",
            requestId: request.requestId,
            chatId: chat.id,
            disabledMemoryCount
          });
        }
        sendJson(socket, { type: "generation_started", requestId: request.requestId });
        sendJson(socket, {
          type: "user_message",
          requestId: request.requestId,
          message: serializeMessage(userMessage)
        });
      }
    });

    if (!stopped) {
      try {
        const settings = resolveModuleSettings(await getOrCreateSettings(), "chat");
        const updatedChat = await updateUserProfileFromChat({
          chatId: chat.id,
          settings
        });
        const memorySummary = await updateChatMemoriesFromTurn({
          chatId: chat.id,
          settings
        });
        if (updatedChat) {
          sendJson(socket, {
            type: "user_profile_updated",
            requestId: request.requestId,
            summary: updatedChat.userProfileSummary,
            updatedAt: updatedChat.userProfileUpdatedAt?.toISOString() ?? null
          });
        }
        if (
          memorySummary &&
          memorySummary.created + memorySummary.updated + memorySummary.disabled > 0
        ) {
          sendJson(socket, {
            type: "chat_memory_updated",
            requestId: request.requestId,
            summary: memorySummary
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
    const message = error instanceof Error ? error.message : "Resend failed";
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

        if (messageType === "continue") {
          void handleContinue(socket, parsed);
          return;
        }

        if (messageType === "resend") {
          void handleResend(socket, parsed);
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
