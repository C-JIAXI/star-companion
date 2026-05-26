import type {
  CharacterCardDTO,
  CharacterDTO,
  CharacterExportMode,
  CharacterLoreEntryDTO,
  CharacterVisibility,
  ChatDTO,
  ChatMode,
  ChatWithMessagesDTO,
  GenerationClientMessage,
  GenerationServerMessage,
  AppLanguage,
  BackupDTO,
  BackupImportSummaryDTO,
  LoreTriggerMode,
  MatchedLoreEntryDTO,
  MessageDTO,
  MessageRole,
  ModelPreset,
  PaginatedCharactersDTO,
  PublicUserSettingsDTO,
  TokenUsageDTO
} from "@local-roleplay/shared";

export type AppSection = "chat" | "characters" | "settings";

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
  prefix?: string;
  prompt?: string;
  suffix?: string;
  htmlCss?: string;
  loreEntries?: (Omit<CharacterLoreEntryDTO, "id"> & { id?: string })[];
};

export type CharacterCardImportInput =
  | CharacterCardDTO
  | (Partial<CharacterInput> & {
      name: string;
      description?: string;
      scenario?: string;
      systemPrompt?: string;
    });

export type ChatInput = {
  title: string;
  mode: ChatMode;
  characterIds: string[];
  memoryTurns?: number;
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
  models: ModelPreset[];
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
  ChatDTO,
  ChatMode,
  ChatWithMessagesDTO,
  GenerationClientMessage,
  GenerationServerMessage,
  AppLanguage,
  BackupDTO,
  BackupImportSummaryDTO,
  LoreTriggerMode,
  MatchedLoreEntryDTO,
  MessageDTO,
  MessageRole,
  ModelPreset,
  PaginatedCharactersDTO,
  PublicUserSettingsDTO,
  TokenUsageDTO
};
