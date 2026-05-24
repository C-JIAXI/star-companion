import type { Character, Message, Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import type { ChatCompletionMessage } from "./completions.js";

type PromptInput = {
  chatId: string;
  characterId?: string | null;
  before?: Date;
  excludeMessageIds?: string[];
};

type LoreTriggerMode = "user" | "assistant" | "both";

export type MatchedLoreEntry = {
  id: string;
  characterId: string;
  characterName: string;
  keys: string[];
  content: string;
  priority: number;
  triggerMode: LoreTriggerMode;
  alwaysActive: boolean;
  enabled: boolean;
};

const toStringArray = (value: Prisma.JsonValue): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
};

const toContextMessageLimit = (memoryTurns: number) =>
  Math.max(1, Math.min(memoryTurns, 50)) * 2 + 1;

const normalizeLoreTriggerMode = (value: string | null | undefined): LoreTriggerMode => {
  if (value === "user" || value === "assistant") {
    return value;
  }

  return "both";
};

const resolvePromptCharacterId = (
  chat: { characterIds: Prisma.JsonValue } | null,
  requestedCharacterId?: string | null
) => {
  if (!chat) {
    return requestedCharacterId ?? null;
  }

  const chatCharacterIds = toStringArray(chat.characterIds);
  if (requestedCharacterId && chatCharacterIds.includes(requestedCharacterId)) {
    return requestedCharacterId;
  }

  return chatCharacterIds[0] ?? null;
};

const buildCharacterSystemPrompt = (character: Character | null): string => {
  if (!character) {
    return "";
  }

  return [
    character.prefix.trim(),
    character.prompt.trim(),
    character.suffix.trim(),
    character.htmlCss.trim()
  ]
    .filter(Boolean)
    .join("\n\n");
};

const formatMessageContent = (message: Message, characterNames: Map<string, string>) => {
  if (message.role !== "assistant" || !message.characterId) {
    return message.content;
  }

  const name = characterNames.get(message.characterId);
  return name ? `${name}: ${message.content}` : message.content;
};

type CharacterLoreEntry = {
  id: string;
  keys: string[];
  content: string;
  priority: number;
  triggerMode: string | null;
  alwaysActive: boolean;
  enabled: boolean;
};

const toLoreEntries = (value: Prisma.JsonValue) => {
  if (!Array.isArray(value)) {
    return [] as CharacterLoreEntry[];
  }

  return value
    .map((item): CharacterLoreEntry | null => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }

      const entry = item as Record<string, unknown>;
      const id = entry.id;
      const keys = entry.keys;
      const content = entry.content;
      const priority = entry.priority;

      if (
        typeof id !== "string" ||
        !Array.isArray(keys) ||
        typeof content !== "string" ||
        typeof priority !== "number"
      ) {
        return null;
      }

      return {
        id,
        keys: keys.filter((key): key is string => typeof key === "string"),
        content,
        priority,
        triggerMode: typeof entry.triggerMode === "string" ? entry.triggerMode : null,
        alwaysActive: entry.alwaysActive === true,
        enabled: entry.enabled !== false
      };
    })
    .filter((entry): entry is CharacterLoreEntry => entry !== null);
};

const matchesContext = (keys: string[], contextText: string) =>
  keys.some((key) => contextText.includes(key.toLowerCase()));

const buildLoreContexts = (recentMessages: Message[]) => {
  const messageText = (roles: Array<Message["role"]>) =>
    recentMessages
      .filter((message) => roles.includes(message.role))
      .map((message) => message.content)
      .join("\n")
      .toLowerCase();

  return {
    user: messageText(["user"]),
    assistant: messageText(["assistant"]),
    both: messageText(["user", "assistant"])
  } satisfies Record<LoreTriggerMode, string>;
};

const buildLoreSystemPrompt = (entries: MatchedLoreEntry[]) => {
  if (entries.length === 0) {
    return "";
  }

  return entries.map((entry) => entry.content.trim()).filter(Boolean).join("\n\n");
};

const findMatchedLoreEntries = (
  characterLoreEntries: CharacterLoreEntry[],
  recentMessages: Message[],
  characterName: string
): MatchedLoreEntry[] => {
  if (characterLoreEntries.length === 0) {
    return [];
  }

  const contexts = buildLoreContexts(recentMessages);

  if (!Object.values(contexts).some((contextText) => contextText.trim())) {
    return [];
  }

  const entries = characterLoreEntries.filter((entry) => entry.enabled);

  return entries
    .filter((entry) => {
      if (entry.alwaysActive) {
        return true;
      }

      const triggerMode = normalizeLoreTriggerMode(entry.triggerMode);
      return matchesContext(entry.keys, contexts[triggerMode]);
    })
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 8)
    .map((entry) => ({
      id: entry.id,
      characterId: "",
      characterName,
      keys: entry.keys,
      content: entry.content,
      priority: entry.priority,
      triggerMode: normalizeLoreTriggerMode(entry.triggerMode),
      alwaysActive: entry.alwaysActive,
      enabled: entry.enabled
    }));
};

export const resolveChatCharacterId = async (
  chatId: string,
  requestedCharacterId?: string | null
) => {
  const chat = await prisma.chat.findUnique({ where: { id: chatId } });
  return resolvePromptCharacterId(chat, requestedCharacterId);
};

export const buildPromptMessages = async ({
  chatId,
  characterId,
  before,
  excludeMessageIds
}: PromptInput): Promise<ChatCompletionMessage[]> => {
  const context = await buildPromptContext({ chatId, characterId, before, excludeMessageIds });
  return context.messages;
};

export const buildPromptContext = async ({
  chatId,
  characterId,
  before,
  excludeMessageIds
}: PromptInput): Promise<{
  messages: ChatCompletionMessage[];
  matchedLoreEntries: MatchedLoreEntry[];
}> => {
  const chat = await prisma.chat.findUnique({ where: { id: chatId } });
  const resolvedCharacterId = resolvePromptCharacterId(chat, characterId);
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
  let recentMessages = recentMessagesDesc.reverse();
  if (excludeMessageIds?.length) {
    recentMessages = recentMessages.filter((m) => !excludeMessageIds.includes(m.id));
  }

  const characterIds = [
    ...new Set(
      recentMessages.map((message) => message.characterId).filter((id): id is string => Boolean(id))
    )
  ];
  const characters = characterIds.length
    ? await prisma.character.findMany({ where: { id: { in: characterIds } } })
    : [];
  const characterNames = new Map(characters.map((item) => [item.id, item.name]));

  const matchedLoreEntries = findMatchedLoreEntries(
    toLoreEntries(character?.loreEntries ?? []),
    recentMessages,
    character?.name ?? ""
  );
  const lorePrompt = buildLoreSystemPrompt(matchedLoreEntries);

  const systemMessages: ChatCompletionMessage[] = [
    buildCharacterSystemPrompt(character),
    chat?.userPersona.trim() ?? "",
    chat?.userProfileSummary.trim() ?? "",
    lorePrompt
  ]
    .filter(Boolean)
    .map((content) => ({
      role: "system" as const,
      content
    }));

  const historyMessages: ChatCompletionMessage[] = recentMessages.map((message) => ({
    role: message.role === "assistant" || message.role === "system" ? message.role : "user",
    content: formatMessageContent(message, characterNames)
  }));

  return {
    messages: [...systemMessages, ...historyMessages],
    matchedLoreEntries
  };
};

export const appendVariant = (value: Prisma.JsonValue, content: string) => {
  const variants = toStringArray(value);
  return [...variants, content];
};
