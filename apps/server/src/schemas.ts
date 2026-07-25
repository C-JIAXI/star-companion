import { z } from "zod";

export const idSchema = z.string().min(1);

const stringArraySchema = z.array(z.string().trim().min(1)).default([]);
const characterTagsSchema = z
  .array(z.string().trim().min(1).max(40))
  .max(24)
  .default([])
  .transform((tags) => Array.from(new Set(tags)));

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

const matchedMemorySchema = z.object({
  id: idSchema,
  chatId: idSchema,
  title: z.string(),
  content: z.string(),
  keywords: stringArraySchema,
  importance: z.number().int().min(1).max(5),
  enabled: z.boolean(),
  score: z.number().optional(),
  lastMatchedAt: z.string().datetime().nullable().optional(),
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

const loreEntriesInputSchema = z.array(loreEntrySchema);
const loreEntriesSchema = loreEntriesInputSchema.default([]);

const quickReplySchema = z.object({
  id: z.string().min(1).optional(),
  label: z.string().min(1),
  content: z.string().min(1)
});

const quickRepliesInputSchema = z.array(quickReplySchema);
const quickRepliesSchema = quickRepliesInputSchema.default([]);

const isSupportedBackgroundUrl = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) {
    return true;
  }

  if (/^data:image\/[a-zA-Z0-9.+-]+;base64,[a-zA-Z0-9+/=]+$/.test(trimmed)) {
    return true;
  }

  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

const backgroundUrlSchema = z
  .string()
  .trim()
  .max(3_000_000)
  .refine(
    isSupportedBackgroundUrl,
    "Background URL must be an https/http image URL or a data image URL."
  );

const characterAvatarSchema = z.string().trim().max(3_000_000).nullable().optional();

export const characterCreateSchema = z.object({
  name: z.string().trim().min(1),
  avatar: characterAvatarSchema,
  description: z.string().default(""),
  tags: characterTagsSchema,
  prefix: z.string().default(""),
  prompt: z.string().default(""),
  suffix: z.string().default(""),
  htmlCss: z.string().default(""),
  openingHtml: z.string().default(""),
  loreEntries: loreEntriesSchema,
  quickReplies: quickRepliesSchema
});

const characterUpdateFieldsSchema = z.object({
  name: z.string().trim().min(1).optional(),
  avatar: characterAvatarSchema,
  description: z.string().optional(),
  tags: characterTagsSchema.optional(),
  prefix: z.string().optional(),
  prompt: z.string().optional(),
  suffix: z.string().optional(),
  htmlCss: z.string().optional(),
  openingHtml: z.string().optional(),
  loreEntries: loreEntriesInputSchema.optional(),
  quickReplies: quickRepliesInputSchema.optional(),
  isFavorite: z.boolean().optional()
});

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
  cardId: idSchema,
  exportedAt: z.string().datetime().optional(),
  character: characterCreateSchema.extend({
    avatar: characterAvatarSchema
  })
});

const passwordAccessControlSchema = z.object({
  version: z.literal(1),
  salt: z.string().min(1),
  verifier: z.string().min(1)
});

const storedPrivateCharacterSchema = z.object({
  __privateCharacter: z.object({
    version: z.literal(1),
    algorithm: z.literal("aes-256-gcm"),
    iv: z.string().min(1),
    tag: z.string().min(1),
    ciphertext: z.string().min(1),
    accessControl: passwordAccessControlSchema,
    exportSalt: z.string().min(1).optional()
  })
});

const privateCharacterCardSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  format: z.literal("character-card"),
  visibility: z.literal("private"),
  cardId: idSchema,
  exportedAt: z.string().datetime().optional(),
  character: z.object({
    name: z.string().trim().min(1),
    avatar: characterAvatarSchema,
    description: z.string().optional(),
    tags: characterTagsSchema.optional(),
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

export const characterImportSchema = z.union([
  publicCharacterCardSchema,
  privateCharacterCardSchema
]);

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

export const characterBatchDeleteSchema = z.object({
  ids: z.array(idSchema).min(1).max(100)
});

export const characterBatchTagsSchema = z.object({
  ids: z
    .array(idSchema)
    .min(1)
    .max(100)
    .transform((ids) => Array.from(new Set(ids))),
  operation: z.enum(["add", "remove"]),
  tags: z
    .array(z.string().trim().min(1).max(40))
    .min(1)
    .max(24)
    .transform((tags) =>
      tags.filter(
        (tag, index) =>
          tags.findIndex((candidate) => candidate.toLowerCase() === tag.toLowerCase()) === index
      )
    )
});

export const characterBatchFetchSchema = z.object({
  ids: z.array(idSchema).min(1).max(50)
});

export const characterDuplicateSchema = z.object({
  name: z.string().trim().min(1).max(120)
});

export const characterPageQuerySchema = z
  .object({
    q: z
      .preprocess((value) => (Array.isArray(value) ? value[0] : value), z.string().trim().catch(""))
      .default(""),
    tag: z
      .preprocess((value) => (Array.isArray(value) ? value[0] : value), z.string().trim().catch(""))
      .default(""),
    favoriteOnly: z
      .preprocess(
        (value) => (Array.isArray(value) ? value[0] : value),
        z.enum(["true", "false"]).transform((value) => value === "true").catch(false)
      )
      .default(false),
    sort: z
      .preprocess(
        (value) => (Array.isArray(value) ? value[0] : value),
        z
          .enum([
            "favorites",
            "recently_chatted",
            "most_chats",
            "recently_updated",
            "name_asc",
            "name_desc"
          ])
          .catch("favorites")
      )
      .default("favorites"),
    page: toPositiveInt(1),
    pageSize: toPositiveInt(40)
  })
  .transform((query) => ({
    q: query.q,
    tag: query.tag,
    favoriteOnly: query.favoriteOnly,
    sort: query.sort,
    page: query.page,
    pageSize: Math.min(query.pageSize, 100)
  }));

export const chatCreateSchema = z.object({
  title: z.string().trim().min(1),
  characterId: idSchema,
  backgroundUrl: backgroundUrlSchema.default(""),
  memoryTurns: z.number().int().min(1).max(50).default(12),
  autoMemoryEnabled: z.boolean().default(true),
  userPersona: z.string().max(12000).default(""),
  userProfileSummary: z.string().default("")
});

export const chatUpdateSchema = z
  .object({
    title: z.string().trim().min(1).optional(),
    characterId: idSchema.nullable().optional(),
    isPinned: z.boolean().optional(),
    isArchived: z.boolean().optional(),
    backgroundUrl: backgroundUrlSchema.optional(),
    memoryTurns: z.number().int().min(1).max(50).optional(),
    autoMemoryEnabled: z.boolean().optional(),
    userPersona: z.string().max(12000).optional(),
    userProfileSummary: z.string().optional()
  })
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const chatBatchArchiveSchema = z.object({
  ids: z.array(idSchema).min(1).max(100).transform((ids) => [...new Set(ids)]),
  isArchived: z.boolean()
});

const chatBatchIdsSchema = z.array(idSchema).min(1).max(100).transform((ids) => [...new Set(ids)]);

export const chatBatchTrashSchema = z.object({
  ids: chatBatchIdsSchema,
  action: z.enum(["trash", "restore"])
});

export const chatBatchPermanentDeleteSchema = z.object({
  ids: chatBatchIdsSchema
});

export const chatMemoryCreateSchema = z.object({
  title: z.string().trim().min(1).max(80),
  content: z.string().trim().min(1).max(1200),
  keywords: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
  importance: z.number().int().min(1).max(5).default(3),
  enabled: z.boolean().default(true),
  sourceMessageIds: z.array(idSchema).max(20).default([])
});

export const chatMemoryUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(80).optional(),
    content: z.string().trim().min(1).max(1200).optional(),
    keywords: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
    importance: z.number().int().min(1).max(5).optional(),
    enabled: z.boolean().optional(),
    sourceMessageIds: z.array(idSchema).max(20).optional()
  })
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const chatAgentDraftSchema = z.object({
  mode: z.enum(["scene_summary", "next_steps", "reply_drafts", "memory_lore_candidates"]),
  focus: z.string().trim().max(1000).optional()
});

export const chatBranchSchema = z.object({
  messageId: idSchema,
  title: z.string().trim().min(1).max(120).optional(),
  kind: z.enum(["branch", "checkpoint"]).default("branch")
});

export const messageCreateSchema = z.object({
  chatId: idSchema,
  role: z.enum(["user", "assistant", "system"]),
  characterId: idSchema.nullable().optional(),
  content: z.string(),
  contextIncluded: z.boolean().default(true),
  isBookmarked: z.boolean().default(false),
  variants: z.array(z.string()).default([]),
  activeVariantIndex: z.number().int().min(0).default(0),
  tokenUsage: tokenUsageSchema.nullable().optional(),
  loreMatches: z.array(loreMatchSchema).nullable().optional(),
  memoryMatches: z.array(matchedMemorySchema).nullable().optional()
});

export const messageUpdateSchema = z
  .object({
  role: z.enum(["user", "assistant", "system"]).optional(),
  characterId: idSchema.nullable().optional(),
  content: z.string().optional(),
  contextIncluded: z.boolean().optional(),
  isBookmarked: z.boolean().optional(),
  variants: z.array(z.string()).optional(),
  activeVariantIndex: z.number().int().min(0).optional(),
  tokenUsage: tokenUsageSchema.nullable().optional(),
  loreMatches: z.array(loreMatchSchema).nullable().optional(),
  memoryMatches: z.array(matchedMemorySchema).nullable().optional()
  })
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const messageListQuerySchema = z.object({
  chatId: idSchema.optional()
});

export const chatMessageSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(50).default(20)
});

const providerModelSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  model: z.string().min(1),
  capabilities: z
    .array(z.enum(["text_generation", "text_embedding", "audio_transcription", "text_to_speech", "image_generation"]))
    .max(5)
    .transform((capabilities) => Array.from(new Set(capabilities)))
    .optional()
});

const providerProfileSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  provider: z.string().min(1),
  apiBaseUrl: z.string().url(),
  key: z.string().optional(),
  models: z.array(providerModelSchema).default([])
});

const moduleModelPreferenceSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1)
});

export const moduleModelPreferencesSchema = z
  .object({
    chat: moduleModelPreferenceSchema.optional(),
    agent: moduleModelPreferenceSchema.optional(),
    memory: moduleModelPreferenceSchema.optional(),
    memory_embedding: moduleModelPreferenceSchema.optional(),
    user_profile: moduleModelPreferenceSchema.optional(),
    voice_transcription: moduleModelPreferenceSchema.optional(),
    voice_speech: moduleModelPreferenceSchema.optional(),
    image_generation: moduleModelPreferenceSchema.optional()
  });

const userPersonaPresetSchema = z.object({
  id: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(80),
  config: z.object({
    prefix: z.string().max(4000).default(""),
    prompt: z.string().max(12000).default(""),
    suffix: z.string().max(4000).default("")
  }),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional()
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
  showMessageTimestamps: z.boolean().optional(),
  ttsVoice: z.string().trim().min(1).max(80).optional(),
  ttsPlaybackRate: z.number().min(0.5).max(2).optional(),
  ttsAutoPlay: z.boolean().optional(),
  userProfileSummary: z.string().max(4000).optional(),
  providers: z.array(providerProfileSchema).default([]),
  activeProviderId: z.string().default(""),
  activeModelId: z.string().default(""),
  moduleModelPreferences: moduleModelPreferencesSchema.optional(),
  userPersonaPresets: z.array(userPersonaPresetSchema).max(30).optional(),
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
    .optional()
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

export const continueRequestSchema = z.object({
  type: z.literal("continue"),
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
const backupLoreEntriesSchema = z.union([loreEntriesSchema, storedPrivateCharacterSchema]);

const backupCharacterSchema = z
  .object({
    id: idSchema.optional(),
    cardId: idSchema,
    name: z.string().trim().min(1),
    avatar: characterAvatarSchema,
    description: z.string(),
    tags: characterTagsSchema,
    prefix: z.string(),
    prompt: z.string(),
    suffix: z.string(),
    htmlCss: z.string(),
    openingHtml: z.string(),
    loreEntries: backupLoreEntriesSchema,
    quickReplies: quickRepliesSchema,
    isFavorite: z.boolean().default(false),
    createdAt: backupDateSchema,
    updatedAt: backupDateSchema
  })
  .transform((character) => ({
    id: character.id,
    cardId: character.cardId,
    name: character.name,
    avatar: character.avatar ?? null,
    description: character.description,
    tags: character.tags,
    prefix: character.prefix,
    prompt: character.prompt,
    suffix: character.suffix,
    htmlCss: character.htmlCss,
    openingHtml: character.openingHtml,
    loreEntries: character.loreEntries,
    quickReplies: character.quickReplies,
    isFavorite: character.isFavorite,
    createdAt: character.createdAt,
    updatedAt: character.updatedAt
  }));

const backupChatSchema = chatCreateSchema.extend({
  id: idSchema.optional(),
  characterId: idSchema.nullable(),
  parentChatId: idSchema.nullable().optional(),
  branchSourceMessageId: idSchema.nullable().optional(),
  isCheckpoint: z.boolean().default(false),
  isPinned: z.boolean().default(false),
  isArchived: z.boolean().default(false),
  deletedAt: z.string().datetime().nullable().default(null),
  createdAt: backupDateSchema,
  updatedAt: backupDateSchema
});

const backupMessageSchema = messageCreateSchema.extend({
  id: idSchema.optional(),
  createdAt: backupDateSchema,
  updatedAt: backupDateSchema
});

const backupMemorySchema = chatMemoryCreateSchema.extend({
  id: idSchema.optional(),
  chatId: idSchema,
  lastMatchedAt: z.string().datetime().nullable().optional(),
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
  memories: z.array(backupMemorySchema).default([]),
  mode: z.enum(["merge", "replace"]).default("merge")
});

export const chatArchiveImportSchema = z.object({
  archive: z.object({
    archiveVersion: z.literal(1),
    exportedAt: z.string().datetime(),
    chat: backupChatSchema,
    character: backupCharacterSchema.nullable(),
    messages: z.array(backupMessageSchema).max(10_000),
    memories: z.array(backupMemorySchema).max(500)
  }),
  title: z.string().trim().min(1).max(120).optional()
});

export const voiceTranscriptionSchema = z.object({
  audioBase64: z.string().min(1).max(16_000_000),
  mimeType: z.string().trim().min(1).max(100),
  filename: z.string().trim().max(120).optional()
});

export const voiceSpeechSchema = z.object({
  text: z.string().trim().min(1).max(4000),
  voice: z.string().trim().min(1).max(80).default("alloy"),
  format: z.enum(["mp3", "opus", "aac", "flac", "wav", "pcm"]).default("mp3")
});

export const imageGenerationSchema = z.object({
  prompt: z.string().trim().min(1).max(4000),
  size: z.enum(["1024x1024", "1024x1536", "1536x1024", "auto"]).default("1024x1024")
});

export const lanSyncRequestSchema = z.object({
  peerBaseUrl: z.string().trim().min(1).max(300),
  mode: z.enum(["merge", "replace"]).default("merge")
});
