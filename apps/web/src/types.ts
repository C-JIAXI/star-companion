import type {
  CharacterCardDTO,
  CharacterBatchTagsRequestDTO,
  CharacterBatchTagsResultDTO,
  CharacterDTO,
  CharacterSortMode,
  CharacterExportMode,
  CharacterLoreEntryDTO,
  CharacterVisibility,
  ChatAgentDraftDTO,
  ChatAgentDraftRequestDTO,
  ChatAgentMode,
  ChatBatchArchiveRequestDTO,
  ChatBatchArchiveResultDTO,
  ChatBatchPermanentDeleteRequestDTO,
  ChatBatchPermanentDeleteResultDTO,
  ChatBatchTrashRequestDTO,
  ChatBatchTrashResultDTO,
  ChatBranchRequestDTO,
  ChatArchiveDTO,
  ChatArchiveImportDTO,
  GlobalChatMessageSearchDTO,
  ChatMessageSearchDTO,
  ChatMemoryDTO,
  ChatMemoryInput,
  ChatDTO,
  ChatTitleSuggestionDTO,
  ChatWithMessagesDTO,
  GenerationClientMessage,
  GenerationServerMessage,
  AppLanguage,
  AiModelCapability,
  AiModuleId,
  AvailableModelsDTO,
  BackupDTO,
  BackupImportSummaryDTO,
  ImageGenerationDTO,
  ImageGenerationRequestDTO,
  LoreEntryScope,
  LoreTriggerMode,
  LanSyncDirection,
  LanSyncInfoDTO,
  LanSyncRequestDTO,
  LanSyncSummaryDTO,
  ModuleModelPreferencesDTO,
  MatchedLoreEntryDTO,
  MatchedMemoryDTO,
  MessageDTO,
  MessageRole,
  ProviderModel,
  ProviderProfile,
  PaginatedCharactersDTO,
  PublicUserSettingsDTO,
  QuickReplyDTO,
  TokenUsageDTO,
  UserPersonaPresetDTO,
  VoiceSpeechDTO,
  VoiceSpeechRequestDTO,
  VoiceTranscriptionDTO,
  VoiceTranscriptionRequestDTO
} from "@local-roleplay/shared";

export type AppSection = "chat" | "docs" | "characters" | "settings";

export type ApiEnvelope<T> = {
  ok: boolean;
  data: T;
};

export type ApiErrorEnvelope = {
  ok: false;
  error: string;
  details?: unknown;
};

export type CharacterInput = {
  name: string;
  avatar?: string | null;
  description?: string;
  tags?: string[];
  prefix?: string;
  prompt?: string;
  suffix?: string;
  htmlCss?: string;
  openingHtml?: string;
  loreEntries?: (Omit<CharacterLoreEntryDTO, "id"> & { id?: string })[];
  quickReplies?: (Omit<QuickReplyDTO, "id"> & { id?: string })[];
  isFavorite?: boolean;
};

export type CharacterCardImportInput = CharacterCardDTO;

export type ChatInput = {
  title: string;
  characterId: string;
  isPinned?: boolean;
  isArchived?: boolean;
  backgroundUrl?: string;
  memoryTurns?: number;
  autoMemoryEnabled?: boolean;
  userPersona?: string;
  userProfileSummary?: string;
};

export type MessageInput = {
  chatId: string;
  role: MessageRole;
  characterId?: string | null;
  content: string;
  contextIncluded?: boolean;
  isBookmarked?: boolean;
  variants?: string[];
  activeVariantIndex?: number;
  memoryMatches?: MatchedMemoryDTO[];
};

export type SettingsInput = {
  activeProvider: string;
  apiBaseUrl: string;
  apiKey?: string;
  model: string;
  temperature: number;
  maxTokens: number;
  topP: number;
  language: AppLanguage;
  providers: ProviderProfile[];
  activeProviderId: string;
  activeModelId: string;
  moduleModelPreferences?: ModuleModelPreferencesDTO;
  userPersonaPresets?: UserPersonaPresetDTO[];
  autoSummarizeUser?: boolean;
  showMessageAvatars?: boolean;
  showMessageTimestamps?: boolean;
  ttsVoice?: string;
  ttsPlaybackRate?: number;
  ttsAutoPlay?: boolean;
  userProfileSummary?: string;
};

export type {
  CharacterCardDTO,
  CharacterBatchTagsRequestDTO,
  CharacterBatchTagsResultDTO,
  CharacterDTO,
  CharacterSortMode,
  CharacterExportMode,
  CharacterLoreEntryDTO,
  CharacterVisibility,
  ChatAgentDraftDTO,
  ChatAgentDraftRequestDTO,
  ChatAgentMode,
  ChatBatchArchiveRequestDTO,
  ChatBatchArchiveResultDTO,
  ChatBatchPermanentDeleteRequestDTO,
  ChatBatchPermanentDeleteResultDTO,
  ChatBatchTrashRequestDTO,
  ChatBatchTrashResultDTO,
  ChatBranchRequestDTO,
  ChatArchiveDTO,
  ChatArchiveImportDTO,
  GlobalChatMessageSearchDTO,
  ChatMessageSearchDTO,
  ChatMemoryDTO,
  ChatMemoryInput,
  ChatDTO,
  ChatTitleSuggestionDTO,
  ChatWithMessagesDTO,
  GenerationClientMessage,
  GenerationServerMessage,
  AppLanguage,
  AiModelCapability,
  AiModuleId,
  AvailableModelsDTO,
  BackupDTO,
  BackupImportSummaryDTO,
  ImageGenerationDTO,
  ImageGenerationRequestDTO,
  LoreEntryScope,
  LoreTriggerMode,
  LanSyncDirection,
  LanSyncInfoDTO,
  LanSyncRequestDTO,
  LanSyncSummaryDTO,
  ModuleModelPreferencesDTO,
  MatchedLoreEntryDTO,
  MatchedMemoryDTO,
  MessageDTO,
  MessageRole,
  ProviderModel,
  ProviderProfile,
  PaginatedCharactersDTO,
  PublicUserSettingsDTO,
  QuickReplyDTO,
  TokenUsageDTO,
  UserPersonaPresetDTO,
  VoiceSpeechDTO,
  VoiceSpeechRequestDTO,
  VoiceTranscriptionDTO,
  VoiceTranscriptionRequestDTO
};
