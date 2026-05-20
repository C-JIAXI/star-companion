export declare const APP_NAME = "Local Roleplay Platform";
export type ChatMode = "single" | "group";
export type MessageRole = "user" | "assistant" | "system";
export interface UserSettingsDTO {
    id: string;
    activeProvider: string;
    apiBaseUrl: string;
    model: string;
    temperature: number;
    maxTokens: number;
    topP: number;
    createdAt: string;
    updatedAt: string;
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
