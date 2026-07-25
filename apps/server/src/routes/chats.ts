import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { asyncHandler, HttpError, parseBody, parseQuery, requireParam } from "../lib/http.js";
import {
  chatAgentDraftSchema,
  chatArchiveImportSchema,
  chatBatchArchiveSchema,
  chatBatchPermanentDeleteSchema,
  chatBatchTrashSchema,
  chatBranchSchema,
  chatCreateSchema,
  chatMemoryCreateSchema,
  chatMessageSearchQuerySchema,
  chatMemoryUpdateSchema,
  chatUpdateSchema
} from "../schemas.js";
import { serializeChat, serializeChatMemory, serializeMessage } from "../serializers.js";
import { createChatAgentDraft } from "../services/chatAgent.js";
import { createChatOpeningMessage } from "../services/chatOpening.js";
import { createChatTitleSuggestion } from "../services/chatTitle.js";
import { exportChatArchive, importChatArchive } from "../services/chatArchives.js";
import {
  refreshChatMemoryEmbeddings,
  updateChatMemoriesFromTurn
} from "../services/chatMemories.js";
import { getOrCreateSettings } from "./settings.js";

export const chatsRouter = Router();

const buildMessageSearchSnippet = (content: string, query: string) => {
  const normalizedContent = content.toLowerCase();
  const normalizedQuery = query.toLowerCase();
  const matchIndex = normalizedContent.indexOf(normalizedQuery);
  if (matchIndex < 0) {
    return content.slice(0, 160);
  }

  const start = Math.max(0, matchIndex - 60);
  const end = Math.min(content.length, matchIndex + query.length + 100);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < content.length ? "..." : "";
  return `${prefix}${content.slice(start, end)}${suffix}`;
};

const buildChatListPreview = (content: string) => {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > 180 ? `${normalized.slice(0, 179)}…` : normalized;
};

chatsRouter.get(
  "/",
  asyncHandler(async (_request, response) => {
    const chats = await prisma.chat.findMany({
      orderBy: [
        { deletedAt: "asc" },
        { isArchived: "asc" },
        { isPinned: "desc" },
        { updatedAt: "desc" }
      ],
      include: {
        _count: { select: { messages: true } },
        messages: {
          where: { role: { in: ["user", "assistant"] } },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { role: true, content: true, createdAt: true }
        }
      }
    });

    response.json({
      ok: true,
      data: chats.map((chat) => {
        const lastMessage = chat.messages[0];
        return {
          ...serializeChat(chat, chat._count.messages),
          lastMessagePreview:
            lastMessage && (lastMessage.role === "user" || lastMessage.role === "assistant")
              ? {
                  role: lastMessage.role,
                  content: buildChatListPreview(lastMessage.content),
                  createdAt: lastMessage.createdAt.toISOString()
                }
              : null
        };
      })
    });
  })
);

chatsRouter.post(
  "/",
  asyncHandler(async (request, response) => {
    const body = parseBody(chatCreateSchema, request.body);
    const chat = await prisma.chat.create({ data: body });

    response.status(201).json({ ok: true, data: serializeChat(chat) });
  })
);

chatsRouter.post(
  "/batch-archive",
  asyncHandler(async (request, response) => {
    const body = parseBody(chatBatchArchiveSchema, request.body);
    const result = await prisma.chat.updateMany({
      where: { id: { in: body.ids }, deletedAt: null },
      data: { isArchived: body.isArchived }
    });

    response.json({ ok: true, data: { updated: result.count } });
  })
);

chatsRouter.post(
  "/batch-trash",
  asyncHandler(async (request, response) => {
    const body = parseBody(chatBatchTrashSchema, request.body);
    const deletedAt = body.action === "trash" ? null : { not: null };
    const result = await prisma.$transaction(async (tx) => {
      const found = await tx.chat.count({
        where: { id: { in: body.ids }, deletedAt }
      });
      if (found !== body.ids.length) {
        throw new HttpError(404, "One or more chats were not found in the expected history scope");
      }

      return tx.chat.updateMany({
        where: { id: { in: body.ids }, deletedAt },
        data:
          body.action === "trash"
            ? { deletedAt: new Date(), isArchived: false, isPinned: false }
            : { deletedAt: null }
      });
    });

    response.json({ ok: true, data: { updated: result.count } });
  })
);

chatsRouter.post(
  "/batch-permanent-delete",
  asyncHandler(async (request, response) => {
    const body = parseBody(chatBatchPermanentDeleteSchema, request.body);
    const deleted = await prisma.$transaction(async (tx) => {
      const found = await tx.chat.count({
        where: { id: { in: body.ids }, deletedAt: { not: null } }
      });
      if (found !== body.ids.length) {
        throw new HttpError(404, "One or more trashed chats were not found");
      }

      await tx.chat.updateMany({
        where: { parentChatId: { in: body.ids } },
        data: { parentChatId: null, branchSourceMessageId: null }
      });
      return tx.chat.deleteMany({ where: { id: { in: body.ids } } });
    });

    response.json({ ok: true, data: { deleted: deleted.count } });
  })
);

chatsRouter.post(
  "/:id/agent-draft",
  asyncHandler(async (request, response) => {
    const chatId = requireParam(request, "id");
    const body = parseBody(chatAgentDraftSchema, request.body);
    const draft = await createChatAgentDraft({ chatId, ...body });

    response.json({ ok: true, data: draft });
  })
);

chatsRouter.get(
  "/:id/archive",
  asyncHandler(async (request, response) => {
    response.json({ ok: true, data: await exportChatArchive(requireParam(request, "id")) });
  })
);

chatsRouter.post(
  "/import-archive",
  asyncHandler(async (request, response) => {
    const body = parseBody(chatArchiveImportSchema, request.body);
    response.status(201).json({ ok: true, data: await importChatArchive(body) });
  })
);

chatsRouter.post(
  "/:id/title-suggestion",
  asyncHandler(async (request, response) => {
    const chatId = requireParam(request, "id");
    response.json({ ok: true, data: await createChatTitleSuggestion(chatId) });
  })
);

chatsRouter.post(
  "/:id/opening-message",
  asyncHandler(async (request, response) => {
    const chatId = requireParam(request, "id");
    const message = await createChatOpeningMessage(chatId);

    response.status(201).json({ ok: true, data: message });
  })
);

chatsRouter.post(
  "/:id/branches",
  asyncHandler(async (request, response) => {
    const chatId = requireParam(request, "id");
    const body = parseBody(chatBranchSchema, request.body);
    const chat = await prisma.chat.findFirst({
      where: { id: chatId, deletedAt: null },
      include: {
        messages: { orderBy: { createdAt: "asc" } }
      }
    });

    if (!chat) {
      throw new HttpError(404, "Chat not found");
    }

    const targetIndex = chat.messages.findIndex((message) => message.id === body.messageId);
    if (targetIndex < 0) {
      throw new HttpError(404, "Branch message not found");
    }

    const messagesToCopy = chat.messages.slice(0, targetIndex + 1);
    const now = new Date();
    const isCheckpoint = body.kind === "checkpoint";
    const branch = await prisma.chat.create({
      data: {
        title: body.title ?? `${chat.title} - ${isCheckpoint ? "Checkpoint" : "Branch"}`,
        characterId: chat.characterId,
        parentChatId: chat.id,
        branchSourceMessageId: chat.messages[targetIndex]?.id ?? null,
        isCheckpoint,
        backgroundUrl: chat.backgroundUrl,
        memoryTurns: chat.memoryTurns,
        autoMemoryEnabled: chat.autoMemoryEnabled,
        userPersona: chat.userPersona,
        userProfileSummary: chat.userProfileSummary,
        userProfileUpdatedAt: chat.userProfileUpdatedAt,
        createdAt: now,
        updatedAt: now
      }
    });

    await prisma.message.createMany({
      data: messagesToCopy.map((message) => ({
        chatId: branch.id,
        role: message.role,
        characterId: message.characterId,
        content: message.content,
        contextIncluded: message.contextIncluded,
        isBookmarked: message.isBookmarked,
        variants: (message.variants ?? []) as Prisma.InputJsonValue,
        activeVariantIndex: message.activeVariantIndex,
        tokenUsage:
          message.tokenUsage === null ? Prisma.JsonNull : (message.tokenUsage as Prisma.InputJsonValue),
        loreMatches:
          message.loreMatches === null ? Prisma.JsonNull : (message.loreMatches as Prisma.InputJsonValue),
        memoryMatches:
          message.memoryMatches === null ? Prisma.JsonNull : (message.memoryMatches as Prisma.InputJsonValue),
        createdAt: message.createdAt,
        updatedAt: message.updatedAt
      }))
    });

    const branchWithMessages = await prisma.chat.findUniqueOrThrow({
      where: { id: branch.id },
      include: {
        messages: { orderBy: { createdAt: "asc" } },
        memories: { orderBy: [{ enabled: "desc" }, { importance: "desc" }, { updatedAt: "desc" }] }
      }
    });

    response.status(201).json({
      ok: true,
      data: {
        ...serializeChat(branchWithMessages, branchWithMessages.messages.length),
        messages: branchWithMessages.messages.map(serializeMessage),
        memories: branchWithMessages.memories.map(serializeChatMemory)
      }
    });
  })
);

chatsRouter.get(
  "/message-search",
  asyncHandler(async (request, response) => {
    const query = parseQuery(chatMessageSearchQuerySchema, request.query);
    const messages = await prisma.message.findMany({
      where: { chat: { deletedAt: null } },
      include: { chat: { select: { id: true, title: true, characterId: true, isArchived: true } } },
      orderBy: [{ chatId: "asc" }, { createdAt: "asc" }]
    });
    const normalizedQuery = query.q.toLowerCase();
    const indexesByChat = new Map<string, number>();
    const matches = messages.flatMap((message) => {
      const index = indexesByChat.get(message.chatId) ?? 0;
      indexesByChat.set(message.chatId, index + 1);
      if (!message.content.toLowerCase().includes(normalizedQuery)) {
        return [];
      }
      return [{ message, index }];
    });

    matches.sort((a, b) => b.message.createdAt.getTime() - a.message.createdAt.getTime());
    response.json({
      ok: true,
      data: {
        query: query.q,
        total: matches.length,
        results: matches.slice(0, query.limit).map(({ message, index }) => ({
          chat: message.chat,
          message: serializeMessage(message),
          index,
          snippet: buildMessageSearchSnippet(message.content, query.q)
        }))
      }
    });
  })
);

chatsRouter.get(
  "/:id/message-search",
  asyncHandler(async (request, response) => {
    const chatId = requireParam(request, "id");
    const query = parseQuery(chatMessageSearchQuerySchema, request.query);
    const chat = await prisma.chat.findFirst({
      where: { id: chatId, deletedAt: null },
      select: { id: true }
    });

    if (!chat) {
      throw new HttpError(404, "Chat not found");
    }

    const messages = await prisma.message.findMany({
      where: { chatId },
      orderBy: { createdAt: "asc" }
    });
    const normalizedQuery = query.q.toLowerCase();
    const matches = messages
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => message.content.toLowerCase().includes(normalizedQuery));

    response.json({
      ok: true,
      data: {
        query: query.q,
        total: matches.length,
        results: matches.slice(0, query.limit).map(({ message, index }) => ({
          message: serializeMessage(message),
          index,
          snippet: buildMessageSearchSnippet(message.content, query.q)
        }))
      }
    });
  })
);

chatsRouter.get(
  "/:id/memories",
  asyncHandler(async (request, response) => {
    const chatId = requireParam(request, "id");
    const chat = await prisma.chat.findFirst({
      where: { id: chatId, deletedAt: null },
      select: { id: true }
    });
    if (!chat) {
      throw new HttpError(404, "Chat not found");
    }

    const memories = await prisma.chatMemory.findMany({
      where: { chatId },
      orderBy: [{ enabled: "desc" }, { importance: "desc" }, { updatedAt: "desc" }]
    });

    response.json({ ok: true, data: memories.map(serializeChatMemory) });
  })
);

chatsRouter.post(
  "/:id/memories",
  asyncHandler(async (request, response) => {
    const chatId = requireParam(request, "id");
    const body = parseBody(chatMemoryCreateSchema, request.body);
    const chat = await prisma.chat.findFirst({
      where: { id: chatId, deletedAt: null },
      select: { id: true }
    });
    if (!chat) {
      throw new HttpError(404, "Chat not found");
    }

    const createdMemory = await prisma.chatMemory.create({
      data: {
        ...body,
        chatId
      }
    });
    const settings = await getOrCreateSettings();
    await refreshChatMemoryEmbeddings({ chatId, settings });
    const memory = await prisma.chatMemory.findUniqueOrThrow({ where: { id: createdMemory.id } });

    response.status(201).json({ ok: true, data: serializeChatMemory(memory) });
  })
);

chatsRouter.put(
  "/:id/memories/:memoryId",
  asyncHandler(async (request, response) => {
    const chatId = requireParam(request, "id");
    const memoryId = requireParam(request, "memoryId");
    const body = parseBody(chatMemoryUpdateSchema, request.body);
    const existing = await prisma.chatMemory.findFirst({
      where: { id: memoryId, chatId, chat: { deletedAt: null } }
    });
    if (!existing) {
      throw new HttpError(404, "Memory not found");
    }

    const embeddingSourceChanged =
      Object.hasOwn(body, "title") ||
      Object.hasOwn(body, "content") ||
      Object.hasOwn(body, "keywords");
    const updatedMemory = await prisma.chatMemory.update({
      where: { id: memoryId },
      data: {
        ...body,
        ...(embeddingSourceChanged
          ? {
              embedding: Prisma.JsonNull,
              embeddingModel: null,
              embeddingUpdatedAt: null
            }
          : {})
      }
    });
    const settings = await getOrCreateSettings();
    if (updatedMemory.enabled) {
      await refreshChatMemoryEmbeddings({ chatId, settings });
    }
    const memory = await prisma.chatMemory.findUniqueOrThrow({ where: { id: memoryId } });

    response.json({ ok: true, data: serializeChatMemory(memory) });
  })
);

chatsRouter.delete(
  "/:id/memories/:memoryId",
  asyncHandler(async (request, response) => {
    const chatId = requireParam(request, "id");
    const memoryId = requireParam(request, "memoryId");
    const existing = await prisma.chatMemory.findFirst({
      where: { id: memoryId, chatId, chat: { deletedAt: null } }
    });
    if (!existing) {
      throw new HttpError(404, "Memory not found");
    }

    await prisma.chatMemory.delete({ where: { id: memoryId } });
    response.status(204).send();
  })
);

chatsRouter.post(
  "/:id/memories/refresh",
  asyncHandler(async (request, response) => {
    const chatId = requireParam(request, "id");
    const chat = await prisma.chat.findFirst({
      where: { id: chatId, deletedAt: null },
      select: { id: true }
    });
    if (!chat) {
      throw new HttpError(404, "Chat not found");
    }

    const settings = await getOrCreateSettings();
    await updateChatMemoriesFromTurn({ chatId, settings });
    await refreshChatMemoryEmbeddings({ chatId, settings });
    const memories = await prisma.chatMemory.findMany({
      where: { chatId },
      orderBy: [{ enabled: "desc" }, { importance: "desc" }, { updatedAt: "desc" }]
    });

    response.json({ ok: true, data: memories.map(serializeChatMemory) });
  })
);

chatsRouter.get(
  "/:id",
  asyncHandler(async (request, response) => {
    const id = requireParam(request, "id");
    const chat = await prisma.chat.findFirst({
      where: { id, deletedAt: null },
      include: {
        messages: { orderBy: { createdAt: "asc" } },
        memories: { orderBy: [{ enabled: "desc" }, { importance: "desc" }, { updatedAt: "desc" }] }
      }
    });

    if (!chat) {
      throw new HttpError(404, "Chat not found");
    }

    response.json({
      ok: true,
      data: {
        ...serializeChat(chat),
        messages: chat.messages.map(serializeMessage),
        memories: chat.memories.map(serializeChatMemory)
      }
    });
  })
);

chatsRouter.put(
  "/:id",
  asyncHandler(async (request, response) => {
    const id = requireParam(request, "id");
    const body = parseBody(chatUpdateSchema, request.body);

    const existing = await prisma.chat.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
    if (!existing) {
      throw new HttpError(404, "Chat not found");
    }

    const chat = await prisma.chat.update({
      where: { id: existing.id },
      data: body,
      include: { _count: { select: { messages: true } } }
    });

    response.json({ ok: true, data: serializeChat(chat, chat._count.messages) });
  })
);

chatsRouter.post(
  "/:id/restore",
  asyncHandler(async (request, response) => {
    const id = requireParam(request, "id");
    const existing = await prisma.chat.findFirst({
      where: { id, deletedAt: { not: null } },
      select: { id: true }
    });
    if (!existing) {
      throw new HttpError(404, "Trashed chat not found");
    }

    const chat = await prisma.chat.update({
      where: { id },
      data: { deletedAt: null },
      include: { _count: { select: { messages: true } } }
    });
    response.json({ ok: true, data: serializeChat(chat, chat._count.messages) });
  })
);

chatsRouter.delete(
  "/:id/permanent",
  asyncHandler(async (request, response) => {
    const id = requireParam(request, "id");
    const existing = await prisma.chat.findFirst({
      where: { id, deletedAt: { not: null } },
      select: { id: true }
    });
    if (!existing) {
      throw new HttpError(404, "Trashed chat not found");
    }

    await prisma.$transaction([
      prisma.chat.updateMany({
        where: { parentChatId: id },
        data: { parentChatId: null, branchSourceMessageId: null }
      }),
      prisma.chat.delete({ where: { id } })
    ]);
    response.status(204).send();
  })
);

chatsRouter.delete(
  "/:id",
  asyncHandler(async (request, response) => {
    const id = requireParam(request, "id");
    const existing = await prisma.chat.findUnique({ where: { id }, select: { id: true, deletedAt: true } });
    if (!existing) {
      throw new HttpError(404, "Chat not found");
    }
    if (!existing.deletedAt) {
      await prisma.chat.update({
        where: { id },
        data: { deletedAt: new Date(), isArchived: false, isPinned: false }
      });
    }

    response.status(204).send();
  })
);
