export const APP_NAME = "Local Roleplay Platform";

export type ChatMode = "single" | "group";
export type MessageRole = "user" | "assistant" | "system";
export type AppLanguage = "zh-CN" | "en";

export interface UserSettingsDTO {
  id: string;
  activeProvider: string;
  apiBaseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  topP: number;
  language: AppLanguage;
  createdAt: string;
  updatedAt: string;
}

export interface PublicUserSettingsDTO extends UserSettingsDTO {
  hasApiKey: boolean;
}

export interface CharacterDTO {
  id: string;
  name: string;
  avatar: string | null;
  description: string;
  personality: string;
  scenario: string;
  firstMessage: string;
  exampleDialog: string;
  systemPrompt: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ChatDTO {
  id: string;
  title: string;
  mode: ChatMode;
  characterIds: string[];
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
  createdAt: string;
  updatedAt: string;
}

export interface LorebookDTO {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface LoreEntryDTO {
  id: string;
  lorebookId: string;
  keys: string[];
  content: string;
  priority: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LorebookWithEntriesDTO extends LorebookDTO {
  entries: LoreEntryDTO[];
}

export type GenerationClientMessage =
  | {
      type: "generate";
      requestId: string;
      chatId: string;
      content: string;
      characterId?: string | null;
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
