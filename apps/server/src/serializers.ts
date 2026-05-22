import type {
  Character,
  Chat,
  LoreEntry,
  Lorebook,
  Message,
  Prisma,
  UserSettings
} from "@prisma/client";

interface ModelPreset {
  id: string;
  label: string;
  provider: string;
  apiBaseUrl: string;
  key?: string;
  model: string;
}

type LorebookWithEntries = Lorebook & { entries?: LoreEntry[] };

const toIso = (date: Date) => date.toISOString();

const normalizeLoreTriggerMode = (value: unknown): "user" | "assistant" | "both" => {
  if (value === "user" || value === "assistant") {
    return value;
  }

  return "both";
};

const toStringArray = (value: Prisma.JsonValue): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
};

const toModelPresets = (value: Prisma.JsonValue): ModelPreset[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(
      (item): item is Prisma.JsonObject =>
        typeof item === "object" && item !== null && !Array.isArray(item)
    )
    .map((item) => ({
      id: String(item.id ?? ""),
      label: String(item.label ?? ""),
      provider: String(item.provider ?? ""),
      apiBaseUrl: String(item.apiBaseUrl ?? ""),
      key: typeof item.key === "string" ? item.key : undefined,
      model: String(item.model ?? "")
    }));
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
      const triggerMode = entry.triggerMode;
      const alwaysActive = entry.alwaysActive;
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
        triggerMode: normalizeLoreTriggerMode(triggerMode),
        alwaysActive: alwaysActive === true,
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
  models: toModelPresets(settings.models),
  createdAt: toIso(settings.createdAt),
  updatedAt: toIso(settings.updatedAt)
});

export const serializeCharacter = (character: Character) => ({
  id: character.id,
  name: character.name,
  avatar: character.avatar,
  prefix: character.prefix,
  prompt: character.prompt,
  suffix: character.suffix,
  createdAt: toIso(character.createdAt),
  updatedAt: toIso(character.updatedAt)
});

export const serializeChat = (chat: Chat) => ({
  id: chat.id,
  title: chat.title,
  mode: chat.mode === "group" ? "group" : "single",
  characterIds: toStringArray(chat.characterIds),
  lorebookIds: toStringArray(chat.lorebookIds),
  memoryTurns: chat.memoryTurns,
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
  triggerMode: normalizeLoreTriggerMode(entry.triggerMode),
  alwaysActive: entry.alwaysActive,
  enabled: entry.enabled,
  createdAt: toIso(entry.createdAt),
  updatedAt: toIso(entry.updatedAt)
});

export const serializeLorebookWithEntries = (lorebook: LorebookWithEntries) => ({
  ...serializeLorebook(lorebook),
  entries: lorebook.entries?.map(serializeLoreEntry) ?? []
});
