import type { ChatMemory, Message, UserSettings } from "@prisma/client";
import { prisma } from "../db.js";
import { completeChatCompletion, type ChatCompletionMessage } from "./completions.js";

const KEYWORD_CANDIDATE_LIMIT = 12;
const RERANKED_MEMORY_LIMIT = 5;
const AUTO_MEMORY_THROTTLE_MS = 30_000;
const RECENT_MESSAGE_LIMIT = 6;
const EXISTING_MEMORY_LIMIT = 30;

export type MatchedMemoryEntry = {
  id: string;
  chatId: string;
  title: string;
  content: string;
  keywords: string[];
  importance: number;
  enabled: boolean;
  score: number;
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

const tokenize = (value: string) =>
  uniqueStrings(value.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [], 80)
    .filter((token) => token.length > 1);

const toMatchedMemoryEntry = (memory: ChatMemory, score: number): MatchedMemoryEntry => ({
  id: memory.id,
  chatId: memory.chatId,
  title: memory.title,
  content: memory.content,
  keywords: toStringArray(memory.keywords),
  importance: memory.importance,
  enabled: memory.enabled,
  score,
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
      "Select long-term chat memories that are useful for answering the next roleplay message.",
      "Only choose from the provided candidate IDs.",
      `Return JSON only: {"ids":["memory-id"]}.`,
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
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
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

  if (!settings.apiKey) {
    return candidates.slice(0, RERANKED_MEMORY_LIMIT);
  }

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
  const candidates = memories
    .map((memory) => toMatchedMemoryEntry(memory, scoreMemory(memory, queryText, queryTokens)))
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
      "You maintain long-term memories for one local-first single-character roleplay chat.",
      "Extract durable plot facts, relationship changes, stable preferences, boundaries, plans, and recurring interaction patterns.",
      "Do not store API keys, credentials, secrets, exact private addresses, unsupported guesses, or one-off transient requests.",
      "Prefer updating existing memories over creating duplicates.",
      "Do not delete. You may disable a memory only when the conversation clearly makes it obsolete or false.",
      "Return JSON only with this shape:",
      '{"actions":[{"type":"create","title":"...","content":"...","keywords":["..."],"importance":3},{"type":"update","id":"...","title":"...","content":"...","keywords":["..."],"importance":3,"enabled":true}]}'
    ].join("\n")
  },
  {
    role: "user",
    content: [
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
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [];
  }

  const actions = (parsed as { actions?: unknown }).actions;
  if (!Array.isArray(actions)) {
    return [];
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
  const chat = await prisma.chat.findUnique({ where: { id: chatId } });
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
    settings,
    messages: buildChatMemoryMaintenanceMessages(existingMemories, recentMessages),
    maxTokens: 700,
    temperature: 0.2
  });
  const actions = parseMemoryActions(raw.trim());
  const existingIds = new Set(existingMemories.map((memory) => memory.id));
  const sourceMessageIds = recentMessages.map((message) => message.id);

  for (const action of actions.slice(0, 8)) {
    if (action.type === "create") {
      await prisma.chatMemory.create({
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
        sourceMessageIds
      }
    });
  }

  return prisma.chat.update({
    where: { id: chatId },
    data: { memoryUpdatedAt: new Date() }
  });
};
