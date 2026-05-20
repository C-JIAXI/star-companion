import type {
  CharacterDTO,
  ChatDTO,
  ChatMode,
  ChatWithMessagesDTO,
  GenerationClientMessage,
  GenerationServerMessage,
  AppLanguage,
  LoreEntryDTO,
  LorebookDTO,
  LorebookWithEntriesDTO,
  MessageDTO,
  MessageRole,
  PublicUserSettingsDTO
} from "@local-roleplay/shared";

export type AppSection = "chat" | "characters" | "lore" | "settings";

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
  personality?: string;
  scenario?: string;
  firstMessage?: string;
  exampleDialog?: string;
  systemPrompt?: string;
  tags?: string[];
};

export type ChatInput = {
  title: string;
  mode: ChatMode;
  characterIds: string[];
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
};

export type LorebookInput = {
  name: string;
  description?: string;
};

export type LoreEntryInput = {
  keys: string[];
  content: string;
  priority: number;
  enabled: boolean;
};

export type {
  CharacterDTO,
  ChatDTO,
  ChatMode,
  ChatWithMessagesDTO,
  GenerationClientMessage,
  GenerationServerMessage,
  AppLanguage,
  LoreEntryDTO,
  LorebookDTO,
  LorebookWithEntriesDTO,
  MessageDTO,
  PublicUserSettingsDTO
};
