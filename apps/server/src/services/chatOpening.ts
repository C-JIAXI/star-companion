import { prisma } from "../db.js";
import { HttpError } from "../lib/http.js";
import { serializeMessage } from "../serializers.js";
import { getOrCreateSettings } from "../routes/settings.js";
import {
  completeChatCompletion,
  estimateTokenUsage,
  type ChatCompletionMessage
} from "./completions.js";
import { resolveModuleSettings } from "./moduleModels.js";
import { buildPromptContext } from "./promptBuilder.js";

const openingInstruction: ChatCompletionMessage = {
  role: "user",
  content: [
    "/no_think",
    "Write the first in-character assistant message for this empty single-character roleplay chat.",
    "Start the scene naturally and give the user something concrete to respond to.",
    "Do not speak as the user. Do not introduce group chat, standalone lorebooks, or out-of-character setup instructions.",
    "Return only the message content."
  ].join("\n")
};

export const createChatOpeningMessage = async (chatId: string) => {
  const chat = await prisma.chat.findFirst({
    where: { id: chatId, deletedAt: null },
    include: {
      _count: { select: { messages: true } }
    }
  });

  if (!chat) {
    throw new HttpError(404, "Chat not found");
  }

  if (!chat.characterId) {
    throw new HttpError(400, "Chat must be bound to a character before generating an opening message");
  }

  if (chat._count.messages > 0) {
    throw new HttpError(409, "Opening message can only be generated for an empty chat");
  }

  const settings = resolveModuleSettings(await getOrCreateSettings(), "chat");
  const context = await buildPromptContext({ chatId, settings });
  const messages = [...context.messages, openingInstruction];
  const content = (
    await completeChatCompletion({
      settings,
      messages,
      maxTokens: Math.min(settings.maxTokens, 700),
      temperature: Math.min(settings.temperature, 0.7)
    })
  ).trim();

  if (!content) {
    throw new Error("Model returned an empty opening message");
  }

  const tokenUsage = estimateTokenUsage(messages, content);
  const message = await prisma.message.create({
    data: {
      chatId,
      role: "assistant",
      characterId: chat.characterId,
      content,
      variants: [content],
      activeVariantIndex: 0,
      tokenUsage,
      loreMatches: context.matchedLoreEntries,
      memoryMatches: context.matchedMemoryEntries
    }
  });

  await prisma.chat.update({
    where: { id: chatId },
    data: { updatedAt: new Date() }
  });

  return serializeMessage(message);
};
