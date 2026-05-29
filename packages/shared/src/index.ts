export const APP_NAME = "Local Roleplay Platform";

export type ChatMode = "single";
export type MessageRole = "user" | "assistant" | "system";
export type AppLanguage = "zh-CN" | "en";
export type CharacterVisibility = "public" | "private";

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
  showMessageAvatars: boolean;
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
  prefix: string;
  prompt: string;
  suffix: string;
  htmlCss: string;
  loreEntries: CharacterLoreEntryDTO[];
  quickReplies: QuickReplyDTO[];
}

export interface CharacterDTO {
  id: string;
  name: string;
  avatar: string | null;
  description: string;
  prefix: string;
  prompt: string;
  suffix: string;
  htmlCss: string;
  loreEntries: CharacterLoreEntryDTO[];
  quickReplies: QuickReplyDTO[];
  visibility: CharacterVisibility;
  canViewPrompt: boolean;
  createdAt: string;
  updatedAt: string;
}

export type CharacterExportMode = CharacterVisibility;

export interface PublicCharacterCardDTO {
  schemaVersion: 1;
  format: "character-card";
  visibility: "public";
  exportedAt: string;
  character: CharacterCardContentDTO;
}

export interface PrivateCharacterCardDTO {
  schemaVersion: 1;
  format: "character-card";
  visibility: "private";
  exportedAt: string;
  character: Pick<CharacterCardContentDTO, "name" | "avatar">;
  protectedPayload: {
    version: 1;
    algorithm: "aes-256-gcm";
    salt: string;
    iv: string;
    tag: string;
    ciphertext: string;
    creatorFingerprint?: string;
  };
}

export type CharacterCardDTO = PublicCharacterCardDTO | PrivateCharacterCardDTO;

export interface PaginatedCharactersDTO {
  items: CharacterDTO[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
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
  } catch {
    // Legacy free-form userPersona text falls through to prompt body.
  }

  return {
    prefix: "",
    prompt: raw,
    suffix: ""
  };
};

export const hasUserCustomConfigContent = (value?: Partial<UserCustomConfigDTO> | null) => {
  const normalized = normalizeUserCustomConfig(value);
  return Boolean(
    normalized.prefix.trim() || normalized.prompt.trim() || normalized.suffix.trim()
  );
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

export interface ChatDTO {
  id: string;
  title: string;
  mode: ChatMode;
  characterIds: string[];
  messageCount: number;
  memoryTurns: number;
  userPersona: string;
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
