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
