import { randomUUID } from "node:crypto";
import { prisma } from "../db.js";
import { HttpError } from "../lib/http.js";
import { getOrCreateSettings } from "../routes/settings.js";
import { type ChatCompletionMessage } from "./completions.js";
import { executeReliableTextCompletion } from "./reliableModelCalls.js";
import { resolveModuleSettings } from "./moduleModels.js";

const MAX_TITLE_LENGTH = 80;
const MAX_CONTEXT_MESSAGES = 16;

export const normalizeChatTitleSuggestion = (value: string) =>
  value
    .trim()
    .replace(/^#{1,6}\s*/, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .slice(0, MAX_TITLE_LENGTH)
    .trim();

export const buildChatTitleSuggestionMessages = (
  messages: Array<{ role: string; content: string }>
): ChatCompletionMessage[] => [
  {
    role: "system",
    content: [
      "/no_think",
      "Generate a concise title for this local-first single-character roleplay chat.",
      "Use the conversation only. Do not introduce group chat, standalone lorebooks, or worldbooks.",
      "Return only the title, with no quotes, markdown, punctuation-only output, or explanation.",
      `Keep it under ${MAX_TITLE_LENGTH} characters.`
    ].join("\n")
  },
  ...messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice(-MAX_CONTEXT_MESSAGES)
    .map((message): ChatCompletionMessage => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content
    }))
];

export const createChatTitleSuggestion = async (chatId: string) => {
  const chat = await prisma.chat.findFirst({
    where: { id: chatId, deletedAt: null },
    include: {
      messages: {
        where: { contextIncluded: true },
        orderBy: { createdAt: "asc" }
      }
    }
  });

  if (!chat) {
    throw new HttpError(404, "Chat not found");
  }
  if (!chat.messages.length) {
    throw new HttpError(400, "A chat needs at least one included message before generating a title");
  }

  const settings = resolveModuleSettings(await getOrCreateSettings(), "chat");
  const messages = buildChatTitleSuggestionMessages(chat.messages);
  const title = normalizeChatTitleSuggestion(
    (await executeReliableTextCompletion({
      settings,
      messages,
      maxTokens: Math.min(settings.maxTokens, 80),
      temperature: Math.min(settings.temperature, 0.25),
      context: { requestId: `title_${randomUUID()}`, module: "chat", operation: "title", chatId }
    })).content
  );

  if (!title) {
    throw new Error("Model returned an empty title suggestion");
  }

  return { title, createdAt: new Date().toISOString() };
};
