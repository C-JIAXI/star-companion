import { Prisma, type ChatMemory, type Message, type UserSettings } from "@prisma/client";
import { prisma } from "../db.js";
import { completeChatCompletion, type ChatCompletionMessage } from "./completions.js";
import { generateEmbeddings } from "./embeddings.js";
import { resolveModuleSettings } from "./moduleModels.js";

const KEYWORD_CANDIDATE_LIMIT = 12;
const RERANKED_MEMORY_LIMIT = 5;
const AUTO_MEMORY_THROTTLE_MS = 30_000;
const RECENT_MESSAGE_LIMIT = 6;
const EXISTING_MEMORY_LIMIT = 30;
const EMBEDDING_BATCH_SIZE = 64;
const SEMANTIC_SIMILARITY_THRESHOLD = 0.25;

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

const toEmbeddingIdentity = (settings: UserSettings) =>
  `${settings.activeProvider.trim().toLowerCase()}:${settings.model.trim()}`;

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

  const embeddingModel = toEmbeddingIdentity(embeddingSettings);
  const vectors = new Map<string, number[]>();
  const stale = memories.filter((memory) => {
    const vector = toNumberArray(memory.embedding);
    if (!force && memory.embeddingModel === embeddingModel && vector) {
      vectors.set(memory.id, vector);
      return false;
    }
    return true;
  });

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
            embeddingUpdatedAt: updatedAt
          }
        });
      }
    }

    return { settings: embeddingSettings, model: embeddingModel, vectors };
  } catch {
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
  const memories = await prisma.chatMemory.findMany({
    where: { chatId, enabled: true },
    orderBy: { updatedAt: "desc" }
  });
  return ensureMemoryEmbeddings(memories, settings, force);
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
    const raw = await completeChatCompletion({
      settings: moduleSettings,
      messages: buildMemoryRerankMessages(queryText, candidates),
      maxTokens: 180,
      temperature: 0
    });
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
    where: { chatId, enabled: true },
    orderBy: [{ importance: "desc" }, { updatedAt: "desc" }]
  });
  const queryTokens = new Set(tokenize(queryText));
  const embeddingIndex = await ensureMemoryEmbeddings(memories, settings);
  let queryVector: number[] | null = null;
  if (embeddingIndex) {
    try {
      const result = await generateEmbeddings({
        settings: embeddingIndex.settings,
        inputs: [(query.trim() || queryText).slice(0, 6000)],
        task: "query"
      });
      queryVector = result.vectors[0] ?? null;
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
      where: { chatId },
      orderBy: { updatedAt: "desc" },
      take: EXISTING_MEMORY_LIMIT
    })
  ]);
  const recentMessages = recentMessagesDesc.reverse();
  if (recentMessages.length === 0) {
    return null;
  }

  const raw = await completeChatCompletion({
    settings: resolveModuleSettings(settings, "memory"),
    messages: buildChatMemoryMaintenanceMessages(existingMemories, recentMessages),
    maxTokens: 1600,
    temperature: 0.2
  });
  const actions = parseMemoryActions(raw.trim());
  if (!actions) {
    return null;
  }
  const existingIds = new Set(existingMemories.map((memory) => memory.id));
  const sourceMessageIds = recentMessages.map((message) => message.id);
  let created = 0;
  let updated = 0;
  let disabled = 0;
  const changedMemoryIds: string[] = [];

  for (const action of actions.slice(0, 8)) {
    if (action.type === "create") {
      const memory = await prisma.chatMemory.create({
        data: {
          chatId,
          title: action.title,
          content: action.content,
          keywords: action.keywords ?? [],
          importance: action.importance ?? 3,
          enabled: true,
          sourceMessageIds
        }
      });
      changedMemoryIds.push(memory.id);
      created += 1;
      continue;
    }

    if (!existingIds.has(action.id)) {
      continue;
    }

    await prisma.chatMemory.update({
      where: { id: action.id },
      data: {
        ...(action.title ? { title: action.title } : {}),
        ...(action.content ? { content: action.content } : {}),
        ...(action.keywords ? { keywords: action.keywords } : {}),
        ...(action.importance ? { importance: action.importance } : {}),
        ...(typeof action.enabled === "boolean" ? { enabled: action.enabled } : {}),
        sourceMessageIds,
        ...(action.title || action.content || action.keywords
          ? {
              embedding: Prisma.JsonNull,
              embeddingModel: null,
              embeddingUpdatedAt: null
            }
          : {})
      }
    });
    changedMemoryIds.push(action.id);
    updated += 1;
    if (action.enabled === false) {
      disabled += 1;
    }
  }

  const updatedChat = await prisma.chat.update({
    where: { id: chatId },
    data: { memoryUpdatedAt: new Date() }
  });

  if (changedMemoryIds.length > 0) {
    const changedMemories = await prisma.chatMemory.findMany({
      where: { id: { in: changedMemoryIds }, enabled: true }
    });
    await ensureMemoryEmbeddings(changedMemories, settings);
  }

  return {
    chatId,
    created,
    updated,
    disabled,
    memoryUpdatedAt: updatedChat.memoryUpdatedAt?.toISOString() ?? null
  } satisfies MemoryMaintenanceSummary;
};
