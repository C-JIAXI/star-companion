import { z } from "zod";

const CHARACTER_HTML_MAX_LENGTH = 200_000;
const CHARACTER_CSS_MAX_LENGTH = 100_000;

export const idSchema = z.string().min(1);
export const attachmentDraftIdSchema = z.string().trim().regex(/^draft_[a-zA-Z0-9_-]{12,100}$/);
export const imageAttachmentUploadSchema = z.object({
  draftId: attachmentDraftIdSchema,
  dataBase64: z.string().min(1).max(14_000_000),
  mimeType: z.enum(["image/png", "image/jpeg"]),
  originalFilename: z.string().trim().max(160).optional()
});
export const imageAttachmentReorderSchema = z.object({
  attachmentIds: z.array(idSchema).min(1).max(4)
});
export const imageAttachmentEditDraftSchema = z.object({ draftId: attachmentDraftIdSchema });

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

const generationMetadataSchema = z.object({
  providerId: z.string().min(1).max(240),
  providerType: z.string().min(1).max(120),
  modelId: z.string().min(1).max(240),
  requestId: z.string().min(1).max(240),
  attemptId: z.string().min(1).max(240),
  usage: tokenUsageSchema.nullable(),
  usageSource: z.enum(["provider", "estimated"]).nullable(),
  inputPriceMicros: z.number().int().min(0).max(2_000_000_000).nullable(),
  outputPriceMicros: z.number().int().min(0).max(2_000_000_000).nullable(),
  estimatedCostMicros: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  currency: z.literal("USD").nullable(),
  usedFallback: z.boolean(),
  incomplete: z.boolean()
});

const promptBreakdownSectionSchema = z.object({
  id: z.enum([
    "character",
    "user_persona",
    "user_profile",
    "lore",
    "memory",
    "history",
    "image_input",
    "generation_instruction",
    "formatting"
  ]),
  tokenEstimate: z.number().int().min(0),
  characterCount: z.number().int().min(0),
  itemCount: z.number().int().min(0)
});

const promptBreakdownSchema = z.object({
  promptTokens: z.number().int().min(0),
  promptTokensEstimated: z.boolean(),
  includedMessageCount: z.number().int().min(0),
  imageCount: z.number().int().min(0).default(0),
  sections: z.array(promptBreakdownSectionSchema).max(8)
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
const userAvatarSchema = z.string().trim().max(3_000_000);

export const characterCreateSchema = z.object({
  name: z.string().trim().min(1),
  avatar: characterAvatarSchema,
  description: z.string().default(""),
  tags: characterTagsSchema,
  prefix: z.string().default(""),
  prompt: z.string().default(""),
  suffix: z.string().default(""),
  htmlCss: z.string().max(CHARACTER_CSS_MAX_LENGTH).default(""),
  openingHtml: z.string().max(CHARACTER_HTML_MAX_LENGTH).default(""),
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
  htmlCss: z.string().max(CHARACTER_CSS_MAX_LENGTH).optional(),
  openingHtml: z.string().max(CHARACTER_HTML_MAX_LENGTH).optional(),
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

export const characterDraftSchema = z.object({
  requestId: z.string().trim().min(1).max(240),
  task: z.enum([
    "generate_core_prompt",
    "refine_prompt",
    "consistency_questions",
    "suggest_lore",
    "suggest_quick_replies",
    "find_contradictions"
  ]),
  brief: z.string().trim().max(4000).optional(),
  characterId: idSchema.optional(),
  accessPassword: z.string().min(1).optional(),
  draft: z.object({
    name: z.string().max(500),
    description: z.string().max(20_000),
    prefix: z.string().max(200_000),
    prompt: z.string().max(400_000),
    suffix: z.string().max(200_000),
    loreEntries: z.array(loreEntrySchema).max(500),
    quickReplies: z.array(quickReplySchema).max(100)
  })
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
  folder: z.string().trim().max(80).default(""),
  backgroundUrl: backgroundUrlSchema.default(""),
  memoryTurns: z.number().int().min(1).max(50).default(12),
  autoMemoryEnabled: z.boolean().default(true),
  userPersona: z.string().max(12000).default(""),
  userAvatar: userAvatarSchema.default(""),
  userProfileSummary: z.string().default("")
});

export const chatUpdateSchema = z
  .object({
    title: z.string().trim().min(1).optional(),
    characterId: idSchema.nullable().optional(),
    isPinned: z.boolean().optional(),
    isArchived: z.boolean().optional(),
    folder: z.string().trim().max(80).optional(),
    backgroundUrl: backgroundUrlSchema.optional(),
    memoryTurns: z.number().int().min(1).max(50).optional(),
    autoMemoryEnabled: z.boolean().optional(),
    userPersona: z.string().max(12000).optional(),
    userAvatar: userAvatarSchema.optional(),
    userProfileSummary: z.string().optional()
  })
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const chatBatchArchiveSchema = z.object({
  ids: z.array(idSchema).min(1).max(100).transform((ids) => [...new Set(ids)]),
  isArchived: z.boolean()
});

export const chatBatchFolderSchema = z.object({
  ids: z.array(idSchema).min(1).max(100).transform((ids) => [...new Set(ids)]),
  folder: z.string().trim().max(80)
});

export const chatRenameFolderSchema = z.object({
  from: z.string().trim().min(1).max(80),
  to: z.string().trim().max(80)
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
  sourceMessageIds: z.array(idSchema).max(20).default([]),
  actor: z.enum(["user", "agent_confirmed"]).default("user")
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

export const memoryRevisionParamsSchema = z.object({
  revision: z.coerce.number().int().min(1)
});

export const memoryRestoreExecuteSchema = z.object({
  revision: z.number().int().min(1),
  expectedCurrentRevision: z.number().int().min(0),
  confirm: z.literal("RESTORE_MEMORY_REVISION")
});

export const memoryPurgeSchema = z.object({
  confirm: z.literal("PURGE_MEMORY_HISTORY")
});

export const memoryUndoExecuteSchema = z.object({
  resolutions: z.array(z.object({
    memoryId: idSchema,
    expectedCurrentRevision: z.number().int().min(0),
    action: z.enum(["skip", "restore"])
  })).max(100).default([]),
  confirm: z.literal("UNDO_MEMORY_OPERATION")
});

export const profileSummaryRestoreExecuteSchema = z.object({
  revision: z.number().int().min(1),
  expectedCurrentRevision: z.number().int().min(0),
  confirm: z.literal("RESTORE_PROFILE_SUMMARY")
});

export const chatAgentDraftSchema = z.object({
  mode: z.enum(["scene_summary", "next_steps", "reply_drafts", "memory_lore_candidates", "continuity_check", "character_consistency"]),
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
  draftId: attachmentDraftIdSchema.optional(),
  contextIncluded: z.boolean().default(true),
  isBookmarked: z.boolean().default(false),
  variants: z.array(z.string()).default([]),
  activeVariantIndex: z.number().int().min(0).default(0),
  tokenUsage: tokenUsageSchema.nullable().optional(),
  generationMetadata: generationMetadataSchema.nullable().optional(),
  variantMetadata: z.array(generationMetadataSchema.nullable()).max(100).default([]),
  promptBreakdown: promptBreakdownSchema.nullable().optional(),
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
  generationMetadata: generationMetadataSchema.nullable().optional(),
  variantMetadata: z.array(generationMetadataSchema.nullable()).max(100).optional(),
  promptBreakdown: promptBreakdownSchema.nullable().optional(),
  loreMatches: z.array(loreMatchSchema).nullable().optional(),
  memoryMatches: z.array(matchedMemorySchema).nullable().optional(),
  draftId: attachmentDraftIdSchema.optional(),
  replaceAttachments: z.boolean().optional()
  })
  .refine((value) => Object.keys(value).length > 0, "At least one field is required")
  .refine((value) => value.draftId === undefined || value.replaceAttachments === true, "draftId requires replaceAttachments");

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
  contextWindow: z.number().int().min(256).max(10_000_000).optional(),
  capabilities: z
    .array(z.enum(["text_generation", "vision_input", "text_embedding", "audio_transcription", "text_to_speech", "image_generation"]))
    .max(6)
    .transform((capabilities) => Array.from(new Set(capabilities)))
    .optional(),
  pricing: z.object({
    inputMicrosPerMillion: z.number().int().min(0).max(2_000_000_000),
    outputMicrosPerMillion: z.number().int().min(0).max(2_000_000_000),
    currency: z.literal("USD"),
    updatedAt: z.string().datetime(),
    source: z.enum(["user", "template"])
  }).optional()
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

const moduleFallbackSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  allowAutomatic: z.boolean().optional(),
  chain: z.array(moduleModelPreferenceSchema).max(3).default([])
}).superRefine((value, context) => {
  const seen = new Set<string>();
  for (const [index, entry] of value.chain.entries()) {
    const key = `${entry.providerId}\0${entry.modelId}`;
    if (seen.has(key)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["chain", index], message: "Fallback models must be unique." });
    }
    seen.add(key);
  }
});

export const modelReliabilitySchema = z.object({
  retry: z.object({
    enabled: z.boolean().default(false),
    maxRetries: z.number().int().min(0).max(2).default(0)
  }).default({ enabled: false, maxRetries: 0 }),
  fallback: z.object({
    chat: moduleFallbackSettingsSchema.optional(),
    agent: moduleFallbackSettingsSchema.optional(),
    memory: moduleFallbackSettingsSchema.optional(),
    memory_embedding: moduleFallbackSettingsSchema.optional(),
    user_profile: moduleFallbackSettingsSchema.optional(),
    voice_transcription: moduleFallbackSettingsSchema.optional(),
    voice_speech: moduleFallbackSettingsSchema.optional(),
    image_generation: moduleFallbackSettingsSchema.optional()
  }).default({})
});

export const appearancePreferencesSchema = z.object({
  themeMode: z.enum(["system", "light", "dark"]).default("system"),
  fontSize: z.enum(["small", "standard", "large", "extra-large"]).default("standard"),
  lineHeight: z.enum(["compact", "comfortable", "relaxed"]).default("comfortable"),
  chatWidth: z.enum(["narrow", "standard", "wide"]).default("standard"),
  messageSpacing: z.enum(["compact", "standard", "relaxed"]).default("standard"),
  contrast: z.enum(["standard", "high"]).default("standard"),
  motion: z.enum(["system", "reduced", "full"]).default("system"),
  backgroundOverlay: z.number().min(0.2).max(0.9).default(0.55),
  backgroundBlur: z.enum(["off", "subtle", "medium"]).default("subtle"),
  characterStyle: z.enum(["full", "restricted", "off"]).default("full")
});

const nullableBudgetMicrosSchema = z.number().int().min(0).max(2_000_000_000).nullable();
export const usageBudgetsSchema = z.object({
  dailySoftMicros: nullableBudgetMicrosSchema.default(null),
  dailyHardMicros: nullableBudgetMicrosSchema.default(null),
  monthlySoftMicros: nullableBudgetMicrosSchema.default(null),
  monthlyHardMicros: nullableBudgetMicrosSchema.default(null),
  allowUnknownPricing: z.boolean().default(true)
}).superRefine((value, context) => {
  if (value.dailySoftMicros !== null && value.dailyHardMicros !== null && value.dailySoftMicros > value.dailyHardMicros) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["dailySoftMicros"], message: "Daily soft budget cannot exceed the daily hard budget." });
  }
  if (value.monthlySoftMicros !== null && value.monthlyHardMicros !== null && value.monthlySoftMicros > value.monthlyHardMicros) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["monthlySoftMicros"], message: "Monthly soft budget cannot exceed the monthly hard budget." });
  }
});

const userPersonaPresetSchema = z.object({
  id: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(80),
  avatar: userAvatarSchema.default(""),
  config: z.object({
    displayName: z.string().trim().max(80).default(""),
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
  appearancePreferences: appearancePreferencesSchema.optional(),
  ttsVoice: z.string().trim().min(1).max(80).optional(),
  ttsPlaybackRate: z.number().min(0.5).max(2).optional(),
  ttsAutoPlay: z.boolean().optional(),
  userProfileSummary: z.string().max(4000).optional(),
  providers: z.array(providerProfileSchema).default([]),
  activeProviderId: z.string().default(""),
  activeModelId: z.string().default(""),
  moduleModelPreferences: moduleModelPreferencesSchema.optional(),
  modelReliability: modelReliabilitySchema.optional(),
  usageBudgets: usageBudgetsSchema.optional(),
  usageTimezone: z.string().trim().min(1).max(100).optional().refine(
    (value) => !value || (() => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } })(),
    "Usage timezone must be a valid IANA time zone."
  ),
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
  content: z.string().max(100000),
  draftId: attachmentDraftIdSchema.optional(),
  overrideHardBudget: z.boolean().optional()
}).refine((value) => value.content.trim().length > 0 || Boolean(value.draftId), "Text or an image attachment is required.");

export const regenerateRequestSchema = z.object({
  type: z.literal("regenerate"),
  requestId: z.string().min(1),
  messageId: idSchema,
  guidance: z.string().trim().min(1).max(1000).optional(),
  overrideHardBudget: z.boolean().optional()
});

export const continueRequestSchema = z.object({
  type: z.literal("continue"),
  requestId: z.string().min(1),
  messageId: idSchema,
  overrideHardBudget: z.boolean().optional()
});

export const resendRequestSchema = z.object({
  type: z.literal("resend"),
  requestId: z.string().min(1),
  messageId: idSchema,
  overrideHardBudget: z.boolean().optional()
});

export const stopGenerationRequestSchema = z.object({
  type: z.literal("stop"),
  requestId: z.string().min(1)
});

const backupDateSchema = z.string().datetime().optional();

const backupProviderProfileSchema = providerProfileSchema.omit({ key: true });
export const backupSettingsSchema = settingsUpdateSchema
  .omit({ apiKey: true, providers: true })
  .extend({ providers: z.array(backupProviderProfileSchema).default([]) })
  .partial();
const backupLoreEntriesSchema = z.union([loreEntriesSchema, storedPrivateCharacterSchema]);

export const backupCharacterSchema = z
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

export const backupChatSchema = chatCreateSchema.extend({
  id: idSchema.optional(),
  characterId: idSchema.nullable(),
  parentChatId: idSchema.nullable().optional(),
  branchSourceMessageId: idSchema.nullable().optional(),
  isCheckpoint: z.boolean().default(false),
  isPinned: z.boolean().default(false),
  isArchived: z.boolean().default(false),
  folder: z.string().trim().max(80).default(""),
  deletedAt: z.string().datetime().nullable().default(null),
  memoryUpdatedAt: z.string().datetime().nullable().optional(),
  userProfileUpdatedAt: z.string().datetime().nullable().optional(),
  profileRevision: z.number().int().min(0).default(0),
  createdAt: backupDateSchema,
  updatedAt: backupDateSchema
});

export const backupMessageSchema = messageCreateSchema.extend({
  id: idSchema.optional(),
  createdAt: backupDateSchema,
  updatedAt: backupDateSchema
}).omit({ draftId: true });

const memoryActorSchema = z.enum(["user", "automatic_memory", "agent_confirmed", "timeline_cleanup", "restore"]);
const memoryActionSchema = z.enum(["baseline", "automatic_create", "automatic_update", "automatic_disable", "manual_create", "manual_edit", "manual_enable", "manual_disable", "manual_delete", "agent_confirmed_create", "timeline_disable", "restore", "undo_create", "undo_update", "undo_disable"]);
const memorySnapshotSchema = z.object({
  title: z.string().trim().min(1).max(80),
  content: z.string().trim().min(1).max(1200),
  keywords: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
  importance: z.number().int().min(1).max(5),
  enabled: z.boolean(),
  sourceMessageIds: z.array(idSchema).max(20).default([])
});

export const backupMediaAssetSchema = z.object({
  id: idSchema,
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  mimeType: z.enum(["image/png", "image/jpeg"]),
  byteSize: z.number().int().positive().max(20 * 1024 * 1024),
  width: z.number().int().positive().max(16_384),
  height: z.number().int().positive().max(16_384),
  dataBase64: z.string().min(1).max(28_000_000),
  createdAt: backupDateSchema
});

export const backupMessageAttachmentSchema = z.object({
  id: idSchema,
  messageId: idSchema,
  assetId: idSchema,
  sortOrder: z.number().int().min(0).max(3),
  originalFilename: z.string().max(160).nullable(),
  createdAt: backupDateSchema
});

export const backupMediaEnvelopeSchema = z.object({
  version: z.literal(1),
  manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
  assets: z.array(backupMediaAssetSchema).max(10_000),
  attachments: z.array(backupMessageAttachmentSchema).max(40_000)
});

export const backupMemorySchema = chatMemoryCreateSchema.omit({ actor: true }).extend({
  id: idSchema.optional(),
  chatId: idSchema,
  deletedAt: z.string().datetime().nullable().default(null),
  currentRevision: z.number().int().min(0).default(0),
  lastActor: memoryActorSchema.nullable().default(null),
  lastAction: memoryActionSchema.nullable().default(null),
  lastMatchedAt: z.string().datetime().nullable().optional(),
  createdAt: backupDateSchema,
  updatedAt: backupDateSchema
});

export const backupMemoryRevisionSchema = z.object({
  id: idSchema, memoryId: idSchema, chatId: idSchema, revision: z.number().int().min(1),
  action: memoryActionSchema, actor: memoryActorSchema,
  beforeSnapshot: memorySnapshotSchema.nullable(), afterSnapshot: memorySnapshotSchema.nullable(),
  sourceMessageIds: z.array(idSchema).max(20).default([]), operationId: idSchema.nullable().default(null),
  reasonCode: z.string().trim().min(1).max(120), createdAt: z.string().datetime()
});

export const backupMemoryOperationSchema = z.object({
  id: idSchema, chatId: idSchema, type: z.enum(["automatic_maintenance", "operation_undo"]),
  actor: memoryActorSchema, status: z.enum(["running", "succeeded", "partial", "failed"]),
  startedAt: z.string().datetime(), completedAt: z.string().datetime().nullable(),
  created: z.number().int().min(0), updated: z.number().int().min(0), disabled: z.number().int().min(0), unchanged: z.number().int().min(0),
  sourceMessageIds: z.array(idSchema).max(20).default([]), errorCode: z.string().max(120).nullable(),
  undoneAt: z.string().datetime().nullable(), undoOperationId: idSchema.nullable()
});

export const backupProfileSummaryRevisionSchema = z.object({
  id: idSchema, chatId: idSchema, revision: z.number().int().min(1),
  action: z.enum(["baseline", "automatic_update", "manual_edit", "manual_clear", "restore"]),
  actor: z.enum(["user", "automatic_memory", "restore"]), summary: z.string().max(4000),
  sourceMessageIds: z.array(idSchema).max(20).default([]), createdAt: z.string().datetime()
});

export const backupImportSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  exportedAt: z.string().datetime().optional(),
  settings: backupSettingsSchema.optional().nullable(),
  characters: z.array(backupCharacterSchema).default([]),
  chats: z.array(backupChatSchema).default([]),
  messages: z.array(backupMessageSchema).default([]),
  memories: z.array(backupMemorySchema).default([]),
  memoryRevisions: z.array(backupMemoryRevisionSchema).default([]),
  memoryOperations: z.array(backupMemoryOperationSchema).default([]),
  profileSummaryRevisions: z.array(backupProfileSummaryRevisionSchema).default([]),
  media: backupMediaEnvelopeSchema.optional(),
  mode: z.enum(["merge", "replace"]).default("merge")
});

export const generationStatusRequestSchema = z.object({
  type: z.literal("status"),
  requestId: z.string().min(1)
});

export const backupConflictResolutionSchema = z.object({
  key: z.string().min(1).max(300),
  action: z.enum(["keep_existing", "use_incoming", "skip"])
});

export const backupPreviewRequestSchema = z
  .object({
    schemaVersion: z.unknown().optional(),
    exportedAt: z.unknown().optional(),
    settings: z.unknown().optional(),
    characters: z.unknown().optional(),
    chats: z.unknown().optional(),
    messages: z.unknown().optional(),
    memories: z.unknown().optional(),
    memoryRevisions: z.unknown().optional(),
    memoryOperations: z.unknown().optional(),
    profileSummaryRevisions: z.unknown().optional(),
    media: z.unknown().optional(),
    mode: z.enum(["merge", "replace"]).default("merge")
  })
  .passthrough();

export const backupExecuteSchema = backupPreviewRequestSchema.extend({
  previewId: z.string().min(16).max(128),
  conflictResolutions: z.array(backupConflictResolutionSchema).max(20_000).default([])
});

export const chatArchiveImportSchema = z.object({
  archive: z.object({
    archiveVersion: z.literal(1),
    exportedAt: z.string().datetime(),
    chat: backupChatSchema,
    character: backupCharacterSchema.nullable(),
    messages: z.array(backupMessageSchema).max(10_000),
    memories: z.array(backupMemorySchema).max(500),
    memoryRevisions: z.array(backupMemoryRevisionSchema).max(15_000).default([]),
    memoryOperations: z.array(backupMemoryOperationSchema).max(10_000).default([]),
    profileSummaryRevisions: z.array(backupProfileSummaryRevisionSchema).max(15_000).default([]),
    media: backupMediaEnvelopeSchema.optional()
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
  mode: z.enum(["merge", "replace"]).default("merge"),
  phase: z.enum(["preview", "execute"]).default("preview"),
  previewId: z.string().min(16).max(128).optional(),
  conflictResolutions: z.array(backupConflictResolutionSchema).max(20_000).default([])
});

export const storageCleanupActionSchema = z.enum([
  "expired_drafts",
  "orphan_media",
  "clear_embeddings",
  "expired_recovery_points",
  "old_upgrade_recovery",
  "usage_ledger",
  "app_temp_cache",
  "rebuild_database_indexes",
  "vacuum_database"
]);

export const storageCleanupPlanRequestSchema = z.object({
  actions: z.array(storageCleanupActionSchema).min(1).max(9).transform((actions) => [...new Set(actions)])
}).strict().superRefine((value, context) => {
  if (value.actions.includes("vacuum_database") && value.actions.length > 1) {
    context.addIssue({ code: "custom", path: ["actions"], message: "Database compaction must be previewed and executed as a separate operation." });
  }
});

export const storageCleanupExecuteSchema = z.object({
  confirm: z.literal("EXECUTE_STORAGE_CLEANUP")
}).strict();
