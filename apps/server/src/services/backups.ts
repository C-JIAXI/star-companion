import { prisma } from "../db.js";
import {
  serializeCharacterForBackup,
  serializeChat,
  serializeChatMemory,
  serializeMessage,
  serializeSettings
} from "../serializers.js";
import { getOrCreateSettings } from "../routes/settings.js";
import type { z } from "zod";
import type { backupImportSchema } from "../schemas.js";

type BackupImportData = z.infer<typeof backupImportSchema>;
type ExportedBackup = {
  schemaVersion: 1;
  exportedAt: string;
  settings: unknown;
  characters: unknown[];
  chats: unknown[];
  messages: unknown[];
  memories: unknown[];
};

const importedDates = (value: { createdAt?: string; updatedAt?: string }) => ({
  ...(value.createdAt ? { createdAt: new Date(value.createdAt) } : {}),
  ...(value.updatedAt ? { updatedAt: new Date(value.updatedAt) } : {})
});

export const exportBackup = async (): Promise<ExportedBackup> => {
  const [settings, characters, chats, messages, memories] = await Promise.all([
    getOrCreateSettings(),
    prisma.character.findMany({ orderBy: { updatedAt: "desc" } }),
    prisma.chat.findMany({ orderBy: { updatedAt: "desc" } }),
    prisma.message.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.chatMemory.findMany({ orderBy: { updatedAt: "desc" } })
  ]);

  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    settings: serializeSettings(settings),
    characters: characters.map((character) => serializeCharacterForBackup(character)),
    chats: chats.map(serializeChat),
    messages: messages.map(serializeMessage),
    memories: memories.map(serializeChatMemory)
  };
};

export const importBackup = async (backup: BackupImportData) =>
  prisma.$transaction(async (tx) => {
    if (backup.mode === "replace") {
      await tx.chatMemory.deleteMany();
      await tx.message.deleteMany();
      await tx.chat.deleteMany();
      await tx.character.deleteMany();
    }

    const existingSettings = await tx.userSettings.findFirst({
      orderBy: { createdAt: "asc" }
    });

    let settingsImported = false;
    if (backup.settings) {
      if (existingSettings) {
        await tx.userSettings.update({
          where: { id: existingSettings.id },
          data: backup.settings
        });
      } else {
        await tx.userSettings.create({ data: backup.settings });
      }
      settingsImported = true;
    }

    for (const character of backup.characters) {
      const data = {
        cardId: character.cardId,
        name: character.name,
        avatar: character.avatar ?? null,
        description: character.description,
        tags: character.tags,
        prefix: character.prefix,
        prompt: character.prompt,
        suffix: character.suffix,
        htmlCss: character.htmlCss ?? "",
        openingHtml: character.openingHtml ?? "",
        loreEntries: character.loreEntries ?? [],
        quickReplies: character.quickReplies ?? [],
        isFavorite: character.isFavorite,
        ...importedDates(character)
      };

      if (character.id) {
        await tx.character.upsert({
          where: { id: character.id },
          update: data,
          create: { id: character.id, ...data }
        });
      } else {
        await tx.character.create({ data });
      }
    }

    for (const chat of backup.chats) {
      const characterExists = chat.characterId
        ? await tx.character.findUnique({
            where: { id: chat.characterId },
            select: { id: true }
          })
        : null;

      const data = {
        title: chat.title,
        characterId: characterExists?.id ?? null,
        parentChatId: chat.parentChatId ?? null,
        branchSourceMessageId: chat.branchSourceMessageId ?? null,
        isCheckpoint: chat.isCheckpoint,
        isPinned: chat.isPinned,
        isArchived: chat.isArchived,
        folder: chat.folder,
        deletedAt: chat.deletedAt ? new Date(chat.deletedAt) : null,
        backgroundUrl: chat.backgroundUrl,
        memoryTurns: chat.memoryTurns,
        autoMemoryEnabled: chat.autoMemoryEnabled,
        userPersona: chat.userPersona,
        userProfileSummary: chat.userProfileSummary,
        ...importedDates(chat)
      };

      if (chat.id) {
        await tx.chat.upsert({
          where: { id: chat.id },
          update: data,
          create: { id: chat.id, ...data }
        });
      } else {
        await tx.chat.create({ data });
      }
    }

    let importedMemories = 0;
    for (const memory of backup.memories) {
      const chatExists = await tx.chat.findUnique({
        where: { id: memory.chatId },
        select: { id: true }
      });

      if (!chatExists) {
        continue;
      }

      const data = {
        chatId: memory.chatId,
        title: memory.title,
        content: memory.content,
        keywords: memory.keywords,
        importance: memory.importance,
        enabled: memory.enabled,
        sourceMessageIds: memory.sourceMessageIds,
        lastMatchedAt: memory.lastMatchedAt ? new Date(memory.lastMatchedAt) : null,
        ...importedDates(memory)
      };

      if (memory.id) {
        await tx.chatMemory.upsert({
          where: { id: memory.id },
          update: data,
          create: { id: memory.id, ...data }
        });
      } else {
        await tx.chatMemory.create({ data });
      }
      importedMemories += 1;
    }

    let importedMessages = 0;
    for (const message of backup.messages) {
      const chatExists = await tx.chat.findUnique({
        where: { id: message.chatId },
        select: { id: true }
      });

      if (!chatExists) {
        continue;
      }

      const characterExists = message.characterId
        ? await tx.character.findUnique({
            where: { id: message.characterId },
            select: { id: true }
          })
        : null;

      const data = {
        chatId: message.chatId,
        role: message.role,
        characterId: characterExists?.id ?? null,
        content: message.content,
        contextIncluded: message.contextIncluded,
        isBookmarked: message.isBookmarked,
        variants: message.variants,
        activeVariantIndex: message.activeVariantIndex,
        tokenUsage: message.tokenUsage ?? undefined,
        loreMatches: message.loreMatches ?? undefined,
        memoryMatches: message.memoryMatches ?? undefined,
        ...importedDates(message)
      };

      if (message.id) {
        await tx.message.upsert({
          where: { id: message.id },
          update: data,
          create: { id: message.id, ...data }
        });
      } else {
        await tx.message.create({ data });
      }
      importedMessages += 1;
    }

    return {
      mode: backup.mode,
      characters: backup.characters.length,
      chats: backup.chats.length,
      messages: importedMessages,
      memories: importedMemories,
      settingsImported
    };
  });
