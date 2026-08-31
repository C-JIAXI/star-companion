import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { asyncHandler, HttpError, parseBody, parseQuery, requireParam } from "../lib/http.js";
import {
  chatAgentDraftSchema,
  chatArchiveImportSchema,
  chatBatchArchiveSchema,
  chatBatchFolderSchema,
  chatRenameFolderSchema,
  chatBatchPermanentDeleteSchema,
  chatBatchTrashSchema,
  chatBranchSchema,
  chatCreateSchema,
  chatMemoryCreateSchema,
  chatMessageSearchQuerySchema,
  chatPageQuerySchema,
  chatMemoryUpdateSchema,
  memoryPurgeSchema,
  memoryPageQuerySchema,
  memoryRestoreExecuteSchema,
  memoryRevisionParamsSchema,
  memoryUndoExecuteSchema,
  profileSummaryRestoreExecuteSchema,
  chatUpdateSchema
} from "../schemas.js";
import { serializeChat, serializeChatMemory, serializeMessage } from "../serializers.js";
import { createChatAgentDraft } from "../services/chatAgent.js";
import { listChatPage } from "../services/chatPaging.js";
import { createChatOpeningMessage } from "../services/chatOpening.js";
import { deleteUnreferencedAssets, messageIncludeAttachments } from "../services/messageAttachments.js";
import { createChatTitleSuggestion } from "../services/chatTitle.js";
import { exportChatArchive, importChatArchive } from "../services/chatArchives.js";
import {
  refreshChatMemoryEmbeddings,
  updateChatMemoriesFromTurn
} from "../services/chatMemories.js";
import { resolveModuleSettings } from "../services/moduleModels.js";
import { getOrCreateSettings } from "./settings.js";
import {
  createManualMemory,
  deleteManualMemory,
  executeMemoryOperationUndo,
  listMemoryOperations,
  listMemoryRevisions,
  listProfileSummaryRevisions,
  previewSpecificMemoryOperationUndo,
  previewMemoryRestore,
  previewProfileSummaryRestore,
  purgeMemoryHistory,
  restoreMemoryRevision,
  restoreProfileSummaryRevision,
  updateManualMemory,
  updateProfileSummaryInTransaction
} from "../services/memoryHistory.js";
import { searchMessagesPage } from "../services/messageSearch.js";
import { listMemoryPage } from "../services/memoryPaging.js";
import {
  cancelMemoryEmbeddingJob,
  getMemoryEmbeddingJob,
  startMemoryEmbeddingJob
} from "../services/memoryEmbeddingJobs.js";

export const chatsRouter = Router();

chatsRouter.get("/page", asyncHandler(async (request, response) => {
  response.json({ ok: true, data: await listChatPage(parseQuery(chatPageQuerySchema, request.query)) });
}));

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
          ...serializeChat(chat, chat._count.messages, false),
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
    const initialProfile = body.userProfileSummary.trim();
    const chat = await prisma.$transaction(async (tx) => {
      const created = await tx.chat.create({
        data: { ...body, userProfileSummary: initialProfile, profileRevision: initialProfile ? 1 : 0 }
      });
      if (initialProfile) {
        await tx.profileSummaryRevision.create({
          data: {
            chatId: created.id,
            revision: 1,
            action: "baseline",
            actor: "user",
            summary: initialProfile,
            sourceMessageIds: []
          }
        });
      }
      return created;
    });

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
  "/batch-folder",
  asyncHandler(async (request, response) => {
    const body = parseBody(chatBatchFolderSchema, request.body);
    const result = await prisma.$transaction(async (tx) => {
      const found = await tx.chat.count({ where: { id: { in: body.ids } } });
      if (found !== body.ids.length) {
        throw new HttpError(404, "One or more chats were not found");
      }

      return tx.chat.updateMany({
        where: { id: { in: body.ids } },
        data: { folder: body.folder }
      });
    });

    response.json({ ok: true, data: { updated: result.count } });
  })
);

chatsRouter.post(
  "/rename-folder",
  asyncHandler(async (request, response) => {
    const body = parseBody(chatRenameFolderSchema, request.body);
    const result = await prisma.chat.updateMany({
      where: { folder: body.from },
      data: { folder: body.to }
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
      const result = await tx.chat.deleteMany({ where: { id: { in: body.ids } } });
      await deleteUnreferencedAssets(tx);
      return result;
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
  "/:id/auto-title",
  asyncHandler(async (request, response) => {
    const chatId = requireParam(request, "id");
    const current = await prisma.chat.findFirst({
      where: { id: chatId, deletedAt: null },
      select: { title: true }
    });
    if (!current) {
      throw new HttpError(404, "Chat not found");
    }
    if (current.title !== "New Chat") {
      response.json({ ok: true, data: null });
      return;
    }

    const suggestion = await createChatTitleSuggestion(chatId);
    const result = await prisma.chat.updateMany({
      where: { id: chatId, deletedAt: null, title: "New Chat" },
      data: { title: suggestion.title }
    });
    if (result.count === 0) {
      response.json({ ok: true, data: null });
      return;
    }

    const chat = await prisma.chat.findUniqueOrThrow({ where: { id: chatId } });
    response.json({ ok: true, data: serializeChat(chat) });
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
        messages: { orderBy: { createdAt: "asc" }, include: messageIncludeAttachments }
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
    const branch = await prisma.$transaction(async (tx) => {
      const created = await tx.chat.create({ data: {
        title: body.title ?? `${chat.title} - ${isCheckpoint ? "Checkpoint" : "Branch"}`,
        characterId: chat.characterId,
        parentChatId: chat.id,
        branchSourceMessageId: chat.messages[targetIndex]?.id ?? null,
        isCheckpoint,
        folder: chat.folder,
        backgroundUrl: chat.backgroundUrl,
        memoryTurns: chat.memoryTurns,
        autoMemoryEnabled: chat.autoMemoryEnabled,
        userPersona: chat.userPersona,
        userAvatar: chat.userAvatar,
        userProfileSummary: chat.userProfileSummary,
        userProfileUpdatedAt: chat.userProfileUpdatedAt,
        profileRevision: chat.userProfileSummary ? 1 : 0,
        createdAt: now,
        updatedAt: now
      } });
      if (chat.userProfileSummary) {
        await tx.profileSummaryRevision.create({ data: {
          chatId: created.id, revision: 1, action: "baseline", actor: "restore",
          summary: chat.userProfileSummary, sourceMessageIds: [], createdAt: now
        } });
      }
      for (const message of messagesToCopy) {
        const copied = await tx.message.create({ data: {
          chatId: created.id,
          role: message.role,
          characterId: message.characterId,
          content: message.content,
          contextIncluded: message.contextIncluded,
          isBookmarked: message.isBookmarked,
          variants: (message.variants ?? []) as Prisma.InputJsonValue,
          activeVariantIndex: message.activeVariantIndex,
          tokenUsage: message.tokenUsage === null ? Prisma.JsonNull : (message.tokenUsage as Prisma.InputJsonValue),
          generationMetadata: message.generationMetadata === null ? Prisma.JsonNull : (message.generationMetadata as Prisma.InputJsonValue),
          variantMetadata: (message.variantMetadata ?? []) as Prisma.InputJsonValue,
          promptBreakdown: message.promptBreakdown === null ? Prisma.JsonNull : (message.promptBreakdown as Prisma.InputJsonValue),
          loreMatches: message.loreMatches === null ? Prisma.JsonNull : (message.loreMatches as Prisma.InputJsonValue),
          memoryMatches: message.memoryMatches === null ? Prisma.JsonNull : (message.memoryMatches as Prisma.InputJsonValue),
          createdAt: message.createdAt,
          updatedAt: message.updatedAt
        } });
        if (message.attachments.length) await tx.messageAttachment.createMany({ data: message.attachments.map((attachment) => ({
          messageId: copied.id,
          assetId: attachment.assetId,
          sortOrder: attachment.sortOrder,
          originalFilename: attachment.originalFilename,
          createdAt: attachment.createdAt
        })) });
      }
      return created;
    });

    const branchWithMessages = await prisma.chat.findUniqueOrThrow({
      where: { id: branch.id },
      include: {
        messages: { orderBy: { createdAt: "asc" }, include: messageIncludeAttachments },
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
    response.json({ ok: true, data: await searchMessagesPage({ query: query.q, limit: query.limit, cursor: query.cursor }) });
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

    response.json({ ok: true, data: await searchMessagesPage({ query: query.q, limit: query.limit, cursor: query.cursor, chatId }) });
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
      orderBy: [{ deletedAt: "asc" }, { enabled: "desc" }, { importance: "desc" }, { updatedAt: "desc" }]
    });

    response.json({ ok: true, data: memories.map(serializeChatMemory) });
  })
);

chatsRouter.get("/:id/memories/page", asyncHandler(async (request, response) => {
  const chatId = requireParam(request, "id");
  const chat = await prisma.chat.findFirst({ where: { id: chatId, deletedAt: null }, select: { id: true } });
  if (!chat) throw new HttpError(404, "Chat not found");
  response.json({ ok: true, data: await listMemoryPage(chatId, parseQuery(memoryPageQuerySchema, request.query)) });
}));

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

    const { actor, ...memoryInput } = body;
    const { memory: createdMemory } = await createManualMemory(chatId, memoryInput, actor);
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

    const { memory: updatedMemory } = await updateManualMemory(chatId, memoryId, body);
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

    await deleteManualMemory(chatId, memoryId);
    response.status(204).send();
  })
);

chatsRouter.get("/:id/memories/:memoryId/revisions", asyncHandler(async (request, response) => {
  response.json({ ok: true, data: await listMemoryRevisions(requireParam(request, "id"), requireParam(request, "memoryId")) });
}));

chatsRouter.get("/:id/memories/:memoryId/revisions/:revision/restore-preview", asyncHandler(async (request, response) => {
  const query = parseQuery(memoryRevisionParamsSchema, { revision: requireParam(request, "revision") });
  response.json({ ok: true, data: await previewMemoryRestore(requireParam(request, "id"), requireParam(request, "memoryId"), query.revision) });
}));

chatsRouter.post("/:id/memories/:memoryId/restore", asyncHandler(async (request, response) => {
  const body = parseBody(memoryRestoreExecuteSchema, request.body);
  response.json({ ok: true, data: await restoreMemoryRevision(requireParam(request, "id"), requireParam(request, "memoryId"), body.revision, body.expectedCurrentRevision) });
}));

chatsRouter.post("/:id/memories/:memoryId/purge", asyncHandler(async (request, response) => {
  parseBody(memoryPurgeSchema, request.body);
  response.json({ ok: true, data: await purgeMemoryHistory(requireParam(request, "id"), requireParam(request, "memoryId")) });
}));

chatsRouter.get("/:id/memory-operations", asyncHandler(async (request, response) => {
  response.json({ ok: true, data: await listMemoryOperations(requireParam(request, "id")) });
}));

chatsRouter.post("/:id/memory-operations/:operationId/undo-preview", asyncHandler(async (request, response) => {
  response.json({ ok: true, data: await previewSpecificMemoryOperationUndo(requireParam(request, "id"), requireParam(request, "operationId")) });
}));

chatsRouter.post("/:id/memory-operations/:operationId/undo", asyncHandler(async (request, response) => {
  const body = parseBody(memoryUndoExecuteSchema, request.body);
  response.json({ ok: true, data: await executeMemoryOperationUndo(requireParam(request, "id"), requireParam(request, "operationId"), body.resolutions) });
}));

chatsRouter.get("/:id/profile-summary/revisions", asyncHandler(async (request, response) => {
  response.json({ ok: true, data: await listProfileSummaryRevisions(requireParam(request, "id")) });
}));

chatsRouter.get("/:id/profile-summary/revisions/:revision/restore-preview", asyncHandler(async (request, response) => {
  const query = parseQuery(memoryRevisionParamsSchema, { revision: requireParam(request, "revision") });
  response.json({ ok: true, data: await previewProfileSummaryRestore(requireParam(request, "id"), query.revision) });
}));

chatsRouter.post("/:id/profile-summary/restore", asyncHandler(async (request, response) => {
  const body = parseBody(profileSummaryRestoreExecuteSchema, request.body);
  response.json({ ok: true, data: await restoreProfileSummaryRevision(requireParam(request, "id"), body.revision, body.expectedCurrentRevision) });
}));

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
    const memories = await prisma.chatMemory.findMany({
      where: { chatId },
      orderBy: [{ deletedAt: "asc" }, { enabled: "desc" }, { importance: "desc" }, { updatedAt: "desc" }]
    });

    response.json({ ok: true, data: memories.map(serializeChatMemory) });
  })
);

chatsRouter.post(
  "/:id/memories/reindex",
  asyncHandler(async (request, response) => {
    const chatId = requireParam(request, "id");
    const chat = await prisma.chat.findFirst({
      where: { id: chatId, deletedAt: null },
      select: { id: true }
    });
    if (!chat) {
      throw new HttpError(404, "Chat not found");
    }

    const enabledMemoryCount = await prisma.chatMemory.count({
      where: { chatId, enabled: true }
    });
    if (enabledMemoryCount === 0) {
      const memories = await prisma.chatMemory.findMany({
        where: { chatId },
        orderBy: [{ enabled: "desc" }, { importance: "desc" }, { updatedAt: "desc" }]
      });
      response.json({ ok: true, data: memories.map(serializeChatMemory) });
      return;
    }

    const settings = await getOrCreateSettings();
    try {
      resolveModuleSettings(settings, "memory_embedding");
    } catch {
      throw new HttpError(400, "Configure a compatible memory embedding model before rebuilding the index.");
    }

    const index = await refreshChatMemoryEmbeddings({ chatId, settings, force: true });
    if (!index) {
      throw new HttpError(
        502,
        "Memory embedding index rebuild failed. Keyword retrieval remains available."
      );
    }

    const memories = await prisma.chatMemory.findMany({
      where: { chatId },
      orderBy: [{ enabled: "desc" }, { importance: "desc" }, { updatedAt: "desc" }]
    });
    response.json({ ok: true, data: memories.map(serializeChatMemory) });
  })
);

chatsRouter.post(
  "/:id/memories/reindex-jobs",
  asyncHandler(async (request, response) => {
    const chatId = requireParam(request, "id");
    const chat = await prisma.chat.findFirst({
      where: { id: chatId, deletedAt: null },
      select: { id: true }
    });
    if (!chat) throw new HttpError(404, "Chat not found");

    const total = await prisma.chatMemory.count({
      where: { chatId, enabled: true, deletedAt: null }
    });
    const settings = await getOrCreateSettings();
    if (total > 0) {
      try {
        resolveModuleSettings(settings, "memory_embedding");
      } catch {
        throw new HttpError(400, "Configure a compatible memory embedding model before rebuilding the index.");
      }
    }
    response.status(202).json({
      ok: true,
      data: startMemoryEmbeddingJob({ chatId, settings, total })
    });
  })
);

chatsRouter.get("/:id/memories/reindex-jobs/:jobId", asyncHandler(async (request, response) => {
  const job = getMemoryEmbeddingJob(requireParam(request, "id"), requireParam(request, "jobId"));
  if (!job) throw new HttpError(404, "Memory index rebuild job not found");
  response.json({ ok: true, data: job });
}));

chatsRouter.delete("/:id/memories/reindex-jobs/:jobId", asyncHandler(async (request, response) => {
  const job = cancelMemoryEmbeddingJob(requireParam(request, "id"), requireParam(request, "jobId"));
  if (!job) throw new HttpError(404, "Memory index rebuild job not found");
  response.json({ ok: true, data: job });
}));

chatsRouter.get("/:id/memories/index-summary", asyncHandler(async (request, response) => {
  const chatId = requireParam(request, "id");
  const rows = await prisma.chatMemory.groupBy({
    by: ["embeddingStatus"],
    where: { chatId, enabled: true, deletedAt: null },
    _count: { _all: true }
  });
  const total = rows.reduce((sum, row) => sum + row._count._all, 0);
  const ready = rows.find((row) => row.embeddingStatus === "ready")?._count._all ?? 0;
  const failed = rows.find((row) => row.embeddingStatus === "failed")?._count._all ?? 0;
  response.json({ ok: true, data: { total, ready, failed, stale: total - ready - failed } });
}));

chatsRouter.get("/:id/summary", asyncHandler(async (request, response) => {
  const id = requireParam(request, "id");
  const chat = await prisma.chat.findFirst({
    where: { id, deletedAt: null },
    include: { _count: { select: { messages: true } } }
  });
  if (!chat) throw new HttpError(404, "Chat not found");
  response.json({ ok: true, data: serializeChat(chat, chat._count.messages) });
}));

chatsRouter.get(
  "/:id",
  asyncHandler(async (request, response) => {
    const id = requireParam(request, "id");
    const chat = await prisma.chat.findFirst({
      where: { id, deletedAt: null },
      include: {
        messages: { orderBy: { createdAt: "asc" }, include: messageIncludeAttachments },
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

    const existing = await prisma.chat.findFirst({ where: { id, deletedAt: null } });
    if (!existing) {
      throw new HttpError(404, "Chat not found");
    }

    const chat = await prisma.$transaction(async (tx) => {
      const { userProfileSummary, ...ordinaryUpdates } = body;
      if (typeof userProfileSummary === "string") {
        await updateProfileSummaryInTransaction(tx, existing, userProfileSummary, "user", []);
      }
      return tx.chat.update({
        where: { id: existing.id },
        data: ordinaryUpdates,
        include: { _count: { select: { messages: true } } }
      });
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

    await prisma.$transaction(async (tx) => {
      await tx.chat.updateMany({
        where: { parentChatId: id },
        data: { parentChatId: null, branchSourceMessageId: null }
      });
      await tx.chat.delete({ where: { id } });
      await deleteUnreferencedAssets(tx);
    });
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
