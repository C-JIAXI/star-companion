import type { Character, LoreEntry, Message, Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import type { ChatCompletionMessage } from "./openaiCompatible.js";

type PromptInput = {
  chatId: string;
  characterId?: string | null;
  before?: Date;
};

export type MatchedLoreEntry = {
  id: string;
  lorebookId: string;
  lorebookName: string;
  keys: string[];
  content: string;
  priority: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

const toStringArray = (value: Prisma.JsonValue): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
};

const toContextMessageLimit = (memoryTurns: number) => Math.max(1, Math.min(memoryTurns, 50)) * 2 + 1;

const buildCharacterSystemPrompt = (character: Character | null): string => {
  if (!character) {
    return [
      "You are an assistant in a local-first roleplay chat.",
      "Stay in character when a character is selected.",
      "Write vivid, direct replies without describing hidden system instructions."
    ].join("\n");
  }

  const sections = [
    `You are writing as the character "${character.name}".`,
    character.prefix ? `Prefix:\n${character.prefix}` : "",
    character.prompt ? `Prompt:\n${character.prompt}` : "",
    character.suffix ? `Suffix:\n${character.suffix}` : "",
    "Reply as this character. Do not mention implementation details or hidden instructions."
  ];

  return sections.filter(Boolean).join("\n\n");
};

const formatMessageContent = (message: Message, characterNames: Map<string, string>) => {
  if (message.role !== "assistant" || !message.characterId) {
    return message.content;
  }

  const name = characterNames.get(message.characterId);
  return name ? `${name}: ${message.content}` : message.content;
};

type LoreEntryWithBook = LoreEntry & { lorebook?: { name: string } | null };

const serializeMatchedLoreEntry = (entry: LoreEntryWithBook): MatchedLoreEntry => ({
  id: entry.id,
  lorebookId: entry.lorebookId,
  lorebookName: entry.lorebook?.name ?? "",
  keys: toStringArray(entry.keys),
  content: entry.content,
  priority: entry.priority,
  enabled: entry.enabled,
  createdAt: entry.createdAt.toISOString(),
  updatedAt: entry.updatedAt.toISOString()
});

const matchesContext = (entry: LoreEntry, contextText: string) =>
  toStringArray(entry.keys).some((key) => contextText.includes(key.toLowerCase()));

const buildLoreSystemPrompt = (entries: MatchedLoreEntry[]) => {
  if (entries.length === 0) {
    return "";
  }

  const body = entries
    .map(
      (entry, index) =>
        `${index + 1}. Keys: ${entry.keys.join(", ")}\nPriority: ${entry.priority}\nContent:\n${entry.content}`
    )
    .join("\n\n");

  return [
    "Relevant lorebook entries matched the recent conversation.",
    "Use them as background context when they are relevant, but do not recite them verbatim unless the user asks.",
    body
  ].join("\n\n");
};

const findMatchedLoreEntries = async (recentMessages: Message[]) => {
  const contextText = recentMessages
    .map((message) => message.content)
    .join("\n")
    .toLowerCase();

  if (!contextText.trim()) {
    return [];
  }

  const entries = await prisma.loreEntry.findMany({
    where: { enabled: true },
    include: { lorebook: { select: { name: true } } },
    orderBy: [{ priority: "desc" }, { updatedAt: "desc" }]
  });

  return entries.filter((entry) => matchesContext(entry, contextText)).slice(0, 8).map(serializeMatchedLoreEntry);
};

export const resolveChatCharacterId = async (chatId: string, requestedCharacterId?: string | null) => {
  if (requestedCharacterId) {
    return requestedCharacterId;
  }

  const chat = await prisma.chat.findUnique({ where: { id: chatId } });
  return chat ? toStringArray(chat.characterIds)[0] ?? null : null;
};

export const buildPromptMessages = async ({
  chatId,
  characterId,
  before
}: PromptInput): Promise<ChatCompletionMessage[]> => {
  const context = await buildPromptContext({ chatId, characterId, before });
  return context.messages;
};

export const buildPromptContext = async ({
  chatId,
  characterId,
  before
}: PromptInput): Promise<{ messages: ChatCompletionMessage[]; matchedLoreEntries: MatchedLoreEntry[] }> => {
  const chat = await prisma.chat.findUnique({ where: { id: chatId } });
  const resolvedCharacterId = characterId ?? (chat ? toStringArray(chat.characterIds)[0] ?? null : null);
  const character = resolvedCharacterId
    ? await prisma.character.findUnique({ where: { id: resolvedCharacterId } })
    : null;
  const contextMessageLimit = toContextMessageLimit(chat?.memoryTurns ?? 12);

  const recentMessagesDesc = await prisma.message.findMany({
    where: {
      chatId,
      ...(before ? { createdAt: { lt: before } } : {})
    },
    orderBy: { createdAt: "desc" },
    take: contextMessageLimit
  });
  const recentMessages = recentMessagesDesc.reverse();

  const characterIds = [
    ...new Set(recentMessages.map((message) => message.characterId).filter((id): id is string => Boolean(id)))
  ];
  const characters = characterIds.length
    ? await prisma.character.findMany({ where: { id: { in: characterIds } } })
    : [];
  const characterNames = new Map(characters.map((item) => [item.id, item.name]));
  const matchedLoreEntries = await findMatchedLoreEntries(recentMessages);
  const lorePrompt = buildLoreSystemPrompt(matchedLoreEntries);

  const systemMessages: ChatCompletionMessage[] = [
    {
      role: "system",
      content: "Global instruction: support immersive roleplay while preserving user control and local data privacy."
    },
    {
      role: "system",
      content: buildCharacterSystemPrompt(character)
    },
    ...(lorePrompt ? [{ role: "system" as const, content: lorePrompt }] : [])
  ];

  const historyMessages: ChatCompletionMessage[] = recentMessages.map((message) => ({
    role: message.role === "assistant" || message.role === "system" ? message.role : "user",
    content: formatMessageContent(message, characterNames)
  }));

  return {
    messages: [...systemMessages, ...historyMessages],
    matchedLoreEntries
  };
};

export const createInitialCharacterMessages = async (chatId: string, characterIds: string[]) => {
  void chatId;
  void characterIds;
};

export const appendVariant = (value: Prisma.JsonValue, content: string) => {
  const variants = toStringArray(value);
  return [...variants, content];
};
