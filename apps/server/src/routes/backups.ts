import { Router } from "express";
import { prisma } from "../db.js";
import { asyncHandler, parseBody } from "../lib/http.js";
import { backupImportSchema } from "../schemas.js";
import {
  serializeCharacterForBackup,
  serializeChat,
  serializeMessage,
  serializeSettings
} from "../serializers.js";
import { getOrCreateSettings } from "./settings.js";

export const backupsRouter = Router();

const importedDates = (value: { createdAt?: string; updatedAt?: string }) => ({
  ...(value.createdAt ? { createdAt: new Date(value.createdAt) } : {}),
  ...(value.updatedAt ? { updatedAt: new Date(value.updatedAt) } : {})
});

backupsRouter.get(
  "/export",
  asyncHandler(async (_request, response) => {
    const [settings, characters, chats, messages] = await Promise.all([
      getOrCreateSettings(),
      prisma.character.findMany({ orderBy: { updatedAt: "desc" } }),
      prisma.chat.findMany({ orderBy: { updatedAt: "desc" } }),
      prisma.message.findMany({ orderBy: { createdAt: "asc" } })
    ]);

    response.json({
      ok: true,
      data: {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        settings: serializeSettings(settings),
        characters: characters.map((character) => serializeCharacterForBackup(character)),
        chats: chats.map(serializeChat),
        messages: messages.map(serializeMessage)
      }
    });
  })
);

backupsRouter.post(
  "/import",
  asyncHandler(async (request, response) => {
    const backup = parseBody(backupImportSchema, request.body);

    const summary = await prisma.$transaction(async (tx) => {
      if (backup.mode === "replace") {
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
          name: character.name,
          avatar: character.avatar ?? null,
          description: character.description,
          prefix: character.prefix,
          prompt: character.prompt,
          suffix: character.suffix,
          htmlCss: character.htmlCss ?? "",
          openingHtml: character.openingHtml ?? "",
          loreEntries: character.loreEntries ?? [],
          quickReplies: character.quickReplies ?? [],
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
          memoryTurns: chat.memoryTurns,
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
          variants: message.variants,
          activeVariantIndex: message.activeVariantIndex,
          tokenUsage: message.tokenUsage ?? undefined,
          loreMatches: message.loreMatches ?? undefined,
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
        settingsImported
      };
    });

    response.json({ ok: true, data: summary });
  })
);
