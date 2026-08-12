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
  /** Optional provider/model context limit used for local budget estimates. */
  contextWindow?: number;
  /** Explicit model capabilities. When omitted, clients use a conservative ID-based classification. */
  capabilities?: AiModelCapability[];
  /** Optional user/template supplied USD prices in integer micro-dollars per million tokens. */
  pricing?: ModelPricingDTO;
}

export interface ModelPricingDTO {
  inputMicrosPerMillion: number;
  outputMicrosPerMillion: number;
  currency: "USD";
  updatedAt: string;
  source: "user" | "template";
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
  modelReliability: ModelReliabilitySettingsDTO;
  usageBudgets: UsageBudgetSettingsDTO;
  usageTimezone: string;
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

export interface ModuleFallbackSettingsDTO {
  enabled: boolean;
  /** Chat requires this additional consent because model changes can change character performance. */
  allowAutomatic?: boolean;
  chain: ModuleModelPreferenceDTO[];
}

export interface ModelReliabilitySettingsDTO {
  retry: {
    enabled: boolean;
    /** Additional provider attempts after the first one; v1 maximum is 2 (3 total attempts). */
    maxRetries: number;
  };
  fallback: Partial<Record<AiModuleId, ModuleFallbackSettingsDTO>>;
}

export interface UsageBudgetSettingsDTO {
  dailySoftMicros: number | null;
  dailyHardMicros: number | null;
  monthlySoftMicros: number | null;
  monthlyHardMicros: number | null;
  allowUnknownPricing: boolean;
}

export type ModelErrorCode =
  | "authentication"
  | "model_not_found"
  | "unsupported_capability"
  | "rate_limited"
  | "quota_exceeded"
  | "context_overflow"
  | "invalid_request"
  | "safety_blocked"
  | "timeout"
  | "connection_failed"
  | "provider_unavailable"
  | "malformed_response"
  | "stream_interrupted"
  | "cancelled"
  | "budget_blocked"
  | "unknown";

export interface ModelErrorDTO {
  code: ModelErrorCode;
  retryable: boolean;
  receivedOutputTokens: boolean;
  retryAfterMs?: number;
  provider: string;
  modelId: string;
  attempt: number;
  summary: string;
  diagnosticId: string;
}

export type ModelRequestStatus =
  | "queued"
  | "running"
  | "streaming"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "blocked";

export type UsageAttemptStatus = "succeeded" | "failed" | "cancelled" | "interrupted" | "blocked";
export type UsageSource = "provider" | "estimated";

export interface GenerationMetadataDTO {
  providerId: string;
  providerType: string;
  modelId: string;
  requestId: string;
  attemptId: string;
  usage: TokenUsageDTO | null;
  usageSource: UsageSource | null;
  inputPriceMicros: number | null;
  outputPriceMicros: number | null;
  estimatedCostMicros: number | null;
  currency: "USD" | null;
  usedFallback: boolean;
  incomplete: boolean;
}

export interface ModelRequestDTO {
  requestId: string;
  module: AiModuleId;
  operation: string;
  chatId: string | null;
  messageId: string | null;
  status: ModelRequestStatus;
  activeAttemptId: string | null;
  outputStarted: boolean;
  error: ModelErrorDTO | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface UsageAttemptDTO {
  attemptId: string;
  requestId: string;
  attemptNumber: number;
  module: AiModuleId;
  chatId: string | null;
  chatTitle: string | null;
  messageId: string | null;
  providerId: string;
  providerType: string;
  modelId: string;
  startedAt: string;
  completedAt: string | null;
  status: UsageAttemptStatus;
  promptTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  usageSource: UsageSource | null;
  inputPriceMicros: number | null;
  outputPriceMicros: number | null;
  estimatedCostMicros: number | null;
  currency: "USD" | null;
  specialTokensUnknown: boolean;
  usedFallback: boolean;
  errorCode: ModelErrorCode | null;
}

export interface UsageAggregateBucketDTO {
  key: string;
  label: string;
  attempts: number;
  succeeded: number;
  failed: number;
  retries: number;
  fallbacks: number;
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostMicros: number;
  unknownCostAttempts: number;
}

export interface UsageSummaryDTO {
  from: string;
  to: string;
  todayCostMicros: number;
  monthCostMicros: number;
  todayTokens: number;
  monthTokens: number;
  unknownCostAttempts: number;
  budgets: UsageBudgetSettingsDTO;
  timezone: string;
  byModule: UsageAggregateBucketDTO[];
  byProvider: UsageAggregateBucketDTO[];
  byModel: UsageAggregateBucketDTO[];
  byChat: UsageAggregateBucketDTO[];
  recent: UsageAttemptDTO[];
}

export interface CostPreviewDTO {
  providerId: string;
  modelId: string;
  inputTokens: number;
  maxOutputTokens: number;
  minimumCostMicros: number | null;
  maximumCostMicros: number | null;
  currency: "USD" | null;
  todayCostMicros: number;
  monthCostMicros: number;
  dailySoftRemainingMicros: number | null;
  dailyHardRemainingMicros: number | null;
  monthlySoftRemainingMicros: number | null;
  monthlyHardRemainingMicros: number | null;
  unknownPricing: boolean;
  softWarning: boolean;
  hardBlocked: boolean;
  timezone: string;
}

export interface UserPersonaPresetDTO {
  id: string;
  name: string;
  avatar: string;
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
  displayName: string;
  prefix: string;
  prompt: string;
  suffix: string;
}

type LegacyUserCustomConfigEnvelope = Omit<UserCustomConfigDTO, "displayName"> & {
  type: "user-custom-config";
  version: 1;
};

type UserCustomConfigEnvelope = UserCustomConfigDTO & {
  type: "user-custom-config";
  version: 2;
};

type SerializedUserCustomConfigEnvelope =
  | LegacyUserCustomConfigEnvelope
  | UserCustomConfigEnvelope;

const isUserCustomConfigEnvelope = (
  value: unknown
): value is SerializedUserCustomConfigEnvelope => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const envelope = value as Record<string, unknown>;
  return (
    envelope.type === "user-custom-config" &&
    (envelope.version === 1 || envelope.version === 2) &&
    typeof envelope.prefix === "string" &&
    typeof envelope.prompt === "string" &&
    typeof envelope.suffix === "string" &&
    (envelope.version === 1 || typeof envelope.displayName === "string")
  );
};

export const emptyUserCustomConfig = (): UserCustomConfigDTO => ({
  displayName: "",
  prefix: "",
  prompt: "",
  suffix: ""
});

export const normalizeUserCustomConfig = (
  value?: Partial<UserCustomConfigDTO> | null
): UserCustomConfigDTO => ({
  displayName: value?.displayName ?? "",
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
  return Boolean(
    normalized.displayName.trim() ||
      normalized.prefix.trim() ||
      normalized.prompt.trim() ||
      normalized.suffix.trim()
  );
};

export const serializeUserCustomConfig = (value?: Partial<UserCustomConfigDTO> | null) => {
  const normalized = normalizeUserCustomConfig(value);

  if (!hasUserCustomConfigContent(normalized)) {
    return "";
  }

  return JSON.stringify({
    type: "user-custom-config",
    version: 2,
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
  userAvatar?: string;
  userProfileSummary: string;
  userProfileUpdatedAt: string | null;
  profileRevision: number;
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

export interface ChatRenameFolderRequestDTO {
  from: string;
  to: string;
}

export interface ChatRenameFolderResultDTO {
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

export type PromptBreakdownSectionId =
  | "character"
  | "user_persona"
  | "user_profile"
  | "lore"
  | "memory"
  | "history"
  | "generation_instruction"
  | "formatting";

export interface PromptBreakdownSectionDTO {
  id: PromptBreakdownSectionId;
  tokenEstimate: number;
  characterCount: number;
  itemCount: number;
}

export interface PromptBreakdownDTO {
  promptTokens: number;
  promptTokensEstimated: boolean;
  includedMessageCount: number;
  sections: PromptBreakdownSectionDTO[];
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
  generationMetadata: GenerationMetadataDTO | null;
  variantMetadata: Array<GenerationMetadataDTO | null>;
  promptBreakdown: PromptBreakdownDTO | null;
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
  deletedAt: string | null;
  currentRevision: number;
  lastActor: MemoryActor | null;
  lastAction: MemoryAction | null;
  sourceMessageIds: string[];
  embeddingModel?: string | null;
  embeddingSource?: string | null;
  embeddingDimensions?: number | null;
  embeddingStatus?: "ready" | "stale" | "failed" | "unavailable";
  embeddingUpdatedAt?: string | null;
  lastMatchedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type MemoryActor = "user" | "automatic_memory" | "agent_confirmed" | "timeline_cleanup" | "restore";

export type MemoryAction =
  | "baseline"
  | "automatic_create"
  | "automatic_update"
  | "automatic_disable"
  | "manual_create"
  | "manual_edit"
  | "manual_enable"
  | "manual_disable"
  | "manual_delete"
  | "agent_confirmed_create"
  | "timeline_disable"
  | "restore"
  | "undo_create"
  | "undo_update"
  | "undo_disable";

export interface MemorySnapshotDTO {
  title: string;
  content: string;
  keywords: string[];
  importance: number;
  enabled: boolean;
  sourceMessageIds: string[];
}

export interface MemorySourceReferenceDTO {
  messageId: string;
  available: boolean;
}

export interface MemoryRevisionDTO {
  id: string;
  memoryId: string;
  chatId: string;
  revision: number;
  action: MemoryAction;
  actor: MemoryActor;
  beforeSnapshot: MemorySnapshotDTO | null;
  afterSnapshot: MemorySnapshotDTO | null;
  sourceMessageIds: string[];
  sources: MemorySourceReferenceDTO[];
  operationId: string | null;
  reasonCode: string;
  isCurrent: boolean;
  createdAt: string;
}

export type MemoryOperationStatus = "running" | "succeeded" | "partial" | "failed";
export type MemoryOperationType = "automatic_maintenance" | "operation_undo";

export interface MemoryOperationDTO {
  id: string;
  chatId: string;
  type: MemoryOperationType;
  actor: MemoryActor;
  status: MemoryOperationStatus;
  startedAt: string;
  completedAt: string | null;
  created: number;
  updated: number;
  disabled: number;
  unchanged: number;
  sourceMessageIds: string[];
  sources: MemorySourceReferenceDTO[];
  errorCode: string | null;
  undoneAt: string | null;
  undoOperationId: string | null;
}

export interface MemoryRestorePreviewDTO {
  memoryId: string;
  revision: number;
  expectedCurrentRevision: number;
  current: MemorySnapshotDTO | null;
  restored: MemorySnapshotDTO;
  sources: MemorySourceReferenceDTO[];
}

export interface MemoryRestoreResultDTO {
  memory: ChatMemoryDTO;
  revision: MemoryRevisionDTO;
}

export type MemoryUndoConflictAction = "skip" | "restore";

export interface MemoryUndoPreviewItemDTO {
  memoryId: string;
  operationRevision: number;
  currentRevision: number;
  effect: "retire_created" | "restore_updated" | "restore_disabled";
  conflict: boolean;
  current: MemorySnapshotDTO | null;
  restored: MemorySnapshotDTO | null;
}

export interface MemoryUndoPreviewDTO {
  operation: MemoryOperationDTO;
  items: MemoryUndoPreviewItemDTO[];
  conflicts: number;
  canExecute: boolean;
}

export interface MemoryUndoResolutionDTO {
  memoryId: string;
  expectedCurrentRevision: number;
  action: MemoryUndoConflictAction;
}

export interface MemoryUndoResultDTO {
  operationId: string;
  undoOperationId: string;
  restored: number;
  retired: number;
  skippedConflicts: number;
}

export type ProfileSummaryActor = "user" | "automatic_memory" | "restore";
export type ProfileSummaryAction = "baseline" | "automatic_update" | "manual_edit" | "manual_clear" | "restore";

export interface ProfileSummaryRevisionDTO {
  id: string;
  chatId: string;
  revision: number;
  action: ProfileSummaryAction;
  actor: ProfileSummaryActor;
  summary: string;
  sourceMessageIds: string[];
  sources: MemorySourceReferenceDTO[];
  isCurrent: boolean;
  createdAt: string;
}

export interface ProfileSummaryRestorePreviewDTO {
  chatId: string;
  revision: number;
  expectedCurrentRevision: number;
  currentSummary: string;
  restoredSummary: string;
  sources: MemorySourceReferenceDTO[];
}

export interface ChatMemoryInput {
  title: string;
  content: string;
  keywords?: string[];
  importance?: number;
  enabled?: boolean;
  sourceMessageIds?: string[];
  actor?: "user" | "agent_confirmed";
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
  embeddingSource?: string | null;
  embeddingDimensions?: number | null;
  embeddingStatus?: "ready" | "stale" | "failed" | "unavailable";
  embeddingUpdatedAt?: string | null;
  lastMatchedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface ChatMemoryUpdateSummaryDTO {
  chatId: string;
  operationId: string | null;
  created: number;
  updated: number;
  disabled: number;
  memoryUpdatedAt: string | null;
}

export type ChatAgentMode =
  | "scene_summary"
  | "next_steps"
  | "reply_drafts"
  | "memory_lore_candidates"
  | "continuity_check"
  | "character_consistency";

export type ChatAgentActionKind = "reply_draft" | "memory_candidate" | "lore_candidate";

export interface ChatAgentActionDTO {
  id: string;
  kind: ChatAgentActionKind;
  title: string;
  content: string;
  keywords?: string[];
}

export interface ChatAgentDraftRequestDTO {
  mode: ChatAgentMode;
  focus?: string;
}

export interface ChatAgentDraftDTO {
  mode: ChatAgentMode;
  title: string;
  content: string;
  createdAt: string;
  actions: ChatAgentActionDTO[];
  matchedLoreEntries: MatchedLoreEntryDTO[];
  matchedMemoryEntries: MatchedMemoryDTO[];
  sourceMessageIds: string[];
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
  added: number;
  updated: number;
  skipped: number;
  conflictsResolved: number;
  recoveryPointId: string | null;
  completedAt: string;
}

export type BackupEntityType = "settings" | "characters" | "chats" | "messages" | "memories" | "memoryRevisions" | "memoryOperations" | "profileSummaryRevisions";
export type BackupConflictAction = "keep_existing" | "use_incoming" | "skip";

export interface BackupImpactCountsDTO {
  added: number;
  updated: number;
  skipped: number;
  conflicts: number;
  invalid: number;
  deleted: number;
}

export interface BackupConflictDTO {
  key: string;
  entity: BackupEntityType;
  id: string;
}

export interface BackupValidationIssueDTO {
  entity: BackupEntityType | "backup";
  index: number | null;
  code: "schema_version" | "invalid_record" | "duplicate_id" | "missing_reference";
  message: string;
}

export interface BackupPreviewDTO {
  previewId: string;
  schemaVersion: 1 | null;
  mode: "merge" | "replace";
  sourceExportedAt: string | null;
  counts: BackupImpactCountsDTO;
  byEntity: Record<BackupEntityType, BackupImpactCountsDTO>;
  conflicts: BackupConflictDTO[];
  issues: BackupValidationIssueDTO[];
  canExecute: boolean;
  requiresRecoveryPoint: boolean;
}

export interface BackupConflictResolutionDTO {
  key: string;
  action: BackupConflictAction;
}

export interface RecoveryPointSummaryDTO {
  settings: number;
  characters: number;
  chats: number;
  messages: number;
  memories: number;
  memoryRevisions?: number;
  memoryOperations?: number;
  profileSummaryRevisions?: number;
}

export interface RecoveryPointDTO {
  id: string;
  reason: "before_import" | "before_restore";
  createdAt: string;
  summary: RecoveryPointSummaryDTO;
}

export interface RecoveryPointRestoreResultDTO {
  recoveryPointId: string;
  safetyRecoveryPointId: string;
  completedAt: string;
  summary: BackupImportSummaryDTO;
}

export type AppPlatform = "web" | "windows" | "android" | "server";
export type AppBuildType = "development" | "preview" | "release";
export type DatabaseMigrationStatus = "ready" | "upgraded" | "failed" | "too_new" | "unknown";

export interface AppInfoDTO {
  appVersion: string;
  schemaVersion: string;
  schemaChecksum: string;
  platform: AppPlatform;
  buildType: AppBuildType;
  buildCommit: string | null;
  migration: {
    status: DatabaseMigrationStatus;
    previousAppVersion: string | null;
    previousSchemaVersion: string | null;
    appliedCount: number;
    recoveryCreated: boolean;
  };
  update: {
    capability: "desktop" | "external_store" | "disabled";
    externalUrl: string | null;
  };
}

export interface ChatArchiveDTO {
  archiveVersion: 1;
  exportedAt: string;
  chat: ChatDTO;
  character: BackupCharacterDTO | null;
  messages: MessageDTO[];
  memories: ChatMemoryDTO[];
  memoryRevisions?: MemoryRevisionDTO[];
  memoryOperations?: MemoryOperationDTO[];
  profileSummaryRevisions?: ProfileSummaryRevisionDTO[];
}

export interface ChatArchiveImportDTO {
  archive: ChatArchiveDTO;
  title?: string;
}

export type LanSyncDirection = "pull" | "push";

export interface LanSyncRequestDTO {
  peerBaseUrl: string;
  mode: "merge" | "replace";
  phase: "preview" | "execute";
  previewId?: string;
  conflictResolutions?: BackupConflictResolutionDTO[];
}

export interface LanSyncSummaryDTO {
  direction: LanSyncDirection;
  mode: "merge" | "replace";
  peerBaseUrl: string;
  peerExportedAt: string | null;
  phase: "preview" | "execute";
  completedAt: string | null;
  preview: BackupPreviewDTO;
  summary: BackupImportSummaryDTO | null;
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
      overrideHardBudget?: boolean;
    }
  | {
      type: "regenerate";
      requestId: string;
      messageId: string;
      guidance?: string;
      overrideHardBudget?: boolean;
    }
  | {
      type: "continue";
      requestId: string;
      messageId: string;
      overrideHardBudget?: boolean;
    }
  | {
      type: "resend";
      requestId: string;
      messageId: string;
      overrideHardBudget?: boolean;
    }
  | {
      type: "stop";
      requestId: string;
    }
  | {
      type: "status";
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
      type: "generation_status";
      request: ModelRequestDTO;
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
      type: "generation_retrying";
      requestId: string;
      attempt: number;
      retryAfterMs: number;
      error: ModelErrorDTO;
    }
  | {
      type: "generation_fallback";
      requestId: string;
      fromProviderId: string;
      fromModelId: string;
      toProviderId: string;
      toModelId: string;
      reason: ModelErrorCode;
    }
  | {
      type: "error";
      requestId?: string;
      error: string;
      modelError?: ModelErrorDTO;
    };
