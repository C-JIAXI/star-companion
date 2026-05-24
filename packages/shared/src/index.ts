export const APP_NAME = "Local Roleplay Platform";

export type ChatMode = "single";
export type MessageRole = "user" | "assistant" | "system";
export type AppLanguage = "zh-CN" | "en";

export interface ModelPreset {
  id: string;
  label: string;
  provider: string;
  apiBaseUrl: string;
  key?: string;
  model: string;
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
  models: ModelPreset[];
  userProfileSummary: string;
  autoSummarizeUser: boolean;
  userProfileUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PublicUserSettingsDTO extends UserSettingsDTO {
  hasApiKey: boolean;
}

export interface CharacterLoreEntryDTO {
  id: string;
  keys: string[];
  content: string;
  priority: number;
  triggerMode: LoreTriggerMode;
  alwaysActive: boolean;
  enabled: boolean;
}

export interface CharacterDTO {
  id: string;
  name: string;
  avatar: string | null;
  prefix: string;
  prompt: string;
  suffix: string;
  relationship: string;
  loreEntries: CharacterLoreEntryDTO[];
  createdAt: string;
  updatedAt: string;
}

export interface ChatDTO {
  id: string;
  title: string;
  mode: ChatMode;
  characterIds: string[];
  memoryTurns: number;
  userProfileSummary: string;
  userProfileUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatWithMessagesDTO extends ChatDTO {
  messages: MessageDTO[];
}

export interface MessageDTO {
  id: string;
  chatId: string;
  role: MessageRole;
  characterId: string | null;
  content: string;
  variants: string[];
  activeVariantIndex: number;
  tokenUsage: TokenUsageDTO | null;
  loreMatches: MatchedLoreEntryDTO[];
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

export interface MatchedLoreEntryDTO {
  id: string;
  characterId: string;
  characterName?: string;
  keys: string[];
  content: string;
  priority: number;
  triggerMode: LoreTriggerMode;
  alwaysActive: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BackupDTO {
  schemaVersion: 1;
  exportedAt: string;
  settings: UserSettingsDTO | null;
  characters: CharacterDTO[];
  chats: ChatDTO[];
  messages: MessageDTO[];
}

export interface BackupImportSummaryDTO {
  mode: "merge" | "replace";
  characters: number;
  chats: number;
  messages: number;
  settingsImported: boolean;
}

export type GenerationClientMessage =
  | {
      type: "generate";
      requestId: string;
      chatId: string;
      content: string;
      characterId?: string | null;
      targetCharacterId?: string | null;
    }
  | {
      type: "regenerate";
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
