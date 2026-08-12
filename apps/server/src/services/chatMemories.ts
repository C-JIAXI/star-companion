import { randomUUID } from "node:crypto";
import type { Prisma, ChatMemory, Message, UserSettings } from "@prisma/client";
import { prisma } from "../db.js";
import { type ChatCompletionMessage } from "./completions.js";
import { executeReliableTextCompletion } from "./reliableModelCalls.js";
import { generateReliableEmbeddings as generateEmbeddings } from "./reliableEmbeddings.js";
import { resolveModuleSettings } from "./moduleModels.js";
import { createMemoryInTransaction, pruneMemoryOperations, updateMemoryInTransaction } from "./memoryHistory.js";

const KEYWORD_CANDIDATE_LIMIT = 12;
const RERANKED_MEMORY_LIMIT = 5;
const AUTO_MEMORY_THROTTLE_MS = 30_000;
const RECENT_MESSAGE_LIMIT = 6;
const EXISTING_MEMORY_LIMIT = 30;
const EMBEDDING_BATCH_SIZE = 64;
const SEMANTIC_SIMILARITY_THRESHOLD = 0.25;
const embeddingRefreshes = new Map<string, Promise<EmbeddingIndex | null>>();

type EmbeddingIndex = {
  settings: UserSettings;
  source: string;
  dimensions: number;
  vectors: Map<string, number[]>;
};

export type MatchedMemoryEntry = {
  id: string;
  chatId: string;
  title: string;
  content: string;
  keywords: string[];
  importance: number;
  enabled: boolean;
  score: number;
  embeddingModel: string | null;
  embeddingSource: string | null;
  embeddingDimensions: number | null;
  embeddingStatus: "ready" | "stale" | "failed" | "unavailable";
  embeddingUpdatedAt: string | null;
  lastMatchedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const toStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
};

const uniqueStrings = (values: string[], limit: number) => [
  ...new Set(values.map((value) => value.trim()).filter(Boolean))
].slice(0, limit);

const extractJsonObject = (raw: string) => {
  const text = raw.trim();
  if (!text) {
    return null;
  }

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
      if (depth === 0) {
        start = index;
      }
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

const parseJsonObject = (raw: string) => {
  const json = extractJsonObject(raw);
  if (!json) {
    return null;
  }

  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const tokenize = (value: string) =>
  uniqueStrings(value.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [], 80)
    .filter((token) => token.length > 1);

const toNumberArray = (value: unknown): number[] | null => {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))
  ) {
    return null;
  }
  return value as number[];
};

const toMemoryEmbeddingText = (memory: Pick<ChatMemory, "title" | "content" | "keywords">) =>
  [
    memory.title.trim(),
    memory.content.trim(),
    toStringArray(memory.keywords).length
      ? `Keywords: ${toStringArray(memory.keywords).join(", ")}`
      : ""
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 6000);

export const cosineSimilarity = (left: number[], right: number[]) => {
  if (left.length === 0 || left.length !== right.length) {
    return 0;
  }

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] * left[index];
    rightMagnitude += right[index] * right[index];
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
};

export const getMemoryEmbeddingSource = (settings: UserSettings) =>
  [
    settings.activeProvider.trim().toLowerCase(),
    settings.apiBaseUrl.trim().replace(/\/+$/, "").toLowerCase(),
    settings.model.trim()
  ].join(":");

export const getConfiguredMemoryEmbeddingSource = (settings: UserSettings) =>
  getMemoryEmbeddingSource(resolveModuleSettings(settings, "memory_embedding"));

const ensureMemoryEmbeddings = async (
  memories: ChatMemory[],
  settings: UserSettings,
  force = false
) => {
  let embeddingSettings: UserSettings;
  try {
    embeddingSettings = resolveModuleSettings(settings, "memory_embedding");
  } catch {
    return null;
  }

  const embeddingSource = getMemoryEmbeddingSource(embeddingSettings);
  const embeddingModel = `${embeddingSettings.activeProvider.trim().toLowerCase()}:${embeddingSettings.model.trim()}`;
  const vectors = new Map<string, number[]>();
  const stale = memories.filter((memory) => {
    const vector = toNumberArray(memory.embedding);
    if (
      !force &&
      memory.embeddingStatus === "ready" &&
      memory.embeddingSource === embeddingSource &&
      memory.embeddingDimensions === vector?.length &&
      vector
    ) {
      vectors.set(memory.id, vector);
      return false;
    }
    return true;
  });
  const pendingIds = new Set(stale.map((memory) => memory.id));

  try {
    for (let start = 0; start < stale.length; start += EMBEDDING_BATCH_SIZE) {
      const batch = stale.slice(start, start + EMBEDDING_BATCH_SIZE);
      const result = await generateEmbeddings({
        settings: embeddingSettings,
        inputs: batch.map(toMemoryEmbeddingText),
        task: "document"
      });
      const updatedAt = new Date();

      for (let index = 0; index < batch.length; index += 1) {
        const memory = batch[index];
        const vector = result.vectors[index];
        vectors.set(memory.id, vector);
        await prisma.chatMemory.update({
          where: { id: memory.id },
          data: {
            embedding: vector as Prisma.InputJsonValue,
            embeddingModel,
            embeddingSource,
            embeddingDimensions: vector.length,
            embeddingStatus: "ready",
            embeddingUpdatedAt: updatedAt
          }
        });
        pendingIds.delete(memory.id);
      }
    }

    const dimensions = vectors.values().next().value?.length;
    if (!dimensions || [...vectors.values()].some((vector) => vector.length !== dimensions)) {
      return null;
    }
    return { settings: embeddingSettings, source: embeddingSource, dimensions, vectors };
  } catch {
    if (pendingIds.size) {
      await prisma.chatMemory.updateMany({
        where: { id: { in: [...pendingIds] } },
        data: { embeddingStatus: "failed" }
      });
    }
    return null;
  }
};

export const refreshChatMemoryEmbeddings = async ({
  chatId,
  settings,
  force = false
}: {
  chatId: string;
  settings: UserSettings;
  force?: boolean;
}) => {
  const existing = embeddingRefreshes.get(chatId);
  if (existing) {
    if (!force) return existing;
    await existing;
  }
  const refresh = (async () => {
    const memories = await prisma.chatMemory.findMany({
      where: { chatId, enabled: true, deletedAt: null },
      orderBy: { updatedAt: "desc" }
    });
    return ensureMemoryEmbeddings(memories, settings, force);
  })().finally(() => embeddingRefreshes.delete(chatId));
  embeddingRefreshes.set(chatId, refresh);
  return refresh;
};

const toMatchedMemoryEntry = (memory: ChatMemory, score: number): MatchedMemoryEntry => ({
  id: memory.id,
  chatId: memory.chatId,
  title: memory.title,
  content: memory.content,
  keywords: toStringArray(memory.keywords),
  importance: memory.importance,
  enabled: memory.enabled,
  score,
  embeddingModel: memory.embeddingModel,
  embeddingSource: memory.embeddingSource,
  embeddingDimensions: memory.embeddingDimensions,
  embeddingStatus: (memory.embeddingStatus as MatchedMemoryEntry["embeddingStatus"]) ?? "stale",
  embeddingUpdatedAt: memory.embeddingUpdatedAt?.toISOString() ?? null,
  lastMatchedAt: memory.lastMatchedAt?.toISOString() ?? null,
  createdAt: memory.createdAt.toISOString(),
  updatedAt: memory.updatedAt.toISOString()
});

const scoreMemory = (memory: ChatMemory, queryText: string, queryTokens: Set<string>) => {
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
  if (relevanceScore <= 0) {
    return 0;
  }

  const importanceScore = memory.importance * 1.5;
  const recentMatchScore = memory.lastMatchedAt
    ? Math.max(0, 2 - (Date.now() - memory.lastMatchedAt.getTime()) / (1000 * 60 * 60 * 24 * 14))
    : 0;

  return relevanceScore + importanceScore + recentMatchScore;
};

export const buildMemoryRerankMessages = (
  queryText: string,
  candidates: MatchedMemoryEntry[]
): ChatCompletionMessage[] => [
  {
    role: "system",
    content: [
      "/no_think",
      "Select long-term chat memories that are useful for answering the next roleplay message.",
      "Only choose from the provided candidate IDs.",
      `Return JSON only: {"ids":["memory-id"]}.`,
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

const parseRerankedIds = (raw: string, candidateIds: Set<string>) => {
  const parsed = parseJsonObject(raw);
  if (!parsed) {
    return [];
  }

  const ids = (parsed as { ids?: unknown }).ids;
  if (!Array.isArray(ids)) {
    return [];
  }

  return uniqueStrings(
    ids.filter((id): id is string => typeof id === "string" && candidateIds.has(id)),
    RERANKED_MEMORY_LIMIT
  );
};

const rerankMemories = async (
  queryText: string,
  candidates: MatchedMemoryEntry[],
  settings: UserSettings
) => {
  if (candidates.length === 0) {
    return [];
  }

  const moduleSettings = resolveModuleSettings(settings, "memory");
  if (!moduleSettings.apiKey) {
    return candidates.slice(0, RERANKED_MEMORY_LIMIT);
  }

  try {
    const candidateIds = new Set(candidates.map((candidate) => candidate.id));
    const raw = (await executeReliableTextCompletion({
      settings: moduleSettings,
      messages: buildMemoryRerankMessages(queryText, candidates),
      maxTokens: 180,
      temperature: 0,
      context: { requestId: `memory_rerank_${randomUUID()}`, module: "memory", operation: "rerank" }
    })).content;
    const ids = parseRerankedIds(raw.trim(), candidateIds);
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const selected = ids.map((id) => byId.get(id)).filter((item): item is MatchedMemoryEntry => Boolean(item));
    return selected.length ? selected : candidates.slice(0, RERANKED_MEMORY_LIMIT);
  } catch {
    return candidates.slice(0, RERANKED_MEMORY_LIMIT);
  }
};

export const recallChatMemories = async ({
  chatId,
  query,
  recentMessages,
  settings
}: {
  chatId: string;
  query: string;
  recentMessages: Message[];
  settings: UserSettings;
}): Promise<MatchedMemoryEntry[]> => {
  const queryText = [
    query,
    ...recentMessages.map((message) => `${message.role}: ${message.content}`)
  ]
    .join("\n")
    .trim();

  if (!queryText) {
    return [];
  }

  const memories = await prisma.chatMemory.findMany({
    where: { chatId, enabled: true, deletedAt: null },
    orderBy: [{ importance: "desc" }, { updatedAt: "desc" }]
  });
  const queryTokens = new Set(tokenize(queryText));
  let embeddingIndex: EmbeddingIndex | null = null;
  try {
    const embeddingSettings = resolveModuleSettings(settings, "memory_embedding");
    const source = getMemoryEmbeddingSource(embeddingSettings);
    const readyVectors = memories
      .map((memory) => ({ memory, vector: toNumberArray(memory.embedding) }))
      .filter(({ memory, vector }) =>
        memory.embeddingStatus === "ready" &&
        memory.embeddingSource === source &&
        memory.embeddingDimensions === vector?.length &&
        Boolean(vector)
      );
    const dimensions = readyVectors[0]?.vector?.length;
    if (dimensions && readyVectors.every(({ vector }) => vector?.length === dimensions)) {
      embeddingIndex = {
        settings: embeddingSettings,
        source,
        dimensions,
        vectors: new Map(readyVectors.map(({ memory, vector }) => [memory.id, vector!]))
      };
    }
  } catch {
    embeddingIndex = null;
  }
  let queryVector: number[] | null = null;
  if (embeddingIndex) {
    try {
      const result = await generateEmbeddings({
        settings: embeddingIndex.settings,
        inputs: [queryText.slice(0, 6000)],
        task: "query"
      });
      queryVector = result.vectors[0]?.length === embeddingIndex.dimensions ? result.vectors[0] : null;
    } catch {
      queryVector = null;
    }
  }

  const candidates = memories
    .map((memory) => {
      const keywordScore = scoreMemory(memory, queryText, queryTokens);
      if (!queryVector || !embeddingIndex) {
        return toMatchedMemoryEntry(memory, keywordScore);
      }

      const memoryVector = embeddingIndex.vectors.get(memory.id);
      const semanticScore = memoryVector
        ? Math.max(0, cosineSimilarity(queryVector, memoryVector))
        : 0;
      if (keywordScore <= 0 && semanticScore < SEMANTIC_SIMILARITY_THRESHOLD) {
        return toMatchedMemoryEntry(memory, 0);
      }

      const normalizedKeywordScore = Math.min(1, keywordScore / 25);
      const importanceScore = Math.min(1, Math.max(0, memory.importance / 5));
      const hybridScore =
        semanticScore * 0.72 + normalizedKeywordScore * 0.23 + importanceScore * 0.05;
      return toMatchedMemoryEntry(memory, Number((hybridScore * 100).toFixed(2)));
    })
    .filter((memory) => memory.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, KEYWORD_CANDIDATE_LIMIT);
  const selected = await rerankMemories(queryText, candidates, settings);

  if (selected.length) {
    const now = new Date();
    await prisma.chatMemory.updateMany({
      where: { id: { in: selected.map((memory) => memory.id) } },
      data: { lastMatchedAt: now }
    });
    return selected.map((memory) => ({ ...memory, lastMatchedAt: now.toISOString() }));
  }

  return selected;
};

export const formatMemorySystemPrompt = (memories: MatchedMemoryEntry[]) => {
  if (memories.length === 0) {
    return "";
  }

  return [
    "Relevant long-term chat memories:",
    ...memories.map((memory, index) => {
      const keywords = memory.keywords.length ? ` [${memory.keywords.join(", ")}]` : "";
      return `${index + 1}. ${memory.title}${keywords}\n${memory.content}`;
    })
  ].join("\n\n");
};

export const buildChatMemoryMaintenanceMessages = (
  existingMemories: ChatMemory[],
  recentMessages: Message[]
): ChatCompletionMessage[] => [
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
                `${index + 1}. id=${memory.id}\ntitle=${memory.title}\nenabled=${memory.enabled}\nimportance=${memory.importance}\nkeywords=${toStringArray(memory.keywords).join(", ")}\ncontent=${memory.content}`
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

type MemoryAction =
  | {
      type: "create";
      title: string;
      content: string;
      keywords?: string[];
      importance?: number;
    }
  | {
      type: "update";
      id: string;
      title?: string;
      content?: string;
      keywords?: string[];
      importance?: number;
      enabled?: boolean;
    };

export type MemoryMaintenanceSummary = {
  chatId: string;
  operationId: string | null;
  created: number;
  updated: number;
  disabled: number;
  memoryUpdatedAt: string | null;
};

const clampImportance = (value: unknown) =>
  Math.min(5, Math.max(1, typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 3));

const normalizeGeneratedAction = (value: unknown): MemoryAction | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const action = value as Record<string, unknown>;
  if (action.type === "create") {
    const title = typeof action.title === "string" ? action.title.trim().slice(0, 80) : "";
    const content = typeof action.content === "string" ? action.content.trim().slice(0, 1200) : "";
    if (!title || !content) {
      return null;
    }
    return {
      type: "create",
      title,
      content,
      keywords: uniqueStrings(
        Array.isArray(action.keywords)
          ? action.keywords.filter((keyword): keyword is string => typeof keyword === "string")
          : [],
        12
      ),
      importance: clampImportance(action.importance)
    };
  }

  if (action.type === "update") {
    const id = typeof action.id === "string" ? action.id : "";
    if (!id) {
      return null;
    }
    return {
      type: "update",
      id,
      title: typeof action.title === "string" ? action.title.trim().slice(0, 80) : undefined,
      content: typeof action.content === "string" ? action.content.trim().slice(0, 1200) : undefined,
      keywords: Array.isArray(action.keywords)
        ? uniqueStrings(
            action.keywords.filter((keyword): keyword is string => typeof keyword === "string"),
            12
          )
        : undefined,
      importance: action.importance === undefined ? undefined : clampImportance(action.importance),
      enabled: typeof action.enabled === "boolean" ? action.enabled : undefined
    };
  }

  return null;
};

const parseMemoryActions = (raw: string) => {
  const parsed = parseJsonObject(raw);
  if (!parsed) {
    return null;
  }

  const actions = (parsed as { actions?: unknown }).actions;
  if (!Array.isArray(actions)) {
    return null;
  }

  return actions.map(normalizeGeneratedAction).filter((item): item is MemoryAction => Boolean(item));
};

export const updateChatMemoriesFromTurn = async ({
  chatId,
  settings
}: {
  chatId: string;
  settings: UserSettings;
}) => {
  const chat = await prisma.chat.findFirst({ where: { id: chatId, deletedAt: null } });
  if (!chat?.autoMemoryEnabled) {
    return null;
  }

  if (chat.memoryUpdatedAt && Date.now() - chat.memoryUpdatedAt.getTime() < AUTO_MEMORY_THROTTLE_MS) {
    return null;
  }

  const [recentMessagesDesc, existingMemories] = await Promise.all([
    prisma.message.findMany({
      where: { chatId },
      orderBy: { createdAt: "desc" },
      take: RECENT_MESSAGE_LIMIT
    }),
    prisma.chatMemory.findMany({
      where: { chatId, deletedAt: null },
      orderBy: { updatedAt: "desc" },
      take: EXISTING_MEMORY_LIMIT
    })
  ]);
  const recentMessages = recentMessagesDesc.reverse();
  if (recentMessages.length === 0) {
    return null;
  }

  const sourceMessageIds = recentMessages.map((message) => message.id);
  const operation = await prisma.memoryOperation.create({ data: { chatId, type: "automatic_maintenance", actor: "automatic_memory", status: "running", sourceMessageIds } });
  let actions: MemoryAction[];
  try {
    const raw = (await executeReliableTextCompletion({
      settings: resolveModuleSettings(settings, "memory"),
      messages: buildChatMemoryMaintenanceMessages(existingMemories, recentMessages),
      maxTokens: 1600,
      temperature: 0.2,
      context: { requestId: `memory_${randomUUID()}`, module: "memory", operation: "maintenance", chatId }
    })).content;
    const parsed = parseMemoryActions(raw.trim());
    if (!parsed) {
      await prisma.memoryOperation.update({ where: { id: operation.id }, data: { status: "failed", completedAt: new Date(), errorCode: "invalid_model_output" } });
      return null;
    }
    actions = parsed;
  } catch (error) {
    await prisma.memoryOperation.update({ where: { id: operation.id }, data: { status: "failed", completedAt: new Date(), errorCode: "maintenance_failed" } });
    throw error;
  }

  const existingIds = new Set(existingMemories.map((memory) => memory.id));
  const deduped = actions.slice(0, 8).filter((action, index, list) => action.type === "create" || list.findIndex((candidate) => candidate.type === "update" && candidate.id === action.id) === index);
  let counts: { created: number; updated: number; disabled: number; unchanged: number; completedAt: Date };
  try {
    counts = await prisma.$transaction(async (tx) => {
      let created = 0;
      let updated = 0;
      let disabled = 0;
      let unchanged = 0;
      for (const action of deduped) {
        if (action.type === "create") {
          await createMemoryInTransaction(tx, { chatId, title: action.title, content: action.content, keywords: action.keywords ?? [], importance: action.importance ?? 3, enabled: true, sourceMessageIds }, { actor: "automatic_memory", action: "automatic_create", operationId: operation.id, reasonCode: "automatic_maintenance" });
          created += 1;
          continue;
        }
        if (!existingIds.has(action.id)) {
          unchanged += 1;
          continue;
        }
        const current = await tx.chatMemory.findUniqueOrThrow({ where: { id: action.id } });
        const isDisable = action.enabled === false && current.enabled;
        const result = await updateMemoryInTransaction(tx, current, {
          ...(action.title ? { title: action.title } : {}),
          ...(action.content ? { content: action.content } : {}),
          ...(action.keywords ? { keywords: action.keywords } : {}),
          ...(action.importance ? { importance: action.importance } : {}),
          ...(typeof action.enabled === "boolean" ? { enabled: action.enabled } : {}),
          sourceMessageIds
        }, { actor: "automatic_memory", action: isDisable ? "automatic_disable" : "automatic_update", operationId: operation.id, reasonCode: "automatic_maintenance" });
        if (result.changed) {
          updated += 1;
          if (isDisable) disabled += 1;
        } else unchanged += 1;
      }
      const completedAt = new Date();
      await tx.chat.update({ where: { id: chatId }, data: { memoryUpdatedAt: completedAt } });
      await tx.memoryOperation.update({ where: { id: operation.id }, data: { status: unchanged && created + updated ? "partial" : "succeeded", completedAt, createdCount: created, updatedCount: updated, disabledCount: disabled, unchangedCount: unchanged } });
      await pruneMemoryOperations(tx, chatId);
      return { created, updated, disabled, unchanged, completedAt };
    });
  } catch (error) {
    await prisma.memoryOperation.update({ where: { id: operation.id }, data: { status: "failed", completedAt: new Date(), errorCode: "transaction_failed" } });
    throw error;
  }

  if (counts.created + counts.updated > 0) {
    await refreshChatMemoryEmbeddings({ chatId, settings });
  }

  return {
    chatId,
    operationId: operation.id,
    created: counts.created,
    updated: counts.updated,
    disabled: counts.disabled,
    memoryUpdatedAt: counts.completedAt.toISOString()
  } satisfies MemoryMaintenanceSummary;
};
