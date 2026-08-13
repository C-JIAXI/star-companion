import type { Character, Chat, ChatMemory, MediaAsset, MemoryOperation, MemoryRevision, Message, MessageAttachment, Prisma, ProfileSummaryRevision, UserSettings } from "@prisma/client";
import { serializeAttachment } from "./services/messageAttachments.js";
import { resolveCharacterRecord } from "./services/characterCards.js";

interface ProviderModel {
  id: string;
  label: string;
  model: string;
  contextWindow?: number;
  capabilities?: AiModelCapability[];
  pricing?: {
    inputMicrosPerMillion: number;
    outputMicrosPerMillion: number;
    currency: "USD";
    updatedAt: string;
    source: "user" | "template";
  };
}

const normalizeAppearancePreferences = (value: unknown) => {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const allowed = <T extends string>(candidate: unknown, values: readonly T[], fallback: T): T =>
    typeof candidate === "string" && values.includes(candidate as T) ? candidate as T : fallback;
  return {
    themeMode: allowed(input.themeMode, ["system", "light", "dark"] as const, "system"),
    fontSize: allowed(input.fontSize, ["small", "standard", "large", "extra-large"] as const, "standard"),
    lineHeight: allowed(input.lineHeight, ["compact", "comfortable", "relaxed"] as const, "comfortable"),
    chatWidth: allowed(input.chatWidth, ["narrow", "standard", "wide"] as const, "standard"),
    messageSpacing: allowed(input.messageSpacing, ["compact", "standard", "relaxed"] as const, "standard"),
    contrast: allowed(input.contrast, ["standard", "high"] as const, "standard"),
    motion: allowed(input.motion, ["system", "reduced", "full"] as const, "system"),
    backgroundOverlay: typeof input.backgroundOverlay === "number" && Number.isFinite(input.backgroundOverlay) && input.backgroundOverlay >= 0.2 && input.backgroundOverlay <= 0.9 ? input.backgroundOverlay : 0.55,
    backgroundBlur: allowed(input.backgroundBlur, ["off", "subtle", "medium"] as const, "subtle"),
    characterStyle: allowed(input.characterStyle, ["full", "restricted", "off"] as const, "full")
  };
};

type AiModelCapability =
  | "text_generation"
  | "vision_input"
  | "text_embedding"
  | "audio_transcription"
  | "text_to_speech"
  | "image_generation";

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
  | "memory_embedding"
  | "user_profile"
  | "voice_transcription"
  | "voice_speech"
  | "image_generation";

type ModuleModelPreferences = Partial<Record<AiModuleId, { providerId: string; modelId: string }>>;

const promptBreakdownSectionIds = new Set([
  "character",
  "user_persona",
  "user_profile",
  "lore",
  "memory",
  "history",
  "image_input",
  "generation_instruction",
  "formatting"
]);

interface UserPersonaPreset {
  id: string;
  name: string;
  avatar: string;
  config: {
    displayName: string;
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
      contextWindow:
        typeof item.contextWindow === "number" && Number.isInteger(item.contextWindow)
          ? item.contextWindow
          : undefined,
      capabilities: Array.isArray(item.capabilities)
        ? item.capabilities.filter(
            (capability): capability is AiModelCapability =>
              capability === "text_generation" ||
              capability === "vision_input" ||
              capability === "text_embedding" ||
              capability === "audio_transcription" ||
              capability === "text_to_speech" ||
              capability === "image_generation"
          )
        : undefined,
      pricing:
        item.pricing && typeof item.pricing === "object" && !Array.isArray(item.pricing) &&
        typeof (item.pricing as Record<string, unknown>).inputMicrosPerMillion === "number" &&
        typeof (item.pricing as Record<string, unknown>).outputMicrosPerMillion === "number" &&
        (item.pricing as Record<string, unknown>).currency === "USD" &&
        typeof (item.pricing as Record<string, unknown>).updatedAt === "string" &&
        ((item.pricing as Record<string, unknown>).source === "user" || (item.pricing as Record<string, unknown>).source === "template")
          ? item.pricing as ProviderModel["pricing"]
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
  "memory_embedding",
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

const defaultModelReliability = { retry: { enabled: false, maxRetries: 0 }, fallback: {} };
const toModelReliability = (value: Prisma.JsonValue) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaultModelReliability;
  const raw = value as Record<string, unknown>;
  const retry = raw.retry && typeof raw.retry === "object" && !Array.isArray(raw.retry)
    ? raw.retry as Record<string, unknown>
    : {};
  const fallback = raw.fallback && typeof raw.fallback === "object" && !Array.isArray(raw.fallback)
    ? raw.fallback
    : {};
  return {
    retry: {
      enabled: retry.enabled === true,
      maxRetries: typeof retry.maxRetries === "number" ? Math.max(0, Math.min(2, Math.trunc(retry.maxRetries))) : 0
    },
    fallback
  };
};

const defaultUsageBudgets = {
  dailySoftMicros: null,
  dailyHardMicros: null,
  monthlySoftMicros: null,
  monthlyHardMicros: null,
  allowUnknownPricing: true
};
const toUsageBudgets = (value: Prisma.JsonValue) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaultUsageBudgets;
  const raw = value as Record<string, unknown>;
  const amount = (key: string) => typeof raw[key] === "number" && Number.isInteger(raw[key]) && (raw[key] as number) >= 0 ? raw[key] as number : null;
  return {
    dailySoftMicros: amount("dailySoftMicros"),
    dailyHardMicros: amount("dailyHardMicros"),
    monthlySoftMicros: amount("monthlySoftMicros"),
    monthlyHardMicros: amount("monthlyHardMicros"),
    allowUnknownPricing: raw.allowUnknownPricing !== false
  };
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
        avatar: typeof raw.avatar === "string" ? raw.avatar : "",
        config: {
          displayName:
            typeof typedConfig.displayName === "string" ? typedConfig.displayName : "",
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

const toPromptBreakdown = (value: Prisma.JsonValue | null) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  if (
    typeof raw.promptTokens !== "number" ||
    typeof raw.promptTokensEstimated !== "boolean" ||
    typeof raw.includedMessageCount !== "number" ||
    !Array.isArray(raw.sections)
  ) {
    return null;
  }

  const sections = raw.sections
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      const section = entry as Record<string, unknown>;
      if (
        typeof section.id !== "string" ||
        !promptBreakdownSectionIds.has(section.id) ||
        typeof section.tokenEstimate !== "number" ||
        typeof section.characterCount !== "number" ||
        typeof section.itemCount !== "number"
      ) {
        return null;
      }
      return {
        id: section.id,
        tokenEstimate: section.tokenEstimate,
        characterCount: section.characterCount,
        itemCount: section.itemCount
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

  return {
    promptTokens: raw.promptTokens,
    promptTokensEstimated: raw.promptTokensEstimated,
    includedMessageCount: raw.includedMessageCount,
    imageCount: typeof raw.imageCount === "number" ? raw.imageCount : 0,
    sections
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
  modelReliability: toModelReliability(settings.modelReliability),
  usageBudgets: toUsageBudgets(settings.usageBudgets),
  usageTimezone: settings.usageTimezone || "UTC",
  userPersonaPresets: toUserPersonaPresets(settings.userPersonaPresets),
  userProfileSummary: settings.userProfileSummary,
  autoSummarizeUser: settings.autoSummarizeUser,
  showMessageAvatars: settings.showMessageAvatars,
  showMessageTimestamps: settings.showMessageTimestamps,
  appearancePreferences: normalizeAppearancePreferences(settings.appearancePreferences),
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

export const serializeChat = (
  chat: Chat,
  messageCount?: number,
  includeUserAvatar = true
) => ({
  id: chat.id,
  title: chat.title,
  characterId: chat.characterId,
  parentChatId: chat.parentChatId,
  branchSourceMessageId: chat.branchSourceMessageId,
  isCheckpoint: chat.isCheckpoint,
  isPinned: chat.isPinned,
  isArchived: chat.isArchived,
  folder: chat.folder,
  deletedAt: chat.deletedAt?.toISOString() ?? null,
  backgroundUrl: chat.backgroundUrl,
  messageCount: messageCount ?? 0,
  memoryTurns: chat.memoryTurns,
  autoMemoryEnabled: chat.autoMemoryEnabled,
  memoryUpdatedAt: chat.memoryUpdatedAt?.toISOString() ?? null,
  userPersona: chat.userPersona,
  ...(includeUserAvatar ? { userAvatar: chat.userAvatar } : {}),
  userProfileSummary: chat.userProfileSummary,
  userProfileUpdatedAt: chat.userProfileUpdatedAt?.toISOString() ?? null,
  profileRevision: chat.profileRevision,
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
  deletedAt: memory.deletedAt?.toISOString() ?? null,
  currentRevision: memory.currentRevision,
  lastActor: memory.lastActor,
  lastAction: memory.lastAction,
  sourceMessageIds: toStringArray(memory.sourceMessageIds),
  embeddingModel: memory.embeddingModel,
  embeddingSource: memory.embeddingSource,
  embeddingDimensions: memory.embeddingDimensions,
  embeddingStatus: memory.embeddingStatus,
  embeddingUpdatedAt: memory.embeddingUpdatedAt?.toISOString() ?? null,
  lastMatchedAt: memory.lastMatchedAt?.toISOString() ?? null,
  createdAt: toIso(memory.createdAt),
  updatedAt: toIso(memory.updatedAt)
});

export const serializeMemoryRevisionForBackup = (revision: MemoryRevision) => ({
  id: revision.id,
  memoryId: revision.memoryId,
  chatId: revision.chatId,
  revision: revision.revision,
  action: revision.action,
  actor: revision.actor,
  beforeSnapshot: revision.beforeSnapshot,
  afterSnapshot: revision.afterSnapshot,
  sourceMessageIds: toStringArray(revision.sourceMessageIds),
  operationId: revision.operationId,
  reasonCode: revision.reasonCode,
  createdAt: toIso(revision.createdAt)
});

export const serializeMemoryOperationForBackup = (operation: MemoryOperation) => ({
  id: operation.id,
  chatId: operation.chatId,
  type: operation.type,
  actor: operation.actor,
  status: operation.status,
  startedAt: toIso(operation.startedAt),
  completedAt: operation.completedAt?.toISOString() ?? null,
  created: operation.createdCount,
  updated: operation.updatedCount,
  disabled: operation.disabledCount,
  unchanged: operation.unchangedCount,
  sourceMessageIds: toStringArray(operation.sourceMessageIds),
  errorCode: operation.errorCode,
  undoneAt: operation.undoneAt?.toISOString() ?? null,
  undoOperationId: operation.undoOperationId
});

export const serializeProfileSummaryRevisionForBackup = (revision: ProfileSummaryRevision) => ({
  id: revision.id,
  chatId: revision.chatId,
  revision: revision.revision,
  action: revision.action,
  actor: revision.actor,
  summary: revision.summary,
  sourceMessageIds: toStringArray(revision.sourceMessageIds),
  createdAt: toIso(revision.createdAt)
});

export const serializeMessage = (message: Message & { attachments?: Array<MessageAttachment & { asset: MediaAsset }> }) => ({
  id: message.id,
  chatId: message.chatId,
  role: message.role === "assistant" || message.role === "system" ? message.role : "user",
  characterId: message.characterId,
  content: message.content,
  attachments: (message.attachments ?? []).map(serializeAttachment),
  contextIncluded: message.contextIncluded,
  isBookmarked: message.isBookmarked,
  variants: toStringArray(message.variants),
  activeVariantIndex: message.activeVariantIndex,
  tokenUsage: toTokenUsage(message.tokenUsage),
  generationMetadata: message.generationMetadata ?? null,
  variantMetadata: Array.isArray(message.variantMetadata) ? message.variantMetadata : [],
  promptBreakdown: toPromptBreakdown(message.promptBreakdown),
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
