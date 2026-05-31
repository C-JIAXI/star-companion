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
  scope: z.enum(["prefix", "prompt", "suffix"]).default("prompt"),
  triggerMode: z.enum(["user", "assistant", "both"]).default("both"),
  alwaysActive: z.boolean().default(false),
  enabled: z.boolean(),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional()
});

const loreEntrySchema = z.object({
  id: z.string().min(1).optional(),
  keys: stringArraySchema,
  content: z.string().min(1),
  priority: z.number().int().default(0),
  scope: z.enum(["prefix", "prompt", "suffix"]).default("prompt"),
  triggerMode: z.enum(["user", "assistant", "both"]).default("both"),
  alwaysActive: z.boolean().default(false),
  enabled: z.boolean().default(true)
});

const loreEntriesSchema = z.array(loreEntrySchema).default([]);

const quickReplySchema = z.object({
  id: z.string().min(1).optional(),
  label: z.string().min(1),
  content: z.string().min(1)
});

const quickRepliesSchema = z.array(quickReplySchema).default([]);

export const characterCreateSchema = z.object({
  name: z.string().trim().min(1),
  avatar: z.string().trim().nullable().optional(),
  description: z.string().default(""),
  prefix: z.string().default(""),
  prompt: z.string().default(""),
  suffix: z.string().default(""),
  htmlCss: z.string().default(""),
  openingHtml: z.string().default(""),
  loreEntries: loreEntriesSchema,
  quickReplies: quickRepliesSchema
});

const characterUpdateFieldsSchema = characterCreateSchema.partial();

export const characterUpdateSchema = characterUpdateFieldsSchema.refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required"
);

export const characterUpdateRequestSchema = characterUpdateFieldsSchema
  .extend({
    accessPassword: z.string().min(1).optional()
  })
  .refine(
    (value) => Object.keys(value).some((key) => key !== "accessPassword"),
    "At least one field is required"
  );

export const characterExportSchema = z.object({
  visibility: z.enum(["public", "private"]).default("public"),
  password: z.string().min(1).optional()
});

export const characterUnlockSchema = z.object({
  password: z.string().min(1)
});

const publicCharacterCardSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  format: z.literal("character-card"),
  visibility: z.literal("public"),
  exportedAt: z.string().datetime().optional(),
  character: characterCreateSchema.extend({
    avatar: z.string().trim().nullable().optional()
  })
});

const passwordAccessControlSchema = z.object({
  version: z.literal(1),
  salt: z.string().min(1),
  verifier: z.string().min(1)
});

const privateCharacterCardSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  format: z.literal("character-card"),
  visibility: z.literal("private"),
  exportedAt: z.string().datetime().optional(),
  character: z.object({
    name: z.string().trim().min(1),
    avatar: z.string().trim().nullable().optional(),
    description: z.string().optional(),
    openingHtml: z.string().optional(),
    quickReplies: quickRepliesSchema.optional()
  }),
  protectedPayload: z.object({
    version: z.literal(1),
    algorithm: z.literal("aes-256-gcm"),
    salt: z.string().min(1),
    iv: z.string().min(1),
    tag: z.string().min(1),
    ciphertext: z.string().min(1),
    accessControl: passwordAccessControlSchema
  })
});

export const characterImportSchema = z.union([publicCharacterCardSchema, privateCharacterCardSchema]);

const toPositiveInt = (fallback: number) =>
  z
    .preprocess((value) => {
      if (Array.isArray(value)) {
        return value[0];
      }
      if (typeof value === "string" && value.trim() !== "") {
        return Number(value);
      }
      return value;
    }, z.number().int().positive().catch(fallback))
    .default(fallback);

export const characterPageQuerySchema = z
  .object({
    q: z
      .preprocess((value) => (Array.isArray(value) ? value[0] : value), z.string().trim().catch(""))
      .default(""),
    page: toPositiveInt(1),
    pageSize: toPositiveInt(40)
  })
  .transform((query) => ({
    q: query.q,
    page: query.page,
    pageSize: Math.min(query.pageSize, 100)
  }));

export const chatCreateSchema = z.object({
  title: z.string().trim().min(1),
  characterId: idSchema,
  memoryTurns: z.number().int().min(1).max(50).default(12),
  userPersona: z.string().max(12000).default(""),
  userProfileSummary: z.string().default("")
});

export const chatUpdateSchema = z
  .object({
    title: z.string().trim().min(1).optional(),
    characterId: idSchema.nullable().optional(),
    memoryTurns: z.number().int().min(1).max(50).optional(),
    userPersona: z.string().max(12000).optional(),
    userProfileSummary: z.string().optional()
  })
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
  showMessageAvatars: z.boolean().optional(),
  userProfileSummary: z.string().max(4000).optional(),
  models: z
    .array(
      z
        .object({
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
  content: z.string().trim().min(1)
});

export const regenerateRequestSchema = z.object({
  type: z.literal("regenerate"),
  requestId: z.string().min(1),
  messageId: idSchema
});

export const resendRequestSchema = z.object({
  type: z.literal("resend"),
  requestId: z.string().min(1),
  messageId: idSchema
});

export const stopGenerationRequestSchema = z.object({
  type: z.literal("stop"),
  requestId: z.string().min(1)
});

const backupDateSchema = z.string().datetime().optional();

const backupSettingsSchema = settingsUpdateSchema.omit({ apiKey: true }).partial();

const backupCharacterSchema = z
  .object({
    id: idSchema.optional(),
    name: z.string().trim().min(1),
    avatar: z.string().trim().nullable().optional(),
    description: z.string(),
    prefix: z.string(),
    prompt: z.string(),
    suffix: z.string(),
    htmlCss: z.string(),
    openingHtml: z.string(),
    loreEntries: loreEntriesSchema,
    quickReplies: quickRepliesSchema,
    createdAt: backupDateSchema,
    updatedAt: backupDateSchema
  })
  .transform((character) => ({
    id: character.id,
    name: character.name,
    avatar: character.avatar ?? null,
    description: character.description,
    prefix: character.prefix,
    prompt: character.prompt,
    suffix: character.suffix,
    htmlCss: character.htmlCss,
    openingHtml: character.openingHtml,
    loreEntries: character.loreEntries,
    quickReplies: character.quickReplies,
    createdAt: character.createdAt,
    updatedAt: character.updatedAt
  }));

const backupChatSchema = chatCreateSchema.extend({
  id: idSchema.optional(),
  characterId: idSchema.nullable(),
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
