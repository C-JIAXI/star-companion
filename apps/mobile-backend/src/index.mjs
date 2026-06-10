import cors from "cors";
import express from "express";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import {
  backupImportSchema,
  characterBatchDeleteSchema,
  characterBatchFetchSchema,
  characterCreateSchema,
  characterExportSchema,
  characterImportSchema,
  characterPageQuerySchema,
  characterUnlockSchema,
  characterUpdateRequestSchema,
  chatCreateSchema,
  chatMemoryCreateSchema,
  chatMemoryUpdateSchema,
  chatUpdateSchema,
  generationRequestSchema,
  messageCreateSchema,
  messageListQuerySchema,
  messageUpdateSchema,
  regenerateRequestSchema,
  resendRequestSchema,
  stopGenerationRequestSchema,
  userProfileUpdateSchema,
  settingsUpdateSchema,
  lanSyncRequestSchema
} from "../server-dist/schemas.js";
import { encryptApiKey, hasStoredApiKey } from "../server-dist/services/apiKeyVault.js";
import {
  completeChatCompletion,
  estimateTokenUsage,
  fetchAvailableModels,
  streamChatCompletion,
  testModelConnection
} from "../server-dist/services/completions.js";
import {
  assertCharacterUnlockPassword,
  buildCharacterUpdateData,
  canExportCharacterPublicly,
  createCharacterExportCard,
  importCharacterCard,
  isImportedPrivateCharacter,
  reEncryptImportedCharacter,
  resolveCharacterRecord,
  resolveCharacterPromptFields,
  toCharacterTags,
  toQuickReplies
} from "./privateCharacters.mjs";
import { MobileStore } from "./store.mjs";

const APP_NAME = "Star Companion Mobile Backend";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const port = Number(process.env.MOBILE_BACKEND_PORT ?? process.env.SERVER_PORT ?? 4110);
const host = process.env.MOBILE_BACKEND_HOST ?? "0.0.0.0";
const resolveDataDir = () => {
  if (process.env.MOBILE_BACKEND_DATA_DIR) {
    return process.env.MOBILE_BACKEND_DATA_DIR;
  }
  if (process.env.STAR_COMPANION_DATA_DIR) {
    return process.env.STAR_COMPANION_DATA_DIR;
  }

  try {
    const bridge = require("bridge");
    if (typeof bridge.getDataPath === "function") {
      return path.join(bridge.getDataPath(), "star-companion");
    }
  } catch {
    // The bridge module only exists inside the embedded mobile Node runtime.
  }

  return path.resolve(__dirname, "..", "data");
};
const dataDir = resolveDataDir();
const store = new MobileStore(path.join(dataDir, "mobile-backend.json"));
const exportDir = path.join(dataDir, "exports");

const parseBody = (schema, body) => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const error = new Error(parsed.error.issues.map((issue) => issue.message).join("; "));
    error.status = 400;
    throw error;
  }
  return parsed.data;
};

const parseQuery = (schema, query) => parseBody(schema, query);
const requireParam = (request, name) => {
  const value = request.params[name];
  if (!value) {
    const error = new Error(`Missing route parameter: ${name}`);
    error.status = 400;
    throw error;
  }
  return value;
};

const asyncHandler = (handler) => (request, response, next) => {
  Promise.resolve(handler(request, response, next)).catch(next);
};

const notFound = (message) => {
  const error = new Error(message);
  error.status = 404;
  return error;
};

const httpError = (status, message) => {
  const error = new Error(message);
  error.status = status;
  return error;
};

const toStringArray = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === "string") : []);

const dropUndefined = (value) =>
  Object.fromEntries(Object.entries(value).filter(([_key, entry]) => entry !== undefined));

const KEYWORD_CANDIDATE_LIMIT = 12;
const RERANKED_MEMORY_LIMIT = 5;
const AUTO_MEMORY_THROTTLE_MS = 30_000;
const RECENT_MEMORY_MESSAGE_LIMIT = 6;
const RECENT_PROFILE_MESSAGE_LIMIT = 16;
const EXISTING_MEMORY_LIMIT = 30;
const MAX_PROFILE_LENGTH = 1800;

const uniqueStrings = (values, limit) => [
  ...new Set(values.map((value) => value.trim()).filter(Boolean))
].slice(0, limit);

const extractJsonObject = (raw) => {
  const text = raw.trim();
  if (!text) return null;

  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }

    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
};

const parseJsonObject = (raw) => {
  const json = extractJsonObject(raw);
  if (!json) return null;

  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const tokenize = (value) =>
  uniqueStrings(value.toLowerCase().split(/[^0-9a-z_\u4e00-\u9fff-]+/g), 80)
    .filter((token) => token.length > 1);

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

const sanitizeExportFilename = (value) => {
  const fallback = `export-${new Date().toISOString().slice(0, 10)}.txt`;
  const filename = typeof value === "string" ? value.trim() : "";
  const safe = filename
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_")
    .replace(/\s+/g, " ")
    .slice(0, 120);
  return safe || fallback;
};

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isBoundaryKeyword = (value) => /^[a-z0-9][a-z0-9_-]*$/i.test(value);

const matchesKeyword = (key, contextText) => {
  const normalizedKey = key.trim().toLowerCase();
  if (!normalizedKey) return false;
  if (!isBoundaryKeyword(normalizedKey)) {
    return contextText.includes(normalizedKey);
  }
  return new RegExp(`(^|[^a-z0-9_])${escapeRegExp(normalizedKey)}(?=$|[^a-z0-9_])`, "i").test(contextText);
};

const normalizeLoreTriggerMode = (value) =>
  value === "user" || value === "assistant" ? value : "both";

const normalizeLoreScope = (value) =>
  value === "prefix" || value === "suffix" ? value : "prompt";

const buildLoreContexts = (recentMessages) => {
  const textFor = (roles) =>
    recentMessages
      .filter((message) => roles.includes(message.role))
      .map((message) => message.content ?? "")
      .join("\n")
      .toLowerCase();

  return {
    user: textFor(["user"]),
    assistant: textFor(["assistant"]),
    both: textFor(["user", "assistant"])
  };
};

const findMatchedLoreEntries = (character, promptFields, recentMessages) => {
  const entries = Array.isArray(promptFields?.loreEntries) ? promptFields.loreEntries : [];
  if (!character || entries.length === 0) return [];

  const contexts = buildLoreContexts(recentMessages);
  return entries
    .filter((entry) => entry?.enabled !== false)
    .filter((entry) => {
      if (entry.alwaysActive) return true;
      const triggerMode = normalizeLoreTriggerMode(entry.triggerMode);
      return toStringArray(entry.keys).some((key) => matchesKeyword(key, contexts[triggerMode]));
    })
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    .slice(0, 8)
    .map((entry) => ({
      id: entry.id,
      characterId: character.id,
      characterName: character.name,
      keys: toStringArray(entry.keys),
      content: entry.content ?? "",
      priority: entry.priority ?? 0,
      scope: normalizeLoreScope(entry.scope),
      triggerMode: normalizeLoreTriggerMode(entry.triggerMode),
      alwaysActive: Boolean(entry.alwaysActive),
      enabled: entry.enabled !== false
    }));
};

const buildCharacterSystemPrompt = (promptFields, loreEntries = []) => {
  if (!promptFields) return "";

  const loreFor = (scope) =>
    loreEntries
      .filter((entry) => entry.scope === scope)
      .map((entry) => entry.content.trim())
      .filter(Boolean)
      .join("\n\n");

  return [
    [promptFields.prefix?.trim(), loreFor("prefix")].filter(Boolean).join("\n\n"),
    [promptFields.prompt?.trim(), loreFor("prompt")].filter(Boolean).join("\n\n"),
    [promptFields.suffix?.trim(), loreFor("suffix")].filter(Boolean).join("\n\n")
  ]
    .filter(Boolean)
    .join("\n\n");
};

const scoreMemory = (memory, queryText, queryTokens) => {
  const lowerQuery = queryText.toLowerCase();
  const keywords = toStringArray(memory.keywords).map((keyword) => keyword.toLowerCase());
  const searchable = `${memory.title}\n${memory.content}`.toLowerCase();
  const searchableTokens = new Set(tokenize(searchable));
  const keywordScore = keywords.reduce(
    (total, keyword) => total + (keyword && lowerQuery.includes(keyword) ? 8 : 0),
    0
  );
  const tokenScore = [...queryTokens].reduce(
    (total, token) => total + (searchableTokens.has(token) ? 2 : searchable.includes(token) ? 1 : 0),
    0
  );
  const relevanceScore = keywordScore + tokenScore;
  if (relevanceScore <= 0) return 0;

  const importanceScore = (memory.importance ?? 3) * 1.5;
  const lastMatchedAt = memory.lastMatchedAt ? new Date(memory.lastMatchedAt).getTime() : 0;
  const recentMatchScore = lastMatchedAt
    ? Math.max(0, 2 - (Date.now() - lastMatchedAt) / (1000 * 60 * 60 * 24 * 14))
    : 0;

  return relevanceScore + importanceScore + recentMatchScore;
};

const toMatchedMemoryEntry = (memory, score) => ({
  ...serializeMemory(memory),
  score
});

const buildMemoryRerankMessages = (queryText, candidates) => [
  {
    role: "system",
    content: [
      "/no_think",
      "Select long-term chat memories that are useful for answering the next roleplay message.",
      "Only choose from the provided candidate IDs.",
      'Return JSON only: {"ids":["memory-id"]}.',
      "Do not write analysis, markdown, or any text outside the JSON object.",
      `Choose at most ${RERANKED_MEMORY_LIMIT} IDs. Return {"ids":[]} if none are relevant.`
    ].join("\n")
  },
  {
    role: "user",
    content: [
      `Current conversation context:\n${queryText}`,
      "",
      "Candidate memories:",
      candidates
        .map(
          (memory, index) =>
            `${index + 1}. id=${memory.id}\ntitle=${memory.title}\nimportance=${memory.importance}\nkeywords=${memory.keywords.join(", ")}\ncontent=${memory.content}`
        )
        .join("\n\n")
    ].join("\n")
  }
];

const parseRerankedIds = (raw, candidateIds) => {
  const parsed = parseJsonObject(raw);
  const ids = parsed ? parsed.ids : null;
  if (!Array.isArray(ids)) return [];
  return uniqueStrings(
    ids.filter((id) => typeof id === "string" && candidateIds.has(id)),
    RERANKED_MEMORY_LIMIT
  );
};

const rerankMemories = async (queryText, candidates, settings) => {
  if (candidates.length === 0) return [];
  if (!settings.apiKey) return candidates.slice(0, RERANKED_MEMORY_LIMIT);

  try {
    const candidateIds = new Set(candidates.map((candidate) => candidate.id));
    const raw = await completeChatCompletion({
      settings,
      messages: buildMemoryRerankMessages(queryText, candidates),
      maxTokens: 180,
      temperature: 0
    });
    const ids = parseRerankedIds(raw.trim(), candidateIds);
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const selected = ids.map((id) => byId.get(id)).filter(Boolean);
    return selected.length ? selected : candidates.slice(0, RERANKED_MEMORY_LIMIT);
  } catch {
    return candidates.slice(0, RERANKED_MEMORY_LIMIT);
  }
};

const recallChatMemories = async ({ chatId, query, recentMessages, settings }) => {
  const queryText = [query, ...recentMessages.map((message) => `${message.role}: ${message.content}`)]
    .join("\n")
    .trim();
  if (!queryText) return [];

  const queryTokens = new Set(tokenize(queryText));
  const candidates = store
    .listMemories(chatId)
    .filter((memory) => memory.enabled !== false)
    .map((memory) => toMatchedMemoryEntry(memory, scoreMemory(memory, queryText, queryTokens)))
    .filter((memory) => memory.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, KEYWORD_CANDIDATE_LIMIT);
  const selected = await rerankMemories(queryText, candidates, settings);

  if (selected.length) {
    const matchedAt = new Date().toISOString();
    await Promise.all(selected.map((memory) => store.updateMemory(chatId, memory.id, { lastMatchedAt: matchedAt })));
    return selected.map((memory) => ({ ...memory, lastMatchedAt: matchedAt }));
  }

  return [];
};

const formatMemorySystemPrompt = (memories) => {
  if (memories.length === 0) return "";

  return [
    "Relevant long-term chat memories:",
    ...memories.map((memory, index) => {
      const keywords = memory.keywords.length ? ` [${memory.keywords.join(", ")}]` : "";
      return `${index + 1}. ${memory.title}${keywords}\n${memory.content}`;
    })
  ].join("\n\n");
};

const buildUserProfileSummaryMessages = (currentSummary, userMessages) => [
  {
    role: "system",
    content: [
      "You maintain a concise local user profile memory for a roleplay chat app.",
      "Update the profile only with durable facts or habits explicitly supported by user messages.",
      "Include stable preferences, recurring style, boundaries, goals, names/pronouns if stated, and interaction habits.",
      "Do not include API keys, secrets, credentials, private addresses, unsupported guesses, or one-off transient requests.",
      "Keep it short, neutral, and useful for future assistant responses.",
      "Return only the updated profile summary. If there is no durable new information, return the existing summary."
    ].join("\n")
  },
  {
    role: "user",
    content: [
      `Existing user profile:\n${currentSummary || "(empty)"}`,
      "",
      "Recent user messages:",
      userMessages.map((message, index) => `${index + 1}. ${message}`).join("\n")
    ].join("\n")
  }
];

const updateUserProfileFromChat = async ({ chatId, settings }) => {
  if (settings.autoSummarizeUser === false) return null;

  const chat = store.getChat(chatId);
  if (!chat) return null;

  const recentContents = store
    .listMessages(chatId)
    .filter((message) => message.role === "user")
    .slice(-RECENT_PROFILE_MESSAGE_LIMIT)
    .map((message) => message.content.trim())
    .filter(Boolean);
  if (recentContents.length === 0) return null;

  const summary = (
    await completeChatCompletion({
      settings,
      messages: buildUserProfileSummaryMessages(chat.userProfileSummary ?? "", recentContents),
      maxTokens: 500,
      temperature: 0.2
    })
  )
    .trim()
    .slice(0, MAX_PROFILE_LENGTH);

  if (!summary || summary === chat.userProfileSummary) return null;

  return store.updateChat(chatId, {
    userProfileSummary: summary,
    userProfileUpdatedAt: new Date().toISOString()
  });
};

const buildChatMemoryMaintenanceMessages = (existingMemories, recentMessages) => [
  {
    role: "system",
    content: [
      "/no_think",
      "You maintain long-term memories for one local-first single-character roleplay chat.",
      "Extract durable plot facts, relationship changes, stable preferences, boundaries, plans, and recurring interaction patterns.",
      "Do not store API keys, credentials, secrets, exact private addresses, unsupported guesses, or one-off transient requests.",
      "Prefer updating existing memories over creating duplicates.",
      "Do not delete. You may disable a memory only when the conversation clearly makes it obsolete or false.",
      "Do not write analysis, markdown, bullet lists, or explanations.",
      "Return JSON only with this shape:",
      '{"actions":[{"type":"create","title":"...","content":"...","keywords":["..."],"importance":3},{"type":"update","id":"...","title":"...","content":"...","keywords":["..."],"importance":3,"enabled":true}]}'
    ].join("\n")
  },
  {
    role: "user",
    content: [
      "/no_think",
      "Existing memories:",
      existingMemories.length
        ? existingMemories
            .map(
              (memory, index) =>
                `${index + 1}. id=${memory.id}\ntitle=${memory.title}\nenabled=${memory.enabled !== false}\nimportance=${memory.importance ?? 3}\nkeywords=${toStringArray(memory.keywords).join(", ")}\ncontent=${memory.content}`
            )
            .join("\n\n")
        : "(none)",
      "",
      "Recent conversation:",
      recentMessages
        .map((message, index) => `${index + 1}. ${message.role}: ${message.content}`)
        .join("\n")
    ].join("\n")
  }
];

const clampImportance = (value) =>
  Math.min(5, Math.max(1, typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 3));

const normalizeMemoryAction = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  if (value.type === "create") {
    const title = typeof value.title === "string" ? value.title.trim().slice(0, 80) : "";
    const content = typeof value.content === "string" ? value.content.trim().slice(0, 1200) : "";
    if (!title || !content) return null;
    return {
      type: "create",
      title,
      content,
      keywords: uniqueStrings(
        Array.isArray(value.keywords)
          ? value.keywords.filter((keyword) => typeof keyword === "string")
          : [],
        12
      ),
      importance: clampImportance(value.importance)
    };
  }

  if (value.type === "update") {
    const id = typeof value.id === "string" ? value.id : "";
    if (!id) return null;
    return {
      type: "update",
      id,
      title: typeof value.title === "string" ? value.title.trim().slice(0, 80) : undefined,
      content: typeof value.content === "string" ? value.content.trim().slice(0, 1200) : undefined,
      keywords: Array.isArray(value.keywords)
        ? uniqueStrings(value.keywords.filter((keyword) => typeof keyword === "string"), 12)
        : undefined,
      importance: value.importance === undefined ? undefined : clampImportance(value.importance),
      enabled: typeof value.enabled === "boolean" ? value.enabled : undefined
    };
  }

  return null;
};

const parseMemoryActions = (raw) => {
  const parsed = parseJsonObject(raw);
  const actions = parsed ? parsed.actions : null;
  if (!Array.isArray(actions)) return null;
  return actions.map(normalizeMemoryAction).filter(Boolean);
};

const updateChatMemoriesFromTurn = async ({ chatId, settings, force = false }) => {
  const chat = store.getChat(chatId);
  if (!chat?.autoMemoryEnabled) return null;

  if (!force && chat.memoryUpdatedAt && Date.now() - new Date(chat.memoryUpdatedAt).getTime() < AUTO_MEMORY_THROTTLE_MS) {
    return null;
  }

  const recentMessages = store.listMessages(chatId).slice(-RECENT_MEMORY_MESSAGE_LIMIT);
  if (recentMessages.length === 0) return null;

  const existingMemories = store.listMemories(chatId).slice(0, EXISTING_MEMORY_LIMIT);
  const raw = await completeChatCompletion({
    settings,
    messages: buildChatMemoryMaintenanceMessages(existingMemories, recentMessages),
    maxTokens: 1600,
    temperature: 0.2
  });
  const actions = parseMemoryActions(raw.trim());
  if (!actions) return null;
  const existingIds = new Set(existingMemories.map((memory) => memory.id));
  const sourceMessageIds = recentMessages.map((message) => message.id);

  for (const action of actions.slice(0, 8)) {
    if (action.type === "create") {
      await store.createMemory({
        chatId,
        title: action.title,
        content: action.content,
        keywords: action.keywords,
        importance: action.importance,
        enabled: true,
        sourceMessageIds
      });
      continue;
    }

    if (!existingIds.has(action.id)) continue;
    await store.updateMemory(
      chatId,
      action.id,
      dropUndefined({
        title: action.title,
        content: action.content,
        keywords: action.keywords,
        importance: action.importance,
        enabled: action.enabled,
        sourceMessageIds
      })
    );
  }

  return store.updateChat(chatId, { memoryUpdatedAt: new Date().toISOString() });
};

const serializeSettings = (settings) => ({
  id: settings.id,
  activeProvider: settings.activeProvider,
  apiBaseUrl: settings.apiBaseUrl,
  model: settings.model,
  temperature: settings.temperature,
  maxTokens: settings.maxTokens,
  topP: settings.topP,
  language: settings.language === "en" ? "en" : "zh-CN",
  providers: Array.isArray(settings.providers) ? settings.providers : [],
  activeProviderId: settings.activeProviderId ?? "",
  activeModelId: settings.activeModelId ?? "",
  userProfileSummary: settings.userProfileSummary ?? "",
  autoSummarizeUser: settings.autoSummarizeUser !== false,
  showMessageAvatars: settings.showMessageAvatars !== false,
  userProfileUpdatedAt: settings.userProfileUpdatedAt ?? null,
  createdAt: settings.createdAt,
  updatedAt: settings.updatedAt
});

const serializeCharacter = (character, password) => {
  const resolved = resolveCharacterRecord(character, password);

  return {
    ...character,
    name: resolved.name,
    avatar: resolved.avatar,
    description: resolved.description,
    tags: toCharacterTags(character.tags),
    prefix: resolved.prefix,
    prompt: resolved.prompt,
    suffix: resolved.suffix,
    htmlCss: resolved.htmlCss,
    openingHtml: resolved.openingHtml,
    loreEntries: resolved.loreEntries,
    quickReplies: toQuickReplies(character.quickReplies),
    visibility: resolved.visibility,
    canViewPrompt: resolved.canViewPrompt
  };
};

const serializeChat = (chat, messageCount = chat.messageCount ?? 0) => ({
  id: chat.id,
  title: chat.title,
  characterId: chat.characterId ?? null,
  backgroundUrl: chat.backgroundUrl ?? "",
  messageCount,
  memoryTurns: chat.memoryTurns ?? 12,
  autoMemoryEnabled: chat.autoMemoryEnabled !== false,
  memoryUpdatedAt: chat.memoryUpdatedAt ?? null,
  userPersona: chat.userPersona ?? "",
  userProfileSummary: chat.userProfileSummary ?? "",
  userProfileUpdatedAt: chat.userProfileUpdatedAt ?? null,
  createdAt: chat.createdAt,
  updatedAt: chat.updatedAt
});

const serializeMemory = (memory) => ({
  id: memory.id,
  chatId: memory.chatId,
  title: memory.title,
  content: memory.content,
  keywords: toStringArray(memory.keywords),
  importance: memory.importance ?? 3,
  enabled: memory.enabled !== false,
  sourceMessageIds: toStringArray(memory.sourceMessageIds),
  lastMatchedAt: memory.lastMatchedAt ?? null,
  createdAt: memory.createdAt,
  updatedAt: memory.updatedAt
});

const serializeMessage = (message) => ({
  id: message.id,
  chatId: message.chatId,
  role: message.role === "assistant" || message.role === "system" ? message.role : "user",
  characterId: message.characterId ?? null,
  content: message.content ?? "",
  variants: toStringArray(message.variants),
  activeVariantIndex: message.activeVariantIndex ?? 0,
  tokenUsage: message.tokenUsage ?? null,
  loreMatches: Array.isArray(message.loreMatches) ? message.loreMatches : [],
  memoryMatches: Array.isArray(message.memoryMatches) ? message.memoryMatches : [],
  createdAt: message.createdAt,
  updatedAt: message.updatedAt
});

const publicSettings = (settings) => ({
  ...serializeSettings(settings),
  hasApiKey: hasStoredApiKey(settings.apiKey)
});

const getLanHosts = () =>
  Object.values(networkInterfaces())
    .flat()
    .filter((entry) => entry && entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address)
    .filter((address, index, addresses) => addresses.indexOf(address) === index);

const normalizePeerBaseUrl = (raw) => {
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  let url;
  try {
    url = new URL(withProtocol);
  } catch {
    throw httpError(400, "Peer address must be a valid http(s) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw httpError(400, "Peer address must use http or https.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
};

const requestPeer = async (peerBaseUrl, pathName, options = {}) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(`${peerBaseUrl}${pathName}`, {
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers ?? {})
      },
      signal: controller.signal
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      throw httpError(response.ok ? 502 : response.status, payload?.error ?? response.statusText ?? "Peer request failed");
    }
    return payload.data;
  } catch (error) {
    if (Number.isInteger(error?.status)) throw error;
    if (error?.name === "AbortError") throw httpError(504, "Peer request timed out.");
    throw httpError(502, error instanceof Error ? `Peer request failed: ${error.message}` : "Peer request failed");
  } finally {
    clearTimeout(timeout);
  }
};

const getPromptContext = async ({ chatId, before, excludeMessageIds = [] }) => {
  const chat = store.getChat(chatId);
  if (!chat) {
    throw notFound("Chat not found");
  }

  const character = chat.characterId ? store.getCharacter(chat.characterId) : null;
  const recentMessages = store
    .listMessages(chatId)
    .filter((message) => !before || new Date(message.createdAt) < before)
    .filter((message) => !excludeMessageIds.includes(message.id))
    .slice(-(Math.max(1, Math.min(chat.memoryTurns ?? 12, 50)) * 2 + 1));

  const messages = [];
  const characterPromptFields = character ? resolveCharacterPromptFields(character) : null;
  const matchedLoreEntries = findMatchedLoreEntries(character, characterPromptFields, recentMessages);
  const latestMessage = recentMessages.length > 0 ? recentMessages[recentMessages.length - 1] : null;
  const matchedMemoryEntries = await recallChatMemories({
    chatId,
    query: latestMessage?.content ?? "",
    recentMessages,
    settings: store.getSettings()
  });
  const characterPrompt = buildCharacterSystemPrompt(characterPromptFields, matchedLoreEntries);

  if (characterPrompt) {
    messages.push({ role: "system", content: characterPrompt });
  }
  if (chat.userPersona?.trim()) {
    messages.push({ role: "system", content: chat.userPersona.trim() });
  }
  if (chat.userProfileSummary?.trim()) {
    messages.push({ role: "system", content: `User profile:\n${chat.userProfileSummary.trim()}` });
  }
  const memoryPrompt = formatMemorySystemPrompt(matchedMemoryEntries);
  if (memoryPrompt) {
    messages.push({ role: "system", content: memoryPrompt });
  }
  for (const message of recentMessages) {
    if (message.role === "system") continue;
    messages.push({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content
    });
  }

  return { chat, messages, matchedLoreEntries, matchedMemoryEntries };
};

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "10mb" }));

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    app: APP_NAME,
    database: "sqlite",
    timestamp: new Date().toISOString()
  });
});

app.get("/api/characters", (_request, response) => {
  response.json({ ok: true, data: store.listCharacters().map(serializeCharacter) });
});

app.get(
  "/api/characters/page",
  asyncHandler(async (request, response) => {
    const query = parseQuery(characterPageQuerySchema, request.query);
    const normalizedQ = query.q.toLowerCase();
    const normalizedTag = query.tag.toLowerCase();
    const all = store
      .listCharacters()
      .filter((character) =>
        normalizedQ
          ? [character.name, character.description, character.prompt]
              .join("\n")
              .toLowerCase()
              .includes(normalizedQ)
          : true
      )
      .filter((character) =>
        normalizedTag ? toStringArray(character.tags).some((tag) => tag.toLowerCase() === normalizedTag) : true
      );
    const total = all.length;
    const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
    const page = Math.min(query.page, totalPages);
    const start = (page - 1) * query.pageSize;
    const availableTags = [
      ...new Set(
        store
          .listCharacters()
          .flatMap((character) => toStringArray(character.tags))
          .map((tag) => tag.trim())
          .filter(Boolean)
      )
    ].sort((a, b) => a.localeCompare(b));

    response.json({
      ok: true,
      data: {
        items: all.slice(start, start + query.pageSize).map(serializeCharacter),
        page,
        pageSize: query.pageSize,
        total,
        totalPages,
        availableTags
      }
    });
  })
);

app.post(
  "/api/characters",
  asyncHandler(async (request, response) => {
    const body = parseBody(characterCreateSchema, request.body);
    const character = await store.createCharacter(body);
    response.status(201).json({ ok: true, data: serializeCharacter(character) });
  })
);

app.post(
  "/api/characters/import",
  asyncHandler(async (request, response) => {
    const body = parseBody(characterImportSchema, request.body);
    const character = await store.upsertCharacterByCardId(importCharacterCard(body));
    response.status(201).json({ ok: true, data: serializeCharacter(character) });
  })
);

app.post(
  "/api/characters/:id/export",
  asyncHandler(async (request, response) => {
    const character = store.getCharacter(requireParam(request, "id"));
    if (!character) throw notFound("Character not found");
    const body = parseBody(characterExportSchema, request.body);
    if (body.visibility === "public" && !canExportCharacterPublicly(character, body.password)) {
      const error = new Error("Private character password is required to export this character publicly");
      error.status = 403;
      throw error;
    }
    response.json({ ok: true, data: createCharacterExportCard(character, body.visibility, body.password) });
  })
);

app.post(
  "/api/characters/:id/unlock",
  asyncHandler(async (request, response) => {
    const body = parseBody(characterUnlockSchema, request.body);
    const character = store.getCharacter(requireParam(request, "id"));
    if (!character) throw notFound("Character not found");
    assertCharacterUnlockPassword(character, body.password);

    if (isImportedPrivateCharacter(character)) {
      const reEncrypted = reEncryptImportedCharacter(character, body.password);
      const updated = await store.updateCharacter(character.id, { loreEntries: reEncrypted });
      response.json({ ok: true, data: serializeCharacter(updated, body.password) });
      return;
    }

    response.json({ ok: true, data: serializeCharacter(character, body.password) });
  })
);

app.get("/api/characters/:id", (request, response) => {
  const character = store.getCharacter(requireParam(request, "id"));
  if (!character) throw notFound("Character not found");
  response.json({ ok: true, data: serializeCharacter(character) });
});

app.put(
  "/api/characters/:id",
  asyncHandler(async (request, response) => {
    const body = parseBody(characterUpdateRequestSchema, request.body);
    const id = requireParam(request, "id");
    const existing = store.getCharacter(id);
    if (!existing) throw notFound("Character not found");

    const { accessPassword, ...updates } = body;
    const character = await store.updateCharacter(
      id,
      dropUndefined(buildCharacterUpdateData(existing, updates, accessPassword))
    );
    response.json({ ok: true, data: serializeCharacter(character, accessPassword) });
  })
);

app.delete(
  "/api/characters/:id",
  asyncHandler(async (request, response) => {
    const deleted = await store.deleteCharacter(requireParam(request, "id"));
    if (!deleted) throw notFound("Character not found");
    response.status(204).send();
  })
);

app.post(
  "/api/characters/batch-delete",
  asyncHandler(async (request, response) => {
    const body = parseBody(characterBatchDeleteSchema, request.body);
    let deleted = 0;
    for (const id of body.ids) {
      if (await store.deleteCharacter(id)) deleted += 1;
    }
    response.json({ ok: true, data: { deleted } });
  })
);

app.post("/api/characters/batch-fetch", (request, response) => {
  const body = parseBody(characterBatchFetchSchema, request.body);
  response.json({
    ok: true,
    data: body.ids.map((id) => store.getCharacter(id)).filter(Boolean).map(serializeCharacter)
  });
});

app.get("/api/chats", (_request, response) => {
  response.json({ ok: true, data: store.listChats().map((chat) => serializeChat(chat, chat.messageCount)) });
});

app.post(
  "/api/chats",
  asyncHandler(async (request, response) => {
    const body = parseBody(chatCreateSchema, request.body);
    if (body.characterId && !store.getCharacter(body.characterId)) throw notFound("Character not found");
    const chat = await store.createChat(body);
    response.status(201).json({ ok: true, data: serializeChat(chat) });
  })
);

app.get("/api/chats/:id/memories", (request, response) => {
  const chatId = requireParam(request, "id");
  if (!store.getChat(chatId)) throw notFound("Chat not found");
  response.json({ ok: true, data: store.listMemories(chatId).map(serializeMemory) });
});

app.post(
  "/api/chats/:id/memories",
  asyncHandler(async (request, response) => {
    const chatId = requireParam(request, "id");
    if (!store.getChat(chatId)) throw notFound("Chat not found");
    const body = parseBody(chatMemoryCreateSchema, request.body);
    const memory = await store.createMemory({ ...body, chatId });
    response.status(201).json({ ok: true, data: serializeMemory(memory) });
  })
);

app.put(
  "/api/chats/:id/memories/:memoryId",
  asyncHandler(async (request, response) => {
    const body = parseBody(chatMemoryUpdateSchema, request.body);
    const memory = await store.updateMemory(
      requireParam(request, "id"),
      requireParam(request, "memoryId"),
      body
    );
    if (!memory) throw notFound("Memory not found");
    response.json({ ok: true, data: serializeMemory(memory) });
  })
);

app.delete(
  "/api/chats/:id/memories/:memoryId",
  asyncHandler(async (request, response) => {
    const deleted = await store.deleteMemory(requireParam(request, "id"), requireParam(request, "memoryId"));
    if (!deleted) throw notFound("Memory not found");
    response.status(204).send();
  })
);

app.post(
  "/api/chats/:id/memories/refresh",
  asyncHandler(async (request, response) => {
    const chatId = requireParam(request, "id");
    if (!store.getChat(chatId)) throw notFound("Chat not found");
    await updateChatMemoriesFromTurn({
      chatId,
      settings: store.getSettings(),
      force: true
    });
    response.json({ ok: true, data: store.listMemories(chatId).map(serializeMemory) });
  })
);

app.get("/api/chats/:id", (request, response) => {
  const chat = store.getChat(requireParam(request, "id"));
  if (!chat) throw notFound("Chat not found");
  response.json({
    ok: true,
    data: {
      ...serializeChat(chat),
      messages: store.listMessages(chat.id).map(serializeMessage),
      memories: store.listMemories(chat.id).map(serializeMemory)
    }
  });
});

app.put(
  "/api/chats/:id",
  asyncHandler(async (request, response) => {
    const body = parseBody(chatUpdateSchema, request.body);
    const chat = await store.updateChat(requireParam(request, "id"), body);
    if (!chat) throw notFound("Chat not found");
    response.json({ ok: true, data: serializeChat(chat) });
  })
);

app.delete(
  "/api/chats/:id",
  asyncHandler(async (request, response) => {
    const deleted = await store.deleteChat(requireParam(request, "id"));
    if (!deleted) throw notFound("Chat not found");
    response.status(204).send();
  })
);

app.get("/api/messages", (request, response) => {
  const query = parseQuery(messageListQuerySchema, request.query);
  response.json({ ok: true, data: store.listMessages(query.chatId).map(serializeMessage) });
});

app.post(
  "/api/messages",
  asyncHandler(async (request, response) => {
    const body = parseBody(messageCreateSchema, request.body);
    if (!store.getChat(body.chatId)) throw notFound("Chat not found");
    const message = await store.createMessage(body);
    response.status(201).json({ ok: true, data: serializeMessage(message) });
  })
);

app.get("/api/messages/:id", (request, response) => {
  const message = store.getMessage(requireParam(request, "id"));
  if (!message) throw notFound("Message not found");
  response.json({ ok: true, data: serializeMessage(message) });
});

app.put(
  "/api/messages/:id",
  asyncHandler(async (request, response) => {
    const body = parseBody(messageUpdateSchema, request.body);
    const message = await store.updateMessage(requireParam(request, "id"), body);
    if (!message) throw notFound("Message not found");
    response.json({ ok: true, data: serializeMessage(message) });
  })
);

app.delete(
  "/api/messages/:id",
  asyncHandler(async (request, response) => {
    const message = await store.deleteMessage(requireParam(request, "id"));
    if (!message) throw notFound("Message not found");
    response.status(204).send();
  })
);

app.get("/api/settings", (_request, response) => {
  response.json({ ok: true, data: publicSettings(store.getSettings()) });
});

app.put(
  "/api/settings",
  asyncHandler(async (request, response) => {
    const body = parseBody(settingsUpdateSchema, request.body);
    const activeProfile = body.providers.find((provider) => provider.id === body.activeProviderId);
    const activeModel = activeProfile?.models.find((model) => model.id === body.activeModelId);
    const resolvedApiKey =
      activeProfile?.key ?? (hasOwn(body, "apiKey") ? body.apiKey : undefined);
    const settings = await store.updateSettings({
      providers: body.providers,
      activeProviderId: body.activeProviderId,
      activeModelId: body.activeModelId,
      activeProvider: activeProfile?.provider ?? body.activeProvider,
      apiBaseUrl: activeProfile?.apiBaseUrl ?? body.apiBaseUrl,
      model: activeModel?.model ?? body.model,
      temperature: body.temperature,
      maxTokens: body.maxTokens,
      topP: body.topP,
      language: body.language,
      autoSummarizeUser: body.autoSummarizeUser,
      showMessageAvatars: body.showMessageAvatars,
      userProfileSummary: body.userProfileSummary,
      userProfileUpdatedAt:
        typeof body.userProfileSummary === "string" ? new Date().toISOString() : undefined,
      ...(resolvedApiKey !== undefined ? { apiKey: encryptApiKey(resolvedApiKey) } : {})
    });
    response.json({ ok: true, data: publicSettings(settings) });
  })
);

app.put(
  "/api/settings/user-profile",
  asyncHandler(async (request, response) => {
    const body = parseBody(userProfileUpdateSchema, request.body);
    const summary = body.userProfileSummary.trim();
    const settings = await store.updateSettings({
      userProfileSummary: summary,
      autoSummarizeUser: body.autoSummarizeUser,
      userProfileUpdatedAt: summary ? new Date().toISOString() : null
    });
    response.json({ ok: true, data: publicSettings(settings) });
  })
);

app.post("/api/settings/test", asyncHandler(async (_request, response) => {
  response.json({ ok: true, data: await testModelConnection(store.getSettings()) });
}));

app.get("/api/settings/models", asyncHandler(async (_request, response) => {
  response.json({ ok: true, data: await fetchAvailableModels(store.getSettings()) });
}));

app.post("/api/settings/providers/:providerId/models", asyncHandler(async (request, response) => {
  const settings = store.getSettings();
  const body = request.body;
  const provider =
    body && typeof body.apiBaseUrl === "string"
      ? { provider: body.provider ?? "", apiBaseUrl: body.apiBaseUrl, key: body.key }
      : (settings.providers ?? []).find((entry) => entry.id === request.params.providerId);
  if (!provider) throw notFound("Provider not found");
  response.json({
    ok: true,
    data: await fetchAvailableModels({
      ...settings,
      activeProvider: provider.provider,
      apiBaseUrl: provider.apiBaseUrl,
      apiKey: provider.key ?? settings.apiKey
    })
  });
}));

app.get("/api/backups/export", (_request, response) => {
  response.json({ ok: true, data: store.exportBackup(serializeSettings(store.getSettings())) });
});

app.post(
  "/api/backups/import",
  asyncHandler(async (request, response) => {
    const backup = parseBody(backupImportSchema, request.body);
    response.json({ ok: true, data: await store.importBackup(backup) });
  })
);

app.post(
  "/api/exports/text",
  asyncHandler(async (request, response) => {
    const filename = sanitizeExportFilename(request.body?.filename);
    const content = typeof request.body?.content === "string" ? request.body.content : "";
    if (!content.trim()) {
      const error = new Error("Export content is empty");
      error.status = 400;
      throw error;
    }

    await mkdir(exportDir, { recursive: true });
    const filePath = path.join(exportDir, filename);
    await writeFile(filePath, content, "utf8");

    response.json({
      ok: true,
      data: {
        filename,
        path: filePath,
        url: `file://${filePath.replace(/\\/g, "/")}`
      }
    });
  })
);

app.get("/api/sync/info", (request, response) => {
  const localUrl = `http://127.0.0.1:${port}`;
  const lanUrls = host === "127.0.0.1" || host === "localhost"
    ? []
    : getLanHosts().map((address) => `http://${address}:${port}`);

  response.json({
    ok: true,
    data: {
      localUrl,
      lanUrls,
      currentOrigin: `${request.protocol}://${request.get("host") ?? `127.0.0.1:${port}`}`,
      port,
      listeningHost: host,
      lanReachable: lanUrls.length > 0,
      checkedAt: new Date().toISOString()
    }
  });
});

app.post(
  "/api/sync/pull",
  asyncHandler(async (request, response) => {
    const input = parseBody(lanSyncRequestSchema, request.body);
    const peerBaseUrl = normalizePeerBaseUrl(input.peerBaseUrl);
    const peerBackup = await requestPeer(peerBaseUrl, "/api/backups/export");
    const backup = parseBody(backupImportSchema, { ...peerBackup, mode: input.mode });
    const summary = await store.importBackup(backup);

    response.json({
      ok: true,
      data: {
        direction: "pull",
        mode: input.mode,
        peerBaseUrl,
        peerExportedAt: peerBackup.exportedAt ?? null,
        completedAt: new Date().toISOString(),
        summary
      }
    });
  })
);

app.post(
  "/api/sync/push",
  asyncHandler(async (request, response) => {
    const input = parseBody(lanSyncRequestSchema, request.body);
    const peerBaseUrl = normalizePeerBaseUrl(input.peerBaseUrl);
    const localBackup = store.exportBackup(serializeSettings(store.getSettings()));
    const summary = await requestPeer(peerBaseUrl, "/api/backups/import", {
      method: "POST",
      body: JSON.stringify({ ...localBackup, mode: input.mode })
    });

    response.json({
      ok: true,
      data: {
        direction: "push",
        mode: input.mode,
        peerBaseUrl,
        peerExportedAt: null,
        completedAt: new Date().toISOString(),
        summary
      }
    });
  })
);

app.use((error, _request, response, _next) => {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  response.status(status).json({
    ok: false,
    error: error instanceof Error ? error.message : "Internal server error"
  });
});

const controllers = new Map();
const sendJson = (socket, value) => {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(value));
  }
};

const appendVariant = (value, content) => {
  const variants = toStringArray(value);
  if (!variants.includes(content)) variants.push(content);
  return variants;
};

const createAssistantReply = async ({
  socket,
  requestId,
  chatId,
  targetMessageId,
  excludeMessageIds = [],
  abortController
}) => {
  const targetMessage = targetMessageId ? store.getMessage(targetMessageId) : null;
  const context = await getPromptContext({
    chatId,
    before: targetMessage?.createdAt ? new Date(targetMessage.createdAt) : undefined,
    excludeMessageIds
  });
  sendJson(socket, {
    type: "generation_character_started",
    requestId,
    characterId: context.chat.characterId,
    index: 0,
    total: 1
  });
  sendJson(socket, { type: "lore_matches", requestId, entries: context.matchedLoreEntries });
  sendJson(socket, { type: "memory_matches", requestId, entries: context.matchedMemoryEntries });

  let content = "";
  let tokenUsage = null;
  for await (const event of streamChatCompletion({
    settings: store.getSettings(),
    messages: context.messages,
    signal: abortController.signal
  })) {
    if (event.type === "usage") {
      tokenUsage = event.usage;
      continue;
    }
    content += event.content;
    sendJson(socket, { type: "token", requestId, content: event.content });
  }

  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error("Model returned an empty response");
  }

  tokenUsage ??= estimateTokenUsage(context.messages, trimmed);
  const message = targetMessageId
    ? await store.updateMessage(targetMessageId, {
        content: trimmed,
        variants: appendVariant(targetMessage.variants, trimmed),
        activeVariantIndex: appendVariant(targetMessage.variants, trimmed).length - 1,
        tokenUsage,
        loreMatches: context.matchedLoreEntries,
        memoryMatches: context.matchedMemoryEntries
      })
    : await store.createMessage({
        chatId,
        role: "assistant",
        characterId: context.chat.characterId,
        content: trimmed,
        variants: [trimmed],
        activeVariantIndex: 0,
        tokenUsage,
        loreMatches: context.matchedLoreEntries,
        memoryMatches: context.matchedMemoryEntries
      });

  sendJson(socket, { type: "assistant_message", requestId, message: serializeMessage(message) });
};

const handleGenerate = async (socket, raw) => {
  const parsed = generationRequestSchema.safeParse(raw);
  if (!parsed.success) {
    sendJson(socket, { type: "error", error: "Invalid generation request" });
    return;
  }
  const request = parsed.data;
  const abortController = new AbortController();
  controllers.set(request.requestId, abortController);

  try {
    const chat = store.getChat(request.chatId);
    if (!chat) throw notFound("Chat not found");
    sendJson(socket, { type: "generation_started", requestId: request.requestId });
    const userMessage = await store.createMessage({
      chatId: request.chatId,
      role: "user",
      content: request.content,
      variants: [],
      activeVariantIndex: 0
    });
    sendJson(socket, {
      type: "user_message",
      requestId: request.requestId,
      message: serializeMessage(userMessage)
    });
    await createAssistantReply({
      socket,
      requestId: request.requestId,
      chatId: request.chatId,
      abortController
    });
    try {
      const settings = store.getSettings();
      const updatedChat = await updateUserProfileFromChat({
        chatId: request.chatId,
        settings
      });
      await updateChatMemoriesFromTurn({
        chatId: request.chatId,
        settings
      });
      if (updatedChat) {
        sendJson(socket, {
          type: "user_profile_updated",
          requestId: request.requestId,
          summary: updatedChat.userProfileSummary,
          updatedAt: updatedChat.userProfileUpdatedAt ?? null
        });
      }
    } catch {
      // Best-effort memory maintenance must not break chat generation.
    }
    sendJson(socket, { type: "generation_done", requestId: request.requestId });
  } catch (error) {
    sendJson(socket, {
      type: abortController.signal.aborted ? "generation_stopped" : "error",
      requestId: request.requestId,
      error: error instanceof Error ? error.message : "Generation failed"
    });
  } finally {
    controllers.delete(request.requestId);
  }
};

const handleRegenerate = async (socket, raw) => {
  const parsed = regenerateRequestSchema.safeParse(raw);
  if (!parsed.success) {
    sendJson(socket, { type: "error", error: "Invalid regenerate request" });
    return;
  }
  const request = parsed.data;
  const target = store.getMessage(request.messageId);
  if (!target || target.role !== "assistant") {
    sendJson(socket, { type: "error", requestId: request.requestId, error: "Assistant message not found" });
    return;
  }
  const abortController = new AbortController();
  controllers.set(request.requestId, abortController);
  try {
    sendJson(socket, { type: "generation_started", requestId: request.requestId });
    await createAssistantReply({
      socket,
      requestId: request.requestId,
      chatId: target.chatId,
      targetMessageId: target.id,
      excludeMessageIds: [target.id],
      abortController
    });
    sendJson(socket, { type: "generation_done", requestId: request.requestId });
  } catch (error) {
    sendJson(socket, { type: "error", requestId: request.requestId, error: error.message });
  } finally {
    controllers.delete(request.requestId);
  }
};

const handleResend = async (socket, raw) => {
  const parsed = resendRequestSchema.safeParse(raw);
  if (!parsed.success) {
    sendJson(socket, { type: "error", error: "Invalid resend request" });
    return;
  }
  const request = parsed.data;
  const target = store.getMessage(request.messageId);
  if (!target || target.role !== "user") {
    sendJson(socket, { type: "error", requestId: request.requestId, error: "User message not found" });
    return;
  }
  const abortController = new AbortController();
  controllers.set(request.requestId, abortController);
  try {
    await store.deleteMessagesAfter(target);
    sendJson(socket, { type: "generation_started", requestId: request.requestId });
    const userMessage = await store.createMessage({
      chatId: target.chatId,
      role: "user",
      content: target.content,
      variants: [],
      activeVariantIndex: 0
    });
    sendJson(socket, { type: "user_message", requestId: request.requestId, message: serializeMessage(userMessage) });
    await createAssistantReply({
      socket,
      requestId: request.requestId,
      chatId: target.chatId,
      abortController
    });
    try {
      const settings = store.getSettings();
      const updatedChat = await updateUserProfileFromChat({
        chatId: target.chatId,
        settings
      });
      await updateChatMemoriesFromTurn({
        chatId: target.chatId,
        settings
      });
      if (updatedChat) {
        sendJson(socket, {
          type: "user_profile_updated",
          requestId: request.requestId,
          summary: updatedChat.userProfileSummary,
          updatedAt: updatedChat.userProfileUpdatedAt ?? null
        });
      }
    } catch {
      // Best-effort memory maintenance must not break chat generation.
    }
    sendJson(socket, { type: "generation_done", requestId: request.requestId });
  } catch (error) {
    sendJson(socket, { type: "error", requestId: request.requestId, error: error.message });
  } finally {
    controllers.delete(request.requestId);
  }
};

const handleStop = (socket, raw) => {
  const parsed = stopGenerationRequestSchema.safeParse(raw);
  if (!parsed.success) {
    sendJson(socket, { type: "error", error: "Invalid stop request" });
    return;
  }
  controllers.get(parsed.data.requestId)?.abort();
};

const startServer = async () => {
  await store.load();
  const httpServer = createServer(app);
  const wsServer = new WebSocketServer({ server: httpServer, path: "/ws" });

  wsServer.on("connection", (socket) => {
    sendJson(socket, { type: "ready", app: APP_NAME });
    socket.on("message", (message) => {
      try {
        const parsed = JSON.parse(message.toString());
        if (parsed.type === "generate") void handleGenerate(socket, parsed);
        else if (parsed.type === "regenerate") void handleRegenerate(socket, parsed);
        else if (parsed.type === "resend") void handleResend(socket, parsed);
        else if (parsed.type === "stop") handleStop(socket, parsed);
        else sendJson(socket, { type: "error", error: "Unknown WebSocket message type" });
      } catch {
        sendJson(socket, { type: "error", error: "Malformed WebSocket message" });
      }
    });
  });

  httpServer.on("error", (error) => {
    console.error(`${APP_NAME} server error`, error);
  });

  httpServer.listen(port, host, () => {
    console.log(`${APP_NAME} listening on http://${host}:${port}`);
  });
};

startServer().catch((error) => {
  console.error(`${APP_NAME} failed to start`, error);
});
