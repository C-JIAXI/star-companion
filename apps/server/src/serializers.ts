import type { Character, Chat, ChatMemory, Message, Prisma, UserSettings } from "@prisma/client";
import { resolveCharacterRecord } from "./services/characterCards.js";

interface ProviderModel {
  id: string;
  label: string;
  model: string;
  capabilities?: AiModelCapability[];
}

type AiModelCapability = "text_generation" | "audio_transcription" | "text_to_speech" | "image_generation";

interface ProviderProfile {
  id: string;
  label: string;
  provider: string;
  apiBaseUrl: string;
  hasKey?: boolean;
  models: ProviderModel[];
}

type AiModuleId =
  | "chat"
  | "agent"
  | "memory"
  | "user_profile"
  | "voice_transcription"
  | "voice_speech"
  | "image_generation";

type ModuleModelPreferences = Partial<Record<AiModuleId, { providerId: string; modelId: string }>>;

interface UserPersonaPreset {
  id: string;
  name: string;
  config: {
    prefix: string;
    prompt: string;
    suffix: string;
  };
  createdAt: string;
  updatedAt: string;
}

const toIso = (date: Date) => date.toISOString();

const normalizeLoreTriggerMode = (value: unknown): "user" | "assistant" | "both" => {
  if (value === "user" || value === "assistant") {
    return value;
  }

  return "both";
};

const normalizeLoreScope = (value: unknown): "prefix" | "prompt" | "suffix" => {
  if (value === "prefix" || value === "suffix") {
    return value;
  }
  return "prompt";
};

const toStringArray = (value: Prisma.JsonValue): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
};

const toProviderModels = (value: unknown): ProviderModel[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null && !Array.isArray(item)
    )
    .map((item) => ({
      id: String(item.id ?? ""),
      label: String(item.label ?? ""),
      model: String(item.model ?? ""),
      capabilities: Array.isArray(item.capabilities)
        ? item.capabilities.filter(
            (capability): capability is AiModelCapability =>
              capability === "text_generation" ||
              capability === "audio_transcription" ||
              capability === "text_to_speech" ||
              capability === "image_generation"
          )
        : undefined
    }));
};

const toProviderProfiles = (value: Prisma.JsonValue): ProviderProfile[] => {
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
      hasKey: typeof item.key === "string" && Boolean(item.key.trim()),
      models: toProviderModels(item.models)
    }));
};

const moduleIds: AiModuleId[] = [
  "chat",
  "agent",
  "memory",
  "user_profile",
  "voice_transcription",
  "voice_speech",
  "image_generation"
];

const toModuleModelPreferences = (value: Prisma.JsonValue): ModuleModelPreferences => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const raw = value as Record<string, unknown>;
  const preferences: ModuleModelPreferences = {};

  for (const moduleId of moduleIds) {
    const entry = raw[moduleId];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }

    const typed = entry as Record<string, unknown>;
    if (typeof typed.providerId === "string" && typeof typed.modelId === "string") {
      preferences[moduleId] = {
        providerId: typed.providerId,
        modelId: typed.modelId
      };
    }
  }

  return preferences;
};

const toUserPersonaPresets = (value: Prisma.JsonValue): UserPersonaPreset[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry): UserPersonaPreset | null => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return null;
      }

      const raw = entry as Record<string, unknown>;
      const config = raw.config;
      if (
        typeof raw.id !== "string" ||
        typeof raw.name !== "string" ||
        !config ||
        typeof config !== "object" ||
        Array.isArray(config)
      ) {
        return null;
      }

      const typedConfig = config as Record<string, unknown>;
      return {
        id: raw.id,
        name: raw.name,
        config: {
          prefix: typeof typedConfig.prefix === "string" ? typedConfig.prefix : "",
          prompt: typeof typedConfig.prompt === "string" ? typedConfig.prompt : "",
          suffix: typeof typedConfig.suffix === "string" ? typedConfig.suffix : ""
        },
        createdAt: typeof raw.createdAt === "string" ? raw.createdAt : toIso(new Date(0)),
        updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : toIso(new Date(0))
      };
    })
    .filter((entry): entry is UserPersonaPreset => Boolean(entry));
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
        typeof enabled !== "boolean"
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
        scope: normalizeLoreScope(entry.scope),
        triggerMode: normalizeLoreTriggerMode(triggerMode),
        alwaysActive: alwaysActive === true,
        enabled,
        createdAt: typeof createdAt === "string" ? createdAt : undefined,
        updatedAt: typeof updatedAt === "string" ? updatedAt : undefined
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
};

export const toMemoryMatches = (value: Prisma.JsonValue | null) => {
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
      const chatId = entry.chatId;
      const title = entry.title;
      const content = entry.content;
      const keywords = entry.keywords;
      const importance = entry.importance;
      const enabled = entry.enabled;

      if (
        typeof id !== "string" ||
        typeof chatId !== "string" ||
        typeof title !== "string" ||
        typeof content !== "string" ||
        !Array.isArray(keywords) ||
        typeof importance !== "number" ||
        typeof enabled !== "boolean"
      ) {
        return null;
      }

      return {
        id,
        chatId,
        title,
        content,
        keywords: keywords.filter((keyword): keyword is string => typeof keyword === "string"),
        importance,
        enabled,
        score: typeof entry.score === "number" ? entry.score : undefined,
        lastMatchedAt: typeof entry.lastMatchedAt === "string" ? entry.lastMatchedAt : null,
        createdAt: typeof entry.createdAt === "string" ? entry.createdAt : undefined,
        updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : undefined
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
  providers: toProviderProfiles(settings.providers),
  activeProviderId: settings.activeProviderId ?? "",
  activeModelId: settings.activeModelId ?? "",
  moduleModelPreferences: toModuleModelPreferences(settings.moduleModelPreferences),
  userPersonaPresets: toUserPersonaPresets(settings.userPersonaPresets),
  userProfileSummary: settings.userProfileSummary,
  autoSummarizeUser: settings.autoSummarizeUser,
  showMessageAvatars: settings.showMessageAvatars,
  showMessageTimestamps: settings.showMessageTimestamps,
  ttsVoice: settings.ttsVoice,
  ttsPlaybackRate: settings.ttsPlaybackRate,
  ttsAutoPlay: settings.ttsAutoPlay,
  userProfileUpdatedAt: settings.userProfileUpdatedAt?.toISOString() ?? null,
  createdAt: toIso(settings.createdAt),
  updatedAt: toIso(settings.updatedAt)
});

export const serializeCharacter = (character: Character, password?: string) => {
  const resolved = resolveCharacterRecord(character, password);

  const quickRepliesRaw = character.quickReplies as unknown;
  const quickReplies = Array.isArray(quickRepliesRaw)
    ? quickRepliesRaw
        .filter((item): item is Record<string, unknown> => {
          if (typeof item !== "object" || item === null || Array.isArray(item)) {
            return false;
          }
          return true;
        })
        .map((item) => ({
          id: String((item as Record<string, unknown>).id ?? ""),
          label: String((item as Record<string, unknown>).label ?? ""),
          content: String((item as Record<string, unknown>).content ?? "")
        }))
        .filter((item) => item.id && item.label && item.content)
    : [];

  return {
    id: character.id,
    cardId: character.cardId,
    name: resolved.name,
    avatar: resolved.avatar,
    description: resolved.description,
    tags: toStringArray(character.tags),
    prefix: resolved.prefix,
    prompt: resolved.prompt,
    suffix: resolved.suffix,
    htmlCss: resolved.htmlCss,
    openingHtml: resolved.openingHtml,
    loreEntries: resolved.loreEntries,
    quickReplies,
    isFavorite: character.isFavorite,
    visibility: resolved.visibility,
    canViewPrompt: resolved.canViewPrompt,
    createdAt: toIso(character.createdAt),
    updatedAt: toIso(character.updatedAt)
  };
};

export const serializeChat = (chat: Chat, messageCount?: number) => ({
  id: chat.id,
  title: chat.title,
  characterId: chat.characterId,
  parentChatId: chat.parentChatId,
  branchSourceMessageId: chat.branchSourceMessageId,
  isCheckpoint: chat.isCheckpoint,
  isPinned: chat.isPinned,
  isArchived: chat.isArchived,
  deletedAt: chat.deletedAt?.toISOString() ?? null,
  backgroundUrl: chat.backgroundUrl,
  messageCount: messageCount ?? 0,
  memoryTurns: chat.memoryTurns,
  autoMemoryEnabled: chat.autoMemoryEnabled,
  memoryUpdatedAt: chat.memoryUpdatedAt?.toISOString() ?? null,
  userPersona: chat.userPersona,
  userProfileSummary: chat.userProfileSummary,
  userProfileUpdatedAt: chat.userProfileUpdatedAt?.toISOString() ?? null,
  createdAt: toIso(chat.createdAt),
  updatedAt: toIso(chat.updatedAt)
});

export const serializeChatMemory = (memory: ChatMemory) => ({
  id: memory.id,
  chatId: memory.chatId,
  title: memory.title,
  content: memory.content,
  keywords: toStringArray(memory.keywords),
  importance: memory.importance,
  enabled: memory.enabled,
  sourceMessageIds: toStringArray(memory.sourceMessageIds),
  lastMatchedAt: memory.lastMatchedAt?.toISOString() ?? null,
  createdAt: toIso(memory.createdAt),
  updatedAt: toIso(memory.updatedAt)
});

export const serializeMessage = (message: Message) => ({
  id: message.id,
  chatId: message.chatId,
  role: message.role === "assistant" || message.role === "system" ? message.role : "user",
  characterId: message.characterId,
  content: message.content,
  contextIncluded: message.contextIncluded,
  isBookmarked: message.isBookmarked,
  variants: toStringArray(message.variants),
  activeVariantIndex: message.activeVariantIndex,
  tokenUsage: toTokenUsage(message.tokenUsage),
  loreMatches: toLoreMatches(message.loreMatches),
  memoryMatches: toMemoryMatches(message.memoryMatches),
  createdAt: toIso(message.createdAt),
  updatedAt: toIso(message.updatedAt)
});

export const serializeCharacterForBackup = (character: Character) => ({
  id: character.id,
  cardId: character.cardId,
  name: character.name,
  avatar: character.avatar,
  description: character.description,
  tags: toStringArray(character.tags),
  prefix: character.prefix,
  prompt: character.prompt,
  suffix: character.suffix,
  htmlCss: character.htmlCss,
  openingHtml: character.openingHtml ?? "",
  loreEntries: character.loreEntries,
  quickReplies: character.quickReplies,
  isFavorite: character.isFavorite,
  createdAt: toIso(character.createdAt),
  updatedAt: toIso(character.updatedAt)
});
