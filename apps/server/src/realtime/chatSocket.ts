import type { Prisma } from "@prisma/client";
import type { RawData, WebSocket, WebSocketServer } from "ws";
import { prisma } from "../db.js";
import {
  continueRequestSchema,
  generationRequestSchema,
  generationStatusRequestSchema,
  regenerateRequestSchema,
  resendRequestSchema,
  stopGenerationRequestSchema
} from "../schemas.js";
import { serializeMessage } from "../serializers.js";
import { getOrCreateSettings } from "../routes/settings.js";
import { estimateTokenUsage, type TokenUsage } from "../services/completions.js";
import { updateChatMemoriesFromTurn, type MatchedMemoryEntry } from "../services/chatMemories.js";
import { GenerationControllerRegistry } from "../services/generationControllers.js";
import { normalizeModelError } from "../services/modelErrors.js";
import { beginModelRequest, completeModelRequest, failModelRequest, getModelRequest, linkModelRequestMessage } from "../services/modelUsage.js";
import { executeReliableTextStream, generationMetadata, incompleteGenerationMetadata, type ReliableStreamEvent, type ReliableTextResult } from "../services/reliableModelCalls.js";
import { buildRegenerationGuidanceMessage } from "../services/regeneration.js";
import {
  getUserMessageResendTarget,
  prepareUserMessageResend
} from "../services/messageTimeline.js";
import { resolveModuleSettings } from "../services/moduleModels.js";
import {
  appendPromptBreakdownInstruction,
  appendVariant,
  buildPromptContext,
  finalizePromptBreakdown,
  type MatchedLoreEntry,
  type PromptBreakdown
} from "../services/promptBuilder.js";
import { updateUserProfileFromChat } from "../services/userProfileMemory.js";
import { isPrivacyLocked } from "../services/privacyLock.js";

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

const controllers = new GenerationControllerRegistry<WebSocket>();

const serializeModelRequest = (request: NonNullable<Awaited<ReturnType<typeof getModelRequest>>>) => ({
  requestId: request.id,
  module: request.module,
  operation: request.operation,
  chatId: request.chatId,
  messageId: request.messageId,
  status: request.status,
  activeAttemptId: request.activeAttemptId,
  outputStarted: request.outputStarted,
  error: request.errorCode && request.errorSummary && request.diagnosticId ? {
    code: request.errorCode,
    retryable: false,
    receivedOutputTokens: request.outputStarted,
    provider: "",
    modelId: "",
    attempt: 0,
    summary: request.errorSummary,
    diagnosticId: request.diagnosticId
  } : null,
  createdAt: request.createdAt.toISOString(),
  startedAt: request.startedAt?.toISOString() ?? null,
  completedAt: request.completedAt?.toISOString() ?? null,
  updatedAt: request.updatedAt.toISOString()
});

const claimGenerationRequest = async (socket: WebSocket, input: {
  requestId: string;
  operation: string;
  chatId?: string;
  messageId?: string;
  overrideHardBudget?: boolean;
}) => {
  const claimed = await beginModelRequest({ requestId: input.requestId, module: "chat", operation: input.operation, chatId: input.chatId, messageId: input.messageId, overrideHardBudget: input.overrideHardBudget });
  if (!claimed.created) {
    sendJson(socket, { type: "generation_status", request: serializeModelRequest(claimed.request) });
    return false;
  }
  return true;
};

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
  regenerationGuidance,
  regenerationTargetContent,
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
  regenerationGuidance?: string;
  regenerationTargetContent?: string;
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

  const generationInstruction = continuationTargetMessageId
    ? {
        role: "user" as const,
        content:
          "Continue the immediately preceding assistant reply from its exact ending. Return only the continuation, without repeating or summarizing any existing text."
      }
    : regenerationGuidance && regenerationTargetContent
      ? buildRegenerationGuidanceMessage({
          originalResponse: regenerationTargetContent,
          guidance: regenerationGuidance
        })
      : null;
  const completionMessages = generationInstruction
    ? [...context.messages, generationInstruction]
    : context.messages;
  const completionPromptBreakdown = generationInstruction
    ? appendPromptBreakdownInstruction(context.promptBreakdown, generationInstruction.content)
    : context.promptBreakdown;

  let assistantContent = "";
  let stopped = false;
  let tokenUsage: TokenUsage | null = null;
  let reliableResult: ReliableTextResult | null = null;
  let activeAttempt: Extract<ReliableStreamEvent, { type: "attempt" }> | null = null;

  try {
    for await (const event of executeReliableTextStream({
      settings,
      messages: completionMessages,
      context: {
        requestId,
        module: "chat",
        operation: continuationTargetMessageId ? "continue" : targetMessageId ? "regenerate" : "generate",
        chatId,
        messageId: targetMessageId ?? continuationTargetMessageId,
        signal: abortController.signal,
        requestAlreadyClaimed: true
      }
    })) {
      if (event.type === "attempt") {
        activeAttempt = event;
        continue;
      }
      if (event.type === "retry") {
        sendJson(socket, { type: "generation_retrying", requestId, attempt: event.attempt, retryAfterMs: event.retryAfterMs, error: event.error.safe });
        continue;
      }
      if (event.type === "fallback") {
        sendJson(socket, { type: "generation_fallback", requestId, fromProviderId: event.from.providerId, fromModelId: event.from.modelId, toProviderId: event.to.providerId, toModelId: event.to.modelId, reason: event.error.safe.code });
        continue;
      }
      if (event.type === "complete") {
        reliableResult = event.result;
        tokenUsage = event.result.usage;
        continue;
      }
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
      const normalized = normalizeModelError(error, {
        provider: settings.activeProvider,
        modelId: settings.model,
        receivedOutputTokens: Boolean(assistantContent)
      });
      if (!assistantContent.trim()) throw normalized;
      assistantContent = stripThinkingTags(assistantContent);
      tokenUsage ??= estimateTokenUsage(completionMessages, assistantContent);
      const promptBreakdown = finalizePromptBreakdown(completionPromptBreakdown, tokenUsage.promptTokens, tokenUsage.estimated);
      const incompleteMetadata = activeAttempt
        ? incompleteGenerationMetadata({
            requestId,
            attemptId: activeAttempt.attemptId,
            providerId: activeAttempt.identity.providerId,
            providerType: activeAttempt.identity.providerType,
            modelId: activeAttempt.identity.modelId,
            pricing: activeAttempt.identity.pricing,
            usedFallback: activeAttempt.usedFallback,
            usage: tokenUsage
          })
        : null;
      const message = continuationTargetMessageId
        ? await appendAssistantContinuation(continuationTargetMessageId, assistantContent, tokenUsage, promptBreakdown, context.matchedLoreEntries, context.matchedMemoryEntries, incompleteMetadata)
        : targetMessageId
          ? await updateAssistantVariant(targetMessageId, assistantContent, tokenUsage, promptBreakdown, context.matchedLoreEntries, context.matchedMemoryEntries, incompleteMetadata)
          : await createAssistantMessage(chatId, characterId, assistantContent, tokenUsage, promptBreakdown, context.matchedLoreEntries, context.matchedMemoryEntries, incompleteMetadata);
      await linkModelRequestMessage(requestId, message.id);
      sendJson(socket, { type: "assistant_message", requestId, message: serializeMessage(message) });
      throw normalized;
    }
  }

  if (stopped) {
    if (assistantContent.trim()) {
      assistantContent = stripThinkingTags(assistantContent);
      tokenUsage ??= estimateTokenUsage(completionMessages, assistantContent);
      const promptBreakdown = finalizePromptBreakdown(
        completionPromptBreakdown,
        tokenUsage.promptTokens,
        tokenUsage.estimated
      );
      const stoppedMetadata = reliableResult
        ? generationMetadata(reliableResult)
        : activeAttempt
          ? incompleteGenerationMetadata({
              requestId,
              attemptId: activeAttempt.attemptId,
              providerId: activeAttempt.identity.providerId,
              providerType: activeAttempt.identity.providerType,
              modelId: activeAttempt.identity.modelId,
              pricing: activeAttempt.identity.pricing,
              usedFallback: activeAttempt.usedFallback,
              usage: tokenUsage
            })
          : null;
      const message = continuationTargetMessageId
        ? await appendAssistantContinuation(
            continuationTargetMessageId,
            assistantContent,
            tokenUsage,
            promptBreakdown,
            context.matchedLoreEntries,
            context.matchedMemoryEntries,
            stoppedMetadata
          )
        : targetMessageId
        ? await updateAssistantVariant(
            targetMessageId,
            assistantContent,
            tokenUsage,
            promptBreakdown,
            context.matchedLoreEntries,
            context.matchedMemoryEntries,
            stoppedMetadata
          )
        : await createAssistantMessage(
            chatId,
            characterId,
            assistantContent,
            tokenUsage,
            promptBreakdown,
            context.matchedLoreEntries,
            context.matchedMemoryEntries,
            stoppedMetadata
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
      await linkModelRequestMessage(requestId, message.id);
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
  const promptBreakdown = finalizePromptBreakdown(
    completionPromptBreakdown,
    tokenUsage.promptTokens,
    tokenUsage.estimated
  );
  const message = continuationTargetMessageId
    ? await appendAssistantContinuation(
        continuationTargetMessageId,
        assistantContent,
        tokenUsage,
        promptBreakdown,
        context.matchedLoreEntries,
        context.matchedMemoryEntries,
        reliableResult ? generationMetadata(reliableResult) : null
      )
    : targetMessageId
    ? await updateAssistantVariant(
        targetMessageId,
        assistantContent,
        tokenUsage,
        promptBreakdown,
        context.matchedLoreEntries,
        context.matchedMemoryEntries,
        reliableResult ? generationMetadata(reliableResult) : null
      )
    : await createAssistantMessage(
        chatId,
        characterId,
        assistantContent,
        tokenUsage,
        promptBreakdown,
        context.matchedLoreEntries,
        context.matchedMemoryEntries,
        reliableResult ? generationMetadata(reliableResult) : null
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
  await completeModelRequest(requestId, message.id);

  return stopped;
};

const createAssistantMessage = (
  chatId: string,
  characterId: string | null,
  content: string,
  tokenUsage: TokenUsage,
  promptBreakdown: PromptBreakdown,
  loreMatches: MatchedLoreEntry[],
  memoryMatches: MatchedMemoryEntry[],
  metadata: Prisma.InputJsonValue | null = null
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
      promptBreakdown,
      loreMatches,
      memoryMatches,
      generationMetadata: metadata ?? undefined,
      variantMetadata: metadata ? [metadata] : []
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
  promptBreakdown: PromptBreakdown,
  loreMatches: MatchedLoreEntry[],
  memoryMatches: MatchedMemoryEntry[],
  metadata: Prisma.InputJsonValue | null = null
) => {
  const targetMessage = await prisma.message.findFirst({
    where: { id: messageId, chat: { deletedAt: null } }
  });
  if (!targetMessage) {
    throw new Error("Assistant message not found");
  }

  const variants = appendVariant(targetMessage.variants, content);
  const existingMetadata = Array.isArray(targetMessage.variantMetadata) ? targetMessage.variantMetadata : [];
  return prisma.message.update({
    where: { id: messageId },
    data: {
      content,
      variants,
      activeVariantIndex: variants.length - 1,
      tokenUsage,
      promptBreakdown,
      loreMatches,
      memoryMatches,
      generationMetadata: metadata ?? undefined,
      variantMetadata: metadata ? [...existingMetadata, metadata] : existingMetadata
    }
  });
};

const appendAssistantContinuation = async (
  messageId: string,
  continuation: string,
  tokenUsage: TokenUsage,
  promptBreakdown: PromptBreakdown,
  loreMatches: MatchedLoreEntry[],
  memoryMatches: MatchedMemoryEntry[],
  metadata: Prisma.InputJsonValue | null = null
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
  const existingMetadata: unknown[] = Array.isArray(targetMessage.variantMetadata)
    ? [...targetMessage.variantMetadata]
    : [];
  while (existingMetadata.length <= activeVariantIndex) existingMetadata.push(null);
  if (metadata) existingMetadata[activeVariantIndex] = metadata;

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
      promptBreakdown,
      loreMatches,
      memoryMatches,
      generationMetadata: metadata ?? undefined,
      variantMetadata: existingMetadata as Prisma.InputJsonValue
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
  if (!await claimGenerationRequest(socket, { requestId: request.requestId, operation: "generate", chatId: request.chatId, overrideHardBudget: request.overrideHardBudget })) return;
  if (!controllers.register(request.requestId, socket, abortController)) return;

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
    const normalized = normalizeModelError(error, { provider: "", modelId: "", cancelled: abortController.signal.aborted });
    await failModelRequest(request.requestId, normalized);
    sendJson(socket, { type: "error", requestId: request.requestId, error: normalized.safe.summary, modelError: normalized.safe });
  } finally {
    controllers.release(request.requestId, abortController);
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
  if (!await claimGenerationRequest(socket, { requestId: request.requestId, operation: "regenerate", messageId: request.messageId, overrideHardBudget: request.overrideHardBudget })) return;
  if (!controllers.register(request.requestId, socket, abortController)) return;

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
      targetMessageId: targetMessage.id,
      regenerationGuidance: request.guidance,
      regenerationTargetContent: request.guidance ? targetMessage.content : undefined
    });

    sendJson(socket, {
      type: stopped ? "generation_stopped" : "generation_done",
      requestId: request.requestId
    });
  } catch (error) {
    const normalized = normalizeModelError(error, { provider: "", modelId: "", cancelled: abortController.signal.aborted });
    await failModelRequest(request.requestId, normalized);
    sendJson(socket, { type: "error", requestId: request.requestId, error: normalized.safe.summary, modelError: normalized.safe });
  } finally {
    controllers.release(request.requestId, abortController);
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
  if (!await claimGenerationRequest(socket, { requestId: request.requestId, operation: "continue", messageId: request.messageId, overrideHardBudget: request.overrideHardBudget })) return;
  if (!controllers.register(request.requestId, socket, abortController)) return;

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
    const normalized = normalizeModelError(error, { provider: "", modelId: "", cancelled: abortController.signal.aborted });
    await failModelRequest(request.requestId, normalized);
    sendJson(socket, { type: "error", requestId: request.requestId, error: normalized.safe.summary, modelError: normalized.safe });
  } finally {
    controllers.release(request.requestId, abortController);
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
  if (!await claimGenerationRequest(socket, { requestId: request.requestId, operation: "resend", messageId: request.messageId, overrideHardBudget: request.overrideHardBudget })) return;
  if (!controllers.register(request.requestId, socket, abortController)) return;

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
    const normalized = normalizeModelError(error, { provider: "", modelId: "", cancelled: abortController.signal.aborted });
    await failModelRequest(request.requestId, normalized);
    sendJson(socket, { type: "error", requestId: request.requestId, error: normalized.safe.summary, modelError: normalized.safe });
  } finally {
    controllers.release(request.requestId, abortController);
  }
};

const handleStop = (socket: WebSocket, rawMessage: unknown) => {
  const parsed = stopGenerationRequestSchema.safeParse(rawMessage);
  if (!parsed.success) {
    sendJson(socket, { type: "error", error: "Invalid stop request" });
    return;
  }

  controllers.abortRequest(parsed.data.requestId);
};

const handleStatus = async (socket: WebSocket, rawMessage: unknown) => {
  const parsed = generationStatusRequestSchema.safeParse(rawMessage);
  if (!parsed.success) {
    sendJson(socket, { type: "error", error: "Invalid generation status request" });
    return;
  }
  const request = await getModelRequest(parsed.data.requestId);
  if (!request) {
    sendJson(socket, { type: "error", requestId: parsed.data.requestId, error: "Generation request not found" });
    return;
  }
  sendJson(socket, { type: "generation_status", request: serializeModelRequest(request) });
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
    if (isPrivacyLocked()) {
      socket.close(4403, "App locked");
      return;
    }
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

        if (messageType === "status") {
          void handleStatus(socket, parsed);
          return;
        }

        sendJson(socket, { type: "error", error: "Unknown WebSocket message type" });
      } catch {
        sendJson(socket, { type: "error", error: "Malformed WebSocket message" });
      }
    });

    socket.on("close", () => {
      controllers.abortSocket(socket);
    });
  });
};
