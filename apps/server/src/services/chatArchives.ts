import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { HttpError } from "../lib/http.js";
import { serializeCharacterForBackup, serializeChat, serializeChatMemory, serializeMessage } from "../serializers.js";
import type { z } from "zod";
import type { chatArchiveImportSchema } from "../schemas.js";

type ChatArchiveImportInput = z.infer<typeof chatArchiveImportSchema>;

export const exportChatArchive = async (chatId: string) => {
  const chat = await prisma.chat.findFirst({
    where: { id: chatId, deletedAt: null },
    include: {
      character: true,
      messages: { orderBy: { createdAt: "asc" } },
      memories: { orderBy: [{ enabled: "desc" }, { importance: "desc" }, { updatedAt: "desc" }] }
    }
  });
  if (!chat) throw new HttpError(404, "Chat not found");

  return {
    archiveVersion: 1 as const,
    exportedAt: new Date().toISOString(),
    chat: serializeChat(chat, chat.messages.length),
    character: chat.character ? serializeCharacterForBackup(chat.character) : null,
    messages: chat.messages.map(serializeMessage),
    memories: chat.memories.map(serializeChatMemory)
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
        backgroundUrl: archive.chat.backgroundUrl,
        memoryTurns: archive.chat.memoryTurns,
        autoMemoryEnabled: archive.chat.autoMemoryEnabled,
        userPersona: archive.chat.userPersona,
        userProfileSummary: archive.chat.userProfileSummary
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

    for (const source of archive.memories) {
      await tx.chatMemory.create({
        data: {
          chatId: chat.id,
          title: source.title,
          content: source.content,
          keywords: source.keywords,
          importance: source.importance,
          enabled: source.enabled,
          sourceMessageIds: source.sourceMessageIds
            .map((sourceId) => messageIds.get(sourceId))
            .filter((id): id is string => Boolean(id)),
          lastMatchedAt: source.lastMatchedAt ? new Date(source.lastMatchedAt) : null
        }
      });
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
