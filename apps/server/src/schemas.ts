import { z } from "zod";

export const idSchema = z.string().min(1);

const stringArraySchema = z.array(z.string().trim().min(1)).default([]);

const tokenUsageSchema = z.object({
  promptTokens: z.number().int().min(0),
  completionTokens: z.number().int().min(0),
  totalTokens: z.number().int().min(0),
  estimated: z.boolean().default(false)
});

const loreMatchSchema = z.object({
  id: idSchema,
  characterId: idSchema,
  characterName: z.string().optional(),
  keys: stringArraySchema,
  content: z.string(),
  priority: z.number().int(),
  triggerMode: z.enum(["user", "assistant", "both"]).default("both"),
  alwaysActive: z.boolean().default(false),
  enabled: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

const loreEntrySchema = z.object({
  id: z.string().min(1).optional(),
  keys: stringArraySchema,
  content: z.string().min(1),
  priority: z.number().int().default(0),
  triggerMode: z.enum(["user", "assistant", "both"]).default("both"),
  alwaysActive: z.boolean().default(false),
  enabled: z.boolean().default(true)
});

const loreEntriesSchema = z.array(loreEntrySchema).default([]);

export const characterCreateSchema = z.object({
  name: z.string().trim().min(1),
  avatar: z.string().trim().nullable().optional(),
  prefix: z.string().default(""),
  prompt: z.string().default(""),
  suffix: z.string().default(""),
  relationship: z.string().default(""),
  loreEntries: loreEntriesSchema
});

export const characterUpdateSchema = characterCreateSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const chatCreateSchema = z.object({
  title: z.string().trim().min(1),
  mode: z.enum(["single"]).default("single"),
  characterIds: stringArraySchema,
  memoryTurns: z.number().int().min(1).max(50).default(12),
  userProfileSummary: z.string().default("")
});

export const chatUpdateSchema = chatCreateSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const messageCreateSchema = z.object({
  chatId: idSchema,
  role: z.enum(["user", "assistant", "system"]),
  characterId: idSchema.nullable().optional(),
  content: z.string(),
  variants: z.array(z.string()).default([]),
  activeVariantIndex: z.number().int().min(0).default(0),
  tokenUsage: tokenUsageSchema.nullable().optional(),
  loreMatches: z.array(loreMatchSchema).nullable().optional()
});

export const messageUpdateSchema = z
  .object({
    role: z.enum(["user", "assistant", "system"]).optional(),
    characterId: idSchema.nullable().optional(),
    content: z.string().optional(),
    variants: z.array(z.string()).optional(),
    activeVariantIndex: z.number().int().min(0).optional(),
    tokenUsage: tokenUsageSchema.nullable().optional(),
    loreMatches: z.array(loreMatchSchema).nullable().optional()
  })
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const messageListQuerySchema = z.object({
  chatId: idSchema.optional()
});

export const settingsUpdateSchema = z.object({
  activeProvider: z.string().trim().min(1).default("openai-compatible"),
  apiBaseUrl: z.string().trim().url(),
  apiKey: z.string().optional(),
  model: z.string().trim().min(1),
  temperature: z.number().min(0).max(2),
  maxTokens: z.number().int().min(1).max(200000),
  topP: z.number().min(0).max(1),
  language: z.enum(["zh-CN", "en"]).default("zh-CN"),
  autoSummarizeUser: z.boolean().optional(),
  userProfileSummary: z.string().max(4000).optional(),
  models: z
    .array(
      z.object({
        id: z.string().min(1),
        label: z.string().min(1),
        provider: z.string().min(1),
        apiBaseUrl: z.string().url(),
        key: z.string().optional(),
        model: z.string().min(1)
      })
    )
    .default([])
});

export const userProfileUpdateSchema = z.object({
  userProfileSummary: z.string().max(4000).default(""),
  autoSummarizeUser: z.boolean().optional()
});

export const generationRequestSchema = z.object({
  type: z.literal("generate"),
  requestId: z.string().min(1),
  chatId: idSchema,
  content: z.string().trim().min(1),
  characterId: idSchema.nullable().optional(),
  targetCharacterId: idSchema.nullable().optional()
});

export const regenerateRequestSchema = z.object({
  type: z.literal("regenerate"),
  requestId: z.string().min(1),
  messageId: idSchema
});

export const stopGenerationRequestSchema = z.object({
  type: z.literal("stop"),
  requestId: z.string().min(1)
});

const backupDateSchema = z.string().datetime().optional();

const backupSettingsSchema = settingsUpdateSchema.omit({ apiKey: true }).partial();

const backupCharacterSchema = characterCreateSchema
  .extend({
    id: idSchema.optional(),
    avatar: z.string().trim().nullable().optional(),
    description: z.string().optional(),
    scenario: z.string().optional(),
    systemPrompt: z.string().optional(),
    createdAt: backupDateSchema,
    updatedAt: backupDateSchema
  })
  .transform((character) => ({
    id: character.id,
    name: character.name,
    avatar: character.avatar ?? null,
    prefix: character.prefix || character.systemPrompt || "",
    prompt: character.prompt || character.description || "",
    suffix: character.suffix || character.scenario || "",
    relationship: character.relationship ?? "",
    loreEntries: character.loreEntries ?? [],
    createdAt: character.createdAt,
    updatedAt: character.updatedAt
  }));

const backupChatSchema = chatCreateSchema.extend({
  id: idSchema.optional(),
  createdAt: backupDateSchema,
  updatedAt: backupDateSchema
});

const backupMessageSchema = messageCreateSchema.extend({
  id: idSchema.optional(),
  createdAt: backupDateSchema,
  updatedAt: backupDateSchema
});

export const backupImportSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  exportedAt: z.string().datetime().optional(),
  settings: backupSettingsSchema.optional().nullable(),
  characters: z.array(backupCharacterSchema).default([]),
  chats: z.array(backupChatSchema).default([]),
  messages: z.array(backupMessageSchema).default([]),
  mode: z.enum(["merge", "replace"]).default("merge")
});
