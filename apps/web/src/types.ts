import type {
  CharacterCardDTO,
  CharacterDTO,
  CharacterExportMode,
  CharacterLoreEntryDTO,
  CharacterVisibility,
  ChatMemoryDTO,
  ChatMemoryInput,
  ChatDTO,
  ChatWithMessagesDTO,
  GenerationClientMessage,
  GenerationServerMessage,
  AppLanguage,
  AvailableModelsDTO,
  BackupDTO,
  BackupImportSummaryDTO,
  LoreEntryScope,
  LoreTriggerMode,
  MatchedLoreEntryDTO,
  MatchedMemoryDTO,
  MessageDTO,
  MessageRole,
  ProviderModel,
  ProviderProfile,
  PaginatedCharactersDTO,
  PublicUserSettingsDTO,
  QuickReplyDTO,
  TokenUsageDTO
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
  prefix?: string;
  prompt?: string;
  suffix?: string;
  htmlCss?: string;
  openingHtml?: string;
  loreEntries?: (Omit<CharacterLoreEntryDTO, "id"> & { id?: string })[];
  quickReplies?: (Omit<QuickReplyDTO, "id"> & { id?: string })[];
};

export type CharacterCardImportInput = CharacterCardDTO;

export type ChatInput = {
  title: string;
  characterId: string;
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
  autoSummarizeUser?: boolean;
  showMessageAvatars?: boolean;
  userProfileSummary?: string;
};

export type {
  CharacterCardDTO,
  CharacterDTO,
  CharacterExportMode,
  CharacterLoreEntryDTO,
  CharacterVisibility,
  ChatMemoryDTO,
  ChatMemoryInput,
  ChatDTO,
  ChatWithMessagesDTO,
  GenerationClientMessage,
  GenerationServerMessage,
  AppLanguage,
  AvailableModelsDTO,
  BackupDTO,
  BackupImportSummaryDTO,
  LoreEntryScope,
  LoreTriggerMode,
  MatchedLoreEntryDTO,
  MatchedMemoryDTO,
  MessageDTO,
  MessageRole,
  ProviderModel,
  ProviderProfile,
  PaginatedCharactersDTO,
  PublicUserSettingsDTO,
  QuickReplyDTO,
  TokenUsageDTO
};
