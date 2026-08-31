import type {
  CharacterCardDTO,
  CharacterBatchTagsRequestDTO,
  CharacterBatchTagsResultDTO,
  CharacterDTO,
  CharacterDraftRequestDTO,
  CharacterDraftResponseDTO,
  CharacterDraftTask,
  CharacterSortMode,
  CharacterExportMode,
  CharacterLoreEntryDTO,
  CharacterVisibility,
  ChatAgentDraftDTO,
  ChatAgentActionDTO,
  ChatAgentDraftRequestDTO,
  ChatAgentMode,
  ChatBatchArchiveRequestDTO,
  ChatBatchArchiveResultDTO,
  ChatBatchFolderRequestDTO,
  ChatBatchFolderResultDTO,
  ChatRenameFolderRequestDTO,
  ChatRenameFolderResultDTO,
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
  AppearancePreferencesDTO,
  AiModelCapability,
  AiModuleId,
  AppInfoDTO,
  AvailableModelsDTO,
  BackupDTO,
  BackupConflictAction,
  BackupConflictResolutionDTO,
  BackupImportSummaryDTO,
  BackupPreviewDTO,
  ImageGenerationDTO,
  ImageGenerationRequestDTO,
  LoreEntryScope,
  LoreTriggerMode,
  LanSyncDirection,
  LanSyncInfoDTO,
  LanSyncRequestDTO,
  LanSyncSummaryDTO,
  ModuleModelPreferencesDTO,
  ModelReliabilitySettingsDTO,
  UsageBudgetSettingsDTO,
  UsageSummaryDTO,
  CostPreviewDTO,
  MatchedLoreEntryDTO,
  MatchedMemoryDTO,
  MemoryOperationDTO,
  MemoryRestorePreviewDTO,
  MemoryRestoreResultDTO,
  MemoryRevisionDTO,
  MemorySnapshotDTO,
  MemoryUndoPreviewDTO,
  MemoryUndoResolutionDTO,
  MemoryUndoResultDTO,
  ProfileSummaryRestorePreviewDTO,
  ProfileSummaryRevisionDTO,
  MessageDTO,
  MessageAttachmentDTO,
  DraftImageAttachmentDTO,
  MessageRole,
  PromptBreakdownDTO,
  PromptBreakdownSectionId,
  ProviderModel,
  ProviderProfile,
  PaginatedCharactersDTO,
  PublicUserSettingsDTO,
  ReadinessDTO,
  ReadinessActionCode,
  ReadinessOverallStatusCode,
  ConfigurationDiagnosticIssueDTO,
  ConnectionDiagnosticDTO,
  RecoveryPointDTO,
  RecoveryPointRestoreResultDTO,
  StorageCleanupAction,
  StorageCleanupPlanDTO,
  StorageCleanupResultDTO,
  StorageDeepScanDTO,
  StorageHealthIssueDTO,
  StorageHealthSnapshotDTO,
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
  folder?: string;
  backgroundUrl?: string;
  memoryTurns?: number;
  autoMemoryEnabled?: boolean;
  userPersona?: string;
  userAvatar?: string;
  userProfileSummary?: string;
};

export type MessageInput = {
  chatId: string;
  role: MessageRole;
  characterId?: string | null;
  content: string;
  draftId?: string;
  contextIncluded?: boolean;
  isBookmarked?: boolean;
  variants?: string[];
  activeVariantIndex?: number;
  memoryMatches?: MatchedMemoryDTO[];
  replaceAttachments?: boolean;
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
  modelReliability?: ModelReliabilitySettingsDTO;
  usageBudgets?: UsageBudgetSettingsDTO;
  usageTimezone?: string;
  userPersonaPresets?: UserPersonaPresetDTO[];
  autoSummarizeUser?: boolean;
  showMessageAvatars?: boolean;
  showMessageTimestamps?: boolean;
  appearancePreferences?: AppearancePreferencesDTO;
  ttsVoice?: string;
  ttsPlaybackRate?: number;
  ttsAutoPlay?: boolean;
  userProfileSummary?: string;
};

export type {
  ModelReliabilitySettingsDTO,
  UsageBudgetSettingsDTO,
  UsageSummaryDTO,
  CostPreviewDTO,
  CharacterCardDTO,
  CharacterBatchTagsRequestDTO,
  CharacterBatchTagsResultDTO,
  CharacterDTO,
  CharacterDraftRequestDTO,
  CharacterDraftResponseDTO,
  CharacterDraftTask,
  CharacterSortMode,
  CharacterExportMode,
  CharacterLoreEntryDTO,
  CharacterVisibility,
  ChatAgentDraftDTO,
  ChatAgentActionDTO,
  ChatAgentDraftRequestDTO,
  ChatAgentMode,
  ChatBatchArchiveRequestDTO,
  ChatBatchArchiveResultDTO,
  ChatBatchFolderRequestDTO,
  ChatBatchFolderResultDTO,
  ChatRenameFolderRequestDTO,
  ChatRenameFolderResultDTO,
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
  AppearancePreferencesDTO,
  AiModelCapability,
  AiModuleId,
  AppInfoDTO,
  AvailableModelsDTO,
  BackupDTO,
  BackupConflictAction,
  BackupConflictResolutionDTO,
  BackupImportSummaryDTO,
  BackupPreviewDTO,
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
  MemoryOperationDTO,
  MemoryRestorePreviewDTO,
  MemoryRestoreResultDTO,
  MemoryRevisionDTO,
  MemorySnapshotDTO,
  MemoryUndoPreviewDTO,
  MemoryUndoResolutionDTO,
  MemoryUndoResultDTO,
  ProfileSummaryRestorePreviewDTO,
  ProfileSummaryRevisionDTO,
  MessageDTO,
  MessageAttachmentDTO,
  DraftImageAttachmentDTO,
  MessageRole,
  PromptBreakdownDTO,
  PromptBreakdownSectionId,
  ProviderModel,
  ProviderProfile,
  PaginatedCharactersDTO,
  PublicUserSettingsDTO,
  ReadinessDTO,
  ReadinessActionCode,
  ReadinessOverallStatusCode,
  ConfigurationDiagnosticIssueDTO,
  ConnectionDiagnosticDTO,
  RecoveryPointDTO,
  RecoveryPointRestoreResultDTO,
  StorageCleanupAction,
  StorageCleanupPlanDTO,
  StorageCleanupResultDTO,
  StorageDeepScanDTO,
  StorageHealthIssueDTO,
  StorageHealthSnapshotDTO,
  QuickReplyDTO,
  TokenUsageDTO,
  UserPersonaPresetDTO,
  VoiceSpeechDTO,
  VoiceSpeechRequestDTO,
  VoiceTranscriptionDTO,
  VoiceTranscriptionRequestDTO
};
