export type MessageRole = "user" | "assistant" | "system";
export type AppLanguage = "zh-CN" | "en";
export type CharacterVisibility = "public" | "private";

export type AiModelCapability =
  | "text_generation"
  | "text_embedding"
  | "audio_transcription"
  | "text_to_speech"
  | "image_generation";

export interface ProviderModel {
  id: string;
  label: string;
  model: string;
  /** Explicit model capabilities. When omitted, clients use a conservative ID-based classification. */
  capabilities?: AiModelCapability[];
}

export interface ProviderProfile {
  id: string;
  label: string;
  provider: string;
  apiBaseUrl: string;
  /** Write-only API key. Settings responses expose hasKey instead. */
  key?: string;
  /** Indicates that a provider key is stored without exposing the secret. */
  hasKey?: boolean;
  models: ProviderModel[];
}

export interface UserSettingsDTO {
  id: string;
  activeProvider: string;
  apiBaseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  topP: number;
  language: AppLanguage;
  providers: ProviderProfile[];
  activeProviderId: string;
  activeModelId: string;
  moduleModelPreferences: ModuleModelPreferencesDTO;
  userPersonaPresets: UserPersonaPresetDTO[];
  userProfileSummary: string;
  autoSummarizeUser: boolean;
  showMessageAvatars: boolean;
  showMessageTimestamps: boolean;
  ttsVoice: string;
  ttsPlaybackRate: number;
  ttsAutoPlay: boolean;
  userProfileUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PublicUserSettingsDTO extends UserSettingsDTO {
  hasApiKey: boolean;
}

export interface AvailableModelsDTO {
  provider: string;
  models: string[];
  checkedAt: string;
}

export interface CharacterLoreEntryDTO {
  id: string;
  keys: string[];
  content: string;
  priority: number;
  scope: LoreEntryScope;
  triggerMode: LoreTriggerMode;
  alwaysActive: boolean;
  enabled: boolean;
}

export interface QuickReplyDTO {
  id: string;
  label: string;
  content: string;
}

export interface CharacterCardContentDTO {
  name: string;
  avatar: string | null;
  description: string;
  tags: string[];
  prefix: string;
  prompt: string;
  suffix: string;
  htmlCss: string;
  openingHtml: string;
  loreEntries: CharacterLoreEntryDTO[];
  quickReplies: QuickReplyDTO[];
}

export interface CharacterDTO {
  id: string;
  cardId: string;
  name: string;
  avatar: string | null;
  description: string;
  tags: string[];
  prefix: string;
  prompt: string;
  suffix: string;
  htmlCss: string;
  openingHtml: string;
  loreEntries: CharacterLoreEntryDTO[];
  quickReplies: QuickReplyDTO[];
  isFavorite: boolean;
  visibility: CharacterVisibility;
  canViewPrompt: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StoredPrivateCharacterBackupDTO {
  __privateCharacter: {
    version: 1;
    algorithm: "aes-256-gcm";
    iv: string;
    tag: string;
    ciphertext: string;
    accessControl: {
      version: 1;
      salt: string;
      verifier: string;
    };
    exportSalt?: string;
  };
}

export interface BackupCharacterDTO {
  id?: string;
  cardId: string;
  name: string;
  avatar: string | null;
  description: string;
  tags: string[];
  prefix: string;
  prompt: string;
  suffix: string;
  htmlCss: string;
  openingHtml: string;
  loreEntries: CharacterLoreEntryDTO[] | StoredPrivateCharacterBackupDTO;
  quickReplies: QuickReplyDTO[];
  isFavorite: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export type CharacterExportMode = CharacterVisibility;

export interface PublicCharacterCardDTO {
  schemaVersion: 1;
  format: "character-card";
  visibility: "public";
  cardId: string;
  exportedAt: string;
  character: CharacterCardContentDTO;
}

export type CharacterSortMode =
  | "favorites"
  | "recently_chatted"
  | "most_chats"
  | "recently_updated"
  | "name_asc"
  | "name_desc";

export interface CharacterDuplicateRequestDTO {
  name: string;
}

export type CharacterBatchTagOperation = "add" | "remove";

export interface CharacterBatchTagsRequestDTO {
  ids: string[];
  operation: CharacterBatchTagOperation;
  tags: string[];
}

export interface CharacterBatchTagsResultDTO {
  updated: number;
}

export type AiModuleId =
  | "chat"
  | "agent"
  | "memory"
  | "memory_embedding"
  | "user_profile"
  | "voice_transcription"
  | "voice_speech"
  | "image_generation";

export const aiModuleCapability: Record<AiModuleId, AiModelCapability> = {
  chat: "text_generation",
  agent: "text_generation",
  memory: "text_generation",
  memory_embedding: "text_embedding",
  user_profile: "text_generation",
  voice_transcription: "audio_transcription",
  voice_speech: "text_to_speech",
  image_generation: "image_generation"
};

const knownAiModelCapabilities = new Set<AiModelCapability>([
  "text_generation",
  "text_embedding",
  "audio_transcription",
  "text_to_speech",
  "image_generation"
]);

export const inferAiModelCapabilities = (model: string): AiModelCapability[] => {
  const normalized = model.trim().toLowerCase();

  if (/(?:^|[-_/])(?:embedding|embed|bge|e5|gte|nomic|jina|mxbai)(?:[-_/]|$)/.test(normalized)) {
    return ["text_embedding"];
  }

  if (/(^|[-_/])(?:whisper|transcribe|stt)(?:[-_/]|$)/.test(normalized)) {
    return ["audio_transcription"];
  }

  if (/(^|[-_/])(?:tts|speech)(?:[-_/]|$)/.test(normalized)) {
    return ["text_to_speech"];
  }

  if (/(?:dall[\-_.]?e|gpt[\-_.]?image|imagegen|stable[\-_.]?diffusion|(?:^|[-_/])sdxl?(?:[-_/]|$)|flux)/.test(normalized)) {
    return ["image_generation"];
  }

  // Unrecognised provider models are treated as text models, preserving existing local/OpenAI-compatible setups.
  return ["text_generation"];
};

export const getAiModelCapabilities = (model: Pick<ProviderModel, "model" | "capabilities">) => {
  if (Array.isArray(model.capabilities)) {
    return model.capabilities.filter((capability): capability is AiModelCapability =>
      knownAiModelCapabilities.has(capability)
    );
  }

  return inferAiModelCapabilities(model.model);
};

const normalizeProviderKindForCapabilities = (provider: string) => {
  const normalized = provider.trim().toLowerCase();
  if (["anthropic", "claude", "claude-native"].includes(normalized)) return "anthropic";
  if (["google", "google-gemini", "gemini", "gemini-native"].includes(normalized)) {
    return "google-gemini";
  }
  return "openai-compatible";
};

export const modelSupportsAiModule = (
  provider: string,
  model: Pick<ProviderModel, "model" | "capabilities">,
  moduleId: AiModuleId
) => {
  const mediaModule = ["voice_transcription", "voice_speech", "image_generation"].includes(moduleId);
  if (mediaModule && normalizeProviderKindForCapabilities(provider) !== "openai-compatible") {
    return false;
  }

  return getAiModelCapabilities(model).includes(aiModuleCapability[moduleId]);
};

export interface ModuleModelPreferenceDTO {
  providerId: string;
  modelId: string;
}

export type ModuleModelPreferencesDTO = Partial<Record<AiModuleId, ModuleModelPreferenceDTO>>;

export interface UserPersonaPresetDTO {
  id: string;
  name: string;
  config: UserCustomConfigDTO;
  createdAt: string;
  updatedAt: string;
}

export interface PrivateCharacterCardDTO {
  schemaVersion: 1;
  format: "character-card";
  visibility: "private";
  cardId: string;
  exportedAt: string;
  character: Pick<
    CharacterCardContentDTO,
    "name" | "avatar" | "description" | "tags" | "openingHtml" | "quickReplies"
  >;
  protectedPayload: {
    version: 1;
    algorithm: "aes-256-gcm";
    salt: string;
    iv: string;
    tag: string;
    ciphertext: string;
    accessControl: {
      version: 1;
      salt: string;
      verifier: string;
    };
  };
}

export type CharacterCardDTO = PublicCharacterCardDTO | PrivateCharacterCardDTO;

export interface PaginatedCharactersDTO {
  items: CharacterDTO[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  availableTags: string[];
}

export interface UserCustomConfigDTO {
  prefix: string;
  prompt: string;
  suffix: string;
}

type UserCustomConfigEnvelope = UserCustomConfigDTO & {
  type: "user-custom-config";
  version: 1;
};

const isUserCustomConfigEnvelope = (value: unknown): value is UserCustomConfigEnvelope => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const envelope = value as Record<string, unknown>;
  return (
    envelope.type === "user-custom-config" &&
    envelope.version === 1 &&
    typeof envelope.prefix === "string" &&
    typeof envelope.prompt === "string" &&
    typeof envelope.suffix === "string"
  );
};

export const emptyUserCustomConfig = (): UserCustomConfigDTO => ({
  prefix: "",
  prompt: "",
  suffix: ""
});

export const normalizeUserCustomConfig = (
  value?: Partial<UserCustomConfigDTO> | null
): UserCustomConfigDTO => ({
  prefix: value?.prefix ?? "",
  prompt: value?.prompt ?? "",
  suffix: value?.suffix ?? ""
});

export const parseUserCustomConfig = (value?: string | null): UserCustomConfigDTO => {
  const raw = value ?? "";

  if (!raw.trim()) {
    return emptyUserCustomConfig();
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isUserCustomConfigEnvelope(parsed)) {
      return normalizeUserCustomConfig(parsed);
    }
  } catch {}

  return emptyUserCustomConfig();
};

export const hasUserCustomConfigContent = (value?: Partial<UserCustomConfigDTO> | null) => {
  const normalized = normalizeUserCustomConfig(value);
  return Boolean(normalized.prefix.trim() || normalized.prompt.trim() || normalized.suffix.trim());
};

export const serializeUserCustomConfig = (value?: Partial<UserCustomConfigDTO> | null) => {
  const normalized = normalizeUserCustomConfig(value);

  if (!hasUserCustomConfigContent(normalized)) {
    return "";
  }

  return JSON.stringify({
    type: "user-custom-config",
    version: 1,
    ...normalized
  } satisfies UserCustomConfigEnvelope);
};

export const getUserCustomConfigSegments = (value?: string | null) => {
  const config = parseUserCustomConfig(value);
  return [config.prefix.trim(), config.prompt.trim(), config.suffix.trim()].filter(Boolean);
};

export interface ChatListMessagePreviewDTO {
  role: Exclude<MessageRole, "system">;
  content: string;
  createdAt: string;
}

export interface ChatDTO {
  id: string;
  title: string;
  characterId: string | null;
  parentChatId: string | null;
  branchSourceMessageId: string | null;
  isCheckpoint: boolean;
  isPinned: boolean;
  isArchived: boolean;
  folder: string;
  deletedAt: string | null;
  backgroundUrl: string;
  messageCount: number;
  lastMessagePreview?: ChatListMessagePreviewDTO | null;
  memoryTurns: number;
  autoMemoryEnabled: boolean;
  memoryUpdatedAt: string | null;
  userPersona: string;
  userProfileSummary: string;
  userProfileUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatBatchArchiveRequestDTO {
  ids: string[];
  isArchived: boolean;
}

export interface ChatBatchArchiveResultDTO {
  updated: number;
}

export interface ChatBatchFolderRequestDTO {
  ids: string[];
  folder: string;
}

export interface ChatBatchFolderResultDTO {
  updated: number;
}

export type ChatTrashAction = "trash" | "restore";

export interface ChatBatchTrashRequestDTO {
  ids: string[];
  action: ChatTrashAction;
}

export interface ChatBatchTrashResultDTO {
  updated: number;
}

export interface ChatBatchPermanentDeleteRequestDTO {
  ids: string[];
}

export interface ChatBatchPermanentDeleteResultDTO {
  deleted: number;
}

export interface ChatWithMessagesDTO extends ChatDTO {
  messages: MessageDTO[];
  memories?: ChatMemoryDTO[];
}

export interface ChatBranchRequestDTO {
  messageId: string;
  title?: string;
  kind?: "branch" | "checkpoint";
}

export interface ChatMessageSearchResultDTO {
  message: MessageDTO;
  index: number;
  snippet: string;
}

export interface ChatMessageSearchDTO {
  query: string;
  total: number;
  results: ChatMessageSearchResultDTO[];
}

export interface GlobalChatMessageSearchResultDTO extends ChatMessageSearchResultDTO {
  chat: Pick<ChatDTO, "id" | "title" | "characterId" | "isArchived">;
}

export interface GlobalChatMessageSearchDTO {
  query: string;
  total: number;
  results: GlobalChatMessageSearchResultDTO[];
}

export interface MessageDTO {
  id: string;
  chatId: string;
  role: MessageRole;
  characterId: string | null;
  content: string;
  contextIncluded: boolean;
  isBookmarked: boolean;
  variants: string[];
  activeVariantIndex: number;
  tokenUsage: TokenUsageDTO | null;
  loreMatches: MatchedLoreEntryDTO[];
  memoryMatches: MatchedMemoryDTO[];
  createdAt: string;
  updatedAt: string;
}

export interface TokenUsageDTO {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimated: boolean;
}

export type LoreTriggerMode = "user" | "assistant" | "both";
export type LoreEntryScope = "prefix" | "prompt" | "suffix";

export interface MatchedLoreEntryDTO {
  id: string;
  characterId: string;
  characterName?: string;
  keys: string[];
  content: string;
  priority: number;
  scope: LoreEntryScope;
  triggerMode: LoreTriggerMode;
  alwaysActive: boolean;
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface ChatMemoryDTO {
  id: string;
  chatId: string;
  title: string;
  content: string;
  keywords: string[];
  importance: number;
  enabled: boolean;
  sourceMessageIds: string[];
  embeddingModel?: string | null;
  embeddingUpdatedAt?: string | null;
  lastMatchedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMemoryInput {
  title: string;
  content: string;
  keywords?: string[];
  importance?: number;
  enabled?: boolean;
  sourceMessageIds?: string[];
}

export interface MatchedMemoryDTO {
  id: string;
  chatId: string;
  title: string;
  content: string;
  keywords: string[];
  importance: number;
  enabled: boolean;
  score?: number;
  embeddingModel?: string | null;
  embeddingUpdatedAt?: string | null;
  lastMatchedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface ChatMemoryUpdateSummaryDTO {
  chatId: string;
  created: number;
  updated: number;
  disabled: number;
  memoryUpdatedAt: string | null;
}

export type ChatAgentMode =
  | "scene_summary"
  | "next_steps"
  | "reply_drafts"
  | "memory_lore_candidates";

export interface ChatAgentDraftRequestDTO {
  mode: ChatAgentMode;
  focus?: string;
}

export interface ChatAgentDraftDTO {
  mode: ChatAgentMode;
  title: string;
  content: string;
  createdAt: string;
  matchedLoreEntries: MatchedLoreEntryDTO[];
  matchedMemoryEntries: MatchedMemoryDTO[];
}

export interface ChatTitleSuggestionDTO {
  title: string;
  createdAt: string;
}

export interface VoiceTranscriptionRequestDTO {
  audioBase64: string;
  mimeType: string;
  filename?: string;
}

export interface VoiceTranscriptionDTO {
  text: string;
  model: string;
  createdAt: string;
}

export interface VoiceSpeechRequestDTO {
  text: string;
  voice?: string;
  format?: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";
}

export interface VoiceSpeechDTO {
  audioBase64: string;
  mimeType: string;
  model: string;
  createdAt: string;
}

export interface ImageGenerationRequestDTO {
  prompt: string;
  size?: "1024x1024" | "1024x1536" | "1536x1024" | "auto";
}

export interface ImageGenerationDTO {
  images: Array<{
    url?: string;
    b64Json?: string;
    mimeType: string;
  }>;
  model: string;
  createdAt: string;
}

export interface BackupDTO {
  schemaVersion: 1;
  exportedAt: string;
  settings: UserSettingsDTO | null;
  characters: BackupCharacterDTO[];
  chats: ChatDTO[];
  messages: MessageDTO[];
  memories: ChatMemoryDTO[];
}

export interface BackupImportSummaryDTO {
  mode: "merge" | "replace";
  characters: number;
  chats: number;
  messages: number;
  memories: number;
  settingsImported: boolean;
}

export interface ChatArchiveDTO {
  archiveVersion: 1;
  exportedAt: string;
  chat: ChatDTO;
  character: BackupCharacterDTO | null;
  messages: MessageDTO[];
  memories: ChatMemoryDTO[];
}

export interface ChatArchiveImportDTO {
  archive: ChatArchiveDTO;
  title?: string;
}

export type LanSyncDirection = "pull" | "push";

export interface LanSyncRequestDTO {
  peerBaseUrl: string;
  mode: "merge" | "replace";
}

export interface LanSyncSummaryDTO {
  direction: LanSyncDirection;
  mode: "merge" | "replace";
  peerBaseUrl: string;
  peerExportedAt: string | null;
  completedAt: string;
  summary: BackupImportSummaryDTO;
}

export interface LanSyncInfoDTO {
  localUrl: string;
  lanUrls: string[];
  currentOrigin: string;
  port: number;
  listeningHost: string;
  lanReachable: boolean;
  checkedAt: string;
}

export type GenerationClientMessage =
  | {
      type: "generate";
      requestId: string;
      chatId: string;
      content: string;
    }
  | {
      type: "regenerate";
      requestId: string;
      messageId: string;
    }
  | {
      type: "continue";
      requestId: string;
      messageId: string;
    }
  | {
      type: "resend";
      requestId: string;
      messageId: string;
    }
  | {
      type: "stop";
      requestId: string;
    };

export type GenerationServerMessage =
  | {
      type: "ready";
      app: string;
    }
  | {
      type: "generation_started";
      requestId: string;
    }
  | {
      type: "user_message";
      requestId: string;
      message: MessageDTO;
    }
  | {
      type: "lore_matches";
      requestId: string;
      entries: MatchedLoreEntryDTO[];
    }
  | {
      type: "memory_matches";
      requestId: string;
      entries: MatchedMemoryDTO[];
    }
  | {
      type: "generation_character_started";
      requestId: string;
      characterId: string | null;
      index: number;
      total: number;
    }
  | {
      type: "token";
      requestId: string;
      content: string;
    }
  | {
      type: "assistant_message";
      requestId: string;
      message: MessageDTO;
    }
  | {
      type: "user_profile_updated";
      requestId: string;
      summary: string;
      updatedAt: string | null;
    }
  | {
      type: "chat_memory_updated";
      requestId: string;
      summary: ChatMemoryUpdateSummaryDTO;
    }
  | {
      type: "timeline_memory_invalidated";
      requestId: string;
      chatId: string;
      disabledMemoryCount: number;
    }
  | {
      type: "generation_done";
      requestId: string;
    }
  | {
      type: "generation_stopped";
      requestId: string;
    }
  | {
      type: "error";
      requestId?: string;
      error: string;
    };
