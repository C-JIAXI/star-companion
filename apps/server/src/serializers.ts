import type {
  Character,
  Chat,
  LoreEntry,
  Lorebook,
  Message,
  Prisma,
  UserSettings
} from "@prisma/client";

type LorebookWithEntries = Lorebook & { entries?: LoreEntry[] };

const toIso = (date: Date) => date.toISOString();

const toStringArray = (value: Prisma.JsonValue): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
};

const toTokenUsage = (value: Prisma.JsonValue | null) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const usage = value as Record<string, unknown>;
  const promptTokens = usage.promptTokens;
  const completionTokens = usage.completionTokens;
  const totalTokens = usage.totalTokens;

  if (
    typeof promptTokens !== "number" ||
    typeof completionTokens !== "number" ||
    typeof totalTokens !== "number"
  ) {
    return null;
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    estimated: usage.estimated === true
  };
};

const toLoreMatches = (value: Prisma.JsonValue | null) => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }

      const entry = item as Record<string, unknown>;
      const id = entry.id;
      const lorebookId = entry.lorebookId;
      const keys = entry.keys;
      const content = entry.content;
      const priority = entry.priority;
      const enabled = entry.enabled;
      const createdAt = entry.createdAt;
      const updatedAt = entry.updatedAt;

      if (
        typeof id !== "string" ||
        typeof lorebookId !== "string" ||
        !Array.isArray(keys) ||
        typeof content !== "string" ||
        typeof priority !== "number" ||
        typeof enabled !== "boolean" ||
        typeof createdAt !== "string" ||
        typeof updatedAt !== "string"
      ) {
        return null;
      }

      return {
        id,
        lorebookId,
        lorebookName: typeof entry.lorebookName === "string" ? entry.lorebookName : undefined,
        keys: keys.filter((key): key is string => typeof key === "string"),
        content,
        priority,
        enabled,
        createdAt,
        updatedAt
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
};

export const serializeSettings = (settings: UserSettings) => ({
  id: settings.id,
  activeProvider: settings.activeProvider,
  apiBaseUrl: settings.apiBaseUrl,
  model: settings.model,
  temperature: settings.temperature,
  maxTokens: settings.maxTokens,
  topP: settings.topP,
  language: settings.language === "en" ? "en" : "zh-CN",
  createdAt: toIso(settings.createdAt),
  updatedAt: toIso(settings.updatedAt)
});

export const serializeCharacter = (character: Character) => ({
  id: character.id,
  name: character.name,
  avatar: character.avatar,
  description: character.description,
  personality: character.personality,
  scenario: character.scenario,
  firstMessage: character.firstMessage,
  exampleDialog: character.exampleDialog,
  systemPrompt: character.systemPrompt,
  tags: toStringArray(character.tags),
  createdAt: toIso(character.createdAt),
  updatedAt: toIso(character.updatedAt)
});

export const serializeChat = (chat: Chat) => ({
  id: chat.id,
  title: chat.title,
  mode: chat.mode === "group" ? "group" : "single",
  characterIds: toStringArray(chat.characterIds),
  createdAt: toIso(chat.createdAt),
  updatedAt: toIso(chat.updatedAt)
});

export const serializeMessage = (message: Message) => ({
  id: message.id,
  chatId: message.chatId,
  role: message.role === "assistant" || message.role === "system" ? message.role : "user",
  characterId: message.characterId,
  content: message.content,
  variants: toStringArray(message.variants),
  activeVariantIndex: message.activeVariantIndex,
  tokenUsage: toTokenUsage(message.tokenUsage),
  loreMatches: toLoreMatches(message.loreMatches),
  createdAt: toIso(message.createdAt),
  updatedAt: toIso(message.updatedAt)
});

export const serializeLorebook = (lorebook: Lorebook) => ({
  id: lorebook.id,
  name: lorebook.name,
  description: lorebook.description,
  createdAt: toIso(lorebook.createdAt),
  updatedAt: toIso(lorebook.updatedAt)
});

export const serializeLoreEntry = (entry: LoreEntry) => ({
  id: entry.id,
  lorebookId: entry.lorebookId,
  keys: toStringArray(entry.keys),
  content: entry.content,
  priority: entry.priority,
  enabled: entry.enabled,
  createdAt: toIso(entry.createdAt),
  updatedAt: toIso(entry.updatedAt)
});

export const serializeLorebookWithEntries = (lorebook: LorebookWithEntries) => ({
  ...serializeLorebook(lorebook),
  entries: lorebook.entries?.map(serializeLoreEntry) ?? []
});
