import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { HttpError } from "../lib/http.js";
import { serializeCharacterForBackup, serializeChat, serializeChatMemory, serializeMemoryOperationForBackup, serializeMemoryRevisionForBackup, serializeMessage, serializeProfileSummaryRevisionForBackup } from "../serializers.js";
import type { z } from "zod";
import type { chatArchiveImportSchema } from "../schemas.js";

type ChatArchiveImportInput = z.infer<typeof chatArchiveImportSchema>;

export const exportChatArchive = async (chatId: string) => {
  const [chat, memoryRevisions, memoryOperations, profileSummaryRevisions] = await Promise.all([prisma.chat.findFirst({
    where: { id: chatId, deletedAt: null },
    include: {
      character: true,
      messages: { orderBy: { createdAt: "asc" } },
      memories: { orderBy: [{ enabled: "desc" }, { importance: "desc" }, { updatedAt: "desc" }] }
    }
  }), prisma.memoryRevision.findMany({ where: { chatId }, orderBy: { createdAt: "asc" } }), prisma.memoryOperation.findMany({ where: { chatId }, orderBy: { startedAt: "asc" } }), prisma.profileSummaryRevision.findMany({ where: { chatId }, orderBy: { createdAt: "asc" } })]);
  if (!chat) throw new HttpError(404, "Chat not found");

  return {
    archiveVersion: 1 as const,
    exportedAt: new Date().toISOString(),
    chat: serializeChat(chat, chat.messages.length),
    character: chat.character ? serializeCharacterForBackup(chat.character) : null,
    messages: chat.messages.map(serializeMessage),
    memories: chat.memories.map(serializeChatMemory),
    memoryRevisions: memoryRevisions.map(serializeMemoryRevisionForBackup),
    memoryOperations: memoryOperations.map(serializeMemoryOperationForBackup),
    profileSummaryRevisions: profileSummaryRevisions.map(serializeProfileSummaryRevisionForBackup)
  };
};

export const importChatArchive = async ({ archive, title }: ChatArchiveImportInput) =>
  prisma.$transaction(async (tx) => {
    let characterId: string | null = null;
    if (archive.character) {
      const existing = await tx.character.findUnique({
        where: { cardId: archive.character.cardId },
        select: { id: true }
      });
      if (existing) {
        characterId = existing.id;
      } else {
        const character = await tx.character.create({
          data: {
            cardId: archive.character.cardId,
            name: archive.character.name,
            avatar: archive.character.avatar ?? null,
            description: archive.character.description,
            tags: archive.character.tags,
            prefix: archive.character.prefix,
            prompt: archive.character.prompt,
            suffix: archive.character.suffix,
            htmlCss: archive.character.htmlCss,
            openingHtml: archive.character.openingHtml,
            loreEntries: archive.character.loreEntries as Prisma.InputJsonValue,
            quickReplies: archive.character.quickReplies as Prisma.InputJsonValue
          }
        });
        characterId = character.id;
      }
    }

    const chat = await tx.chat.create({
      data: {
        title: title ?? archive.chat.title,
        characterId,
        isCheckpoint: archive.chat.isCheckpoint,
        folder: archive.chat.folder,
        backgroundUrl: archive.chat.backgroundUrl,
        memoryTurns: archive.chat.memoryTurns,
        autoMemoryEnabled: archive.chat.autoMemoryEnabled,
        userPersona: archive.chat.userPersona,
        userAvatar: archive.chat.userAvatar ?? "",
        userProfileSummary: archive.chat.userProfileSummary
        ,profileRevision: archive.profileSummaryRevisions.length ? archive.chat.profileRevision : archive.chat.userProfileSummary ? 1 : 0
      }
    });

    const messageIds = new Map<string, string>();
    for (const source of archive.messages) {
      const message = await tx.message.create({
        data: {
          chatId: chat.id,
          role: source.role,
          characterId: source.characterId ? characterId : null,
          content: source.content,
          contextIncluded: source.contextIncluded,
          isBookmarked: source.isBookmarked,
          variants: source.variants as Prisma.InputJsonValue,
          activeVariantIndex: source.activeVariantIndex,
          tokenUsage: source.tokenUsage === null ? Prisma.JsonNull : (source.tokenUsage as Prisma.InputJsonValue),
          generationMetadata: source.generationMetadata === null ? Prisma.JsonNull : (source.generationMetadata as Prisma.InputJsonValue),
          variantMetadata: source.variantMetadata as Prisma.InputJsonValue,
          promptBreakdown: source.promptBreakdown === null ? Prisma.JsonNull : (source.promptBreakdown as Prisma.InputJsonValue),
          loreMatches: source.loreMatches === null ? Prisma.JsonNull : (source.loreMatches as Prisma.InputJsonValue),
          memoryMatches: source.memoryMatches === null ? Prisma.JsonNull : (source.memoryMatches as Prisma.InputJsonValue),
          ...(source.createdAt ? { createdAt: new Date(source.createdAt) } : {}),
          ...(source.updatedAt ? { updatedAt: new Date(source.updatedAt) } : {})
        }
      });
      if (source.id) {
        messageIds.set(source.id, message.id);
      }
    }

    const memoryIds = new Map<string, string>();
    for (const source of archive.memories) {
      const hasHistory = archive.memoryRevisions.some((revision) => revision.memoryId === source.id);
      const memory = await tx.chatMemory.create({
        data: {
          chatId: chat.id,
          title: source.title,
          content: source.content,
          keywords: source.keywords,
          importance: source.importance,
          enabled: source.enabled,
          deletedAt: source.deletedAt ? new Date(source.deletedAt) : null,
          currentRevision: hasHistory ? source.currentRevision : 1,
          lastActor: hasHistory ? source.lastActor : "restore",
          lastAction: hasHistory ? source.lastAction : "baseline",
          sourceMessageIds: source.sourceMessageIds
            .map((sourceId) => messageIds.get(sourceId))
            .filter((id): id is string => Boolean(id)),
          lastMatchedAt: source.lastMatchedAt ? new Date(source.lastMatchedAt) : null
        }
      });
      if (source.id) memoryIds.set(source.id, memory.id);
      if (!hasHistory) {
        await tx.memoryRevision.create({ data: {
          memoryId: memory.id, chatId: chat.id, revision: 1, action: "baseline", actor: "restore",
          beforeSnapshot: Prisma.JsonNull,
          afterSnapshot: { title: memory.title, content: memory.content, keywords: memory.keywords, importance: memory.importance, enabled: memory.enabled, sourceMessageIds: memory.sourceMessageIds } as Prisma.InputJsonValue,
          sourceMessageIds: memory.sourceMessageIds as Prisma.InputJsonValue,
          reasonCode: "legacy_archive_baseline", createdAt: memory.createdAt
        } });
      }
    }

    const operationIds = new Map<string, string>();
    for (const source of archive.memoryOperations) {
      const operation = await tx.memoryOperation.create({ data: {
        chatId: chat.id, type: source.type, actor: source.actor, status: source.status,
        startedAt: new Date(source.startedAt), completedAt: source.completedAt ? new Date(source.completedAt) : null,
        createdCount: source.created, updatedCount: source.updated, disabledCount: source.disabled, unchangedCount: source.unchanged,
        sourceMessageIds: source.sourceMessageIds.map((id) => messageIds.get(id)).filter((id): id is string => Boolean(id)),
        errorCode: source.errorCode, undoneAt: source.undoneAt ? new Date(source.undoneAt) : null
      } });
      operationIds.set(source.id, operation.id);
    }
    for (const source of archive.memoryOperations) {
      if (!source.undoOperationId) continue;
      const id = operationIds.get(source.id);
      const undoOperationId = operationIds.get(source.undoOperationId);
      if (id && undoOperationId) await tx.memoryOperation.update({ where: { id }, data: { undoOperationId } });
    }
    for (const source of archive.memoryRevisions) {
      const memoryId = memoryIds.get(source.memoryId);
      if (!memoryId) continue;
      const remapSnapshot = (snapshot: typeof source.beforeSnapshot) => snapshot ? { ...snapshot, sourceMessageIds: snapshot.sourceMessageIds.map((id) => messageIds.get(id)).filter((id): id is string => Boolean(id)) } : null;
      await tx.memoryRevision.create({ data: {
        memoryId, chatId: chat.id, revision: source.revision, action: source.action, actor: source.actor,
        beforeSnapshot: remapSnapshot(source.beforeSnapshot) ?? Prisma.JsonNull,
        afterSnapshot: remapSnapshot(source.afterSnapshot) ?? Prisma.JsonNull,
        sourceMessageIds: source.sourceMessageIds.map((id) => messageIds.get(id)).filter((id): id is string => Boolean(id)),
        operationId: source.operationId ? operationIds.get(source.operationId) ?? null : null,
        reasonCode: source.reasonCode, createdAt: new Date(source.createdAt)
      } });
    }
    if (archive.profileSummaryRevisions.length) {
      for (const source of archive.profileSummaryRevisions) {
        await tx.profileSummaryRevision.create({ data: {
          chatId: chat.id, revision: source.revision, action: source.action, actor: source.actor, summary: source.summary,
          sourceMessageIds: source.sourceMessageIds.map((id) => messageIds.get(id)).filter((id): id is string => Boolean(id)), createdAt: new Date(source.createdAt)
        } });
      }
    } else if (archive.chat.userProfileSummary) {
      await tx.profileSummaryRevision.create({ data: { chatId: chat.id, revision: 1, action: "baseline", actor: "restore", summary: archive.chat.userProfileSummary, sourceMessageIds: [], createdAt: chat.createdAt } });
    }

    const imported = await tx.chat.findUniqueOrThrow({
      where: { id: chat.id },
      include: {
        messages: { orderBy: { createdAt: "asc" } },
        memories: { orderBy: [{ enabled: "desc" }, { importance: "desc" }, { updatedAt: "desc" }] }
      }
    });
    return {
      ...serializeChat(imported, imported.messages.length),
      messages: imported.messages.map(serializeMessage),
      memories: imported.memories.map(serializeChatMemory)
    };
  });
