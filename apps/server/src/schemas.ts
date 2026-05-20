import { z } from "zod";

export const idSchema = z.string().min(1);

const stringArraySchema = z.array(z.string().trim().min(1)).default([]);

export const characterCreateSchema = z.object({
  name: z.string().trim().min(1),
  avatar: z.string().trim().nullable().optional(),
  description: z.string().default(""),
  personality: z.string().default(""),
  scenario: z.string().default(""),
  firstMessage: z.string().default(""),
  exampleDialog: z.string().default(""),
  systemPrompt: z.string().default(""),
  tags: stringArraySchema
});

export const characterUpdateSchema = characterCreateSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required"
);

export const chatCreateSchema = z.object({
  title: z.string().trim().min(1),
  mode: z.enum(["single", "group"]).default("single"),
  characterIds: stringArraySchema
});

export const chatUpdateSchema = chatCreateSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required"
);

export const messageCreateSchema = z.object({
  chatId: idSchema,
  role: z.enum(["user", "assistant", "system"]),
  characterId: idSchema.nullable().optional(),
  content: z.string(),
  variants: z.array(z.string()).default([]),
  activeVariantIndex: z.number().int().min(0).default(0)
});

export const messageUpdateSchema = z
  .object({
    role: z.enum(["user", "assistant", "system"]).optional(),
    characterId: idSchema.nullable().optional(),
    content: z.string().optional(),
    variants: z.array(z.string()).optional(),
    activeVariantIndex: z.number().int().min(0).optional()
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
  language: z.enum(["zh-CN", "en"]).default("zh-CN")
});

export const generationRequestSchema = z.object({
  type: z.literal("generate"),
  requestId: z.string().min(1),
  chatId: idSchema,
  content: z.string().trim().min(1),
  characterId: idSchema.nullable().optional()
});

export const stopGenerationRequestSchema = z.object({
  type: z.literal("stop"),
  requestId: z.string().min(1)
});

export const lorebookCreateSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().default("")
});

export const lorebookUpdateSchema = lorebookCreateSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required"
);

export const loreEntryCreateSchema = z.object({
  keys: stringArraySchema,
  content: z.string().min(1),
  priority: z.number().int().default(0),
  enabled: z.boolean().default(true)
});

export const loreEntryUpdateSchema = loreEntryCreateSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required"
);
