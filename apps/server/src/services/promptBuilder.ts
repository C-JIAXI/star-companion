import type { Character, Message, Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import type { ChatCompletionMessage } from "./completions.js";
import { resolveCharacterPromptFields } from "./characterCards.js";
import { getUserCustomConfigSegments } from "./userCustomConfig.js";

type PromptInput = {
  chatId: string;
  characterId?: string | null;
  before?: Date;
  excludeMessageIds?: string[];
};

type LoreTriggerMode = "user" | "assistant" | "both";
type LoreEntryScope = "prefix" | "prompt" | "suffix";

export type MatchedLoreEntry = {
  id: string;
  characterId: string;
  characterName: string;
  keys: string[];
  content: string;
  priority: number;
  scope: LoreEntryScope;
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

const normalizeLoreScope = (value: string | null | undefined): LoreEntryScope => {
  if (value === "prefix" || value === "suffix") {
    return value;
  }
  return "prompt";
};

const resolvePromptCharacterId = (chat: { characterId: string | null } | null, requestedCharacterId?: string | null) => {
  if (!chat) {
    return requestedCharacterId ?? null;
  }

  if (requestedCharacterId && requestedCharacterId === chat.characterId) {
    return requestedCharacterId;
  }

  return chat.characterId;
};

const buildCharacterSystemPrompt = (
  character: Character | null,
  loreEntries: MatchedLoreEntry[] = []
): string => {
  if (!character) {
    return "";
  }

  const promptFields = resolveCharacterPromptFields(character);
  const prefixLore = loreEntries.filter((e) => e.scope === "prefix");
  const promptLore = loreEntries.filter((e) => e.scope === "prompt");
  const suffixLore = loreEntries.filter((e) => e.scope === "suffix");
  const loreContents = (entries: MatchedLoreEntry[]) =>
    entries.map((e) => e.content.trim()).filter(Boolean).join("\n\n");

  return [
    [promptFields.prefix.trim(), loreContents(prefixLore)].filter(Boolean).join("\n\n"),
    [promptFields.prompt.trim(), loreContents(promptLore)].filter(Boolean).join("\n\n"),
    [promptFields.suffix.trim(), loreContents(suffixLore)].filter(Boolean).join("\n\n")
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

const findMatchedLoreEntries = (
  characterLoreEntries: Array<{
    id: string;
    keys: string[];
    content: string;
    priority: number;
    scope?: string;
    triggerMode: string;
    alwaysActive: boolean;
    enabled: boolean;
  }>,
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
      scope: normalizeLoreScope(entry.scope),
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

  const speakerCharacterIds = [
    ...new Set(
      recentMessages.map((message) => message.characterId).filter((id): id is string => Boolean(id))
    )
  ];
  const characters = speakerCharacterIds.length
    ? await prisma.character.findMany({ where: { id: { in: speakerCharacterIds } } })
    : [];
  const characterNames = new Map(characters.map((item) => [item.id, item.name]));
  const promptFields = character ? resolveCharacterPromptFields(character) : null;

  const matchedLoreEntries = findMatchedLoreEntries(
    promptFields?.loreEntries ?? [],
    recentMessages,
    character?.name ?? ""
  );
  const userCustomConfigSegments = getUserCustomConfigSegments(chat?.userPersona);

  const systemMessages: ChatCompletionMessage[] = [
    buildCharacterSystemPrompt(character, matchedLoreEntries),
    ...userCustomConfigSegments,
    chat?.userProfileSummary.trim() ?? ""
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
