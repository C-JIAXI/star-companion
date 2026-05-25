import type {
  Character,
  Chat,
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
      const characterId = entry.characterId;
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
        typeof characterId !== "string" ||
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
        characterId,
        characterName: typeof entry.characterName === "string" ? entry.characterName : undefined,
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

const toLoreEntries = (value: Prisma.JsonValue) => {
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
      const keys = entry.keys;
      const content = entry.content;
      const priority = entry.priority;
      const triggerMode = entry.triggerMode;
      const alwaysActive = entry.alwaysActive;
      const enabled = entry.enabled;

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
        triggerMode: normalizeLoreTriggerMode(triggerMode),
        alwaysActive: alwaysActive === true,
        enabled: enabled !== false
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
  userProfileSummary: settings.userProfileSummary,
  autoSummarizeUser: settings.autoSummarizeUser,
  showMessageAvatars: settings.showMessageAvatars,
  userProfileUpdatedAt: settings.userProfileUpdatedAt?.toISOString() ?? null,
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
  htmlCss: character.htmlCss,
  loreEntries: toLoreEntries(character.loreEntries),
  createdAt: toIso(character.createdAt),
  updatedAt: toIso(character.updatedAt)
});

export const serializeChat = (chat: Chat) => ({
  id: chat.id,
  title: chat.title,
  mode: "single",
  characterIds: toStringArray(chat.characterIds),
  memoryTurns: chat.memoryTurns,
  userPersona: chat.userPersona,
  userProfileSummary: chat.userProfileSummary,
  userProfileUpdatedAt: chat.userProfileUpdatedAt?.toISOString() ?? null,
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
