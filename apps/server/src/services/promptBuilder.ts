import type { Character, Message, Prisma, UserSettings } from "@prisma/client";
import { prisma } from "../db.js";
import type { ChatCompletionMessage } from "./completions.js";
import { resolveCharacterPromptFields } from "./characterCards.js";
import {
  formatMemorySystemPrompt,
  recallChatMemories,
  type MatchedMemoryEntry
} from "./chatMemories.js";
import { getUserCustomConfigSegments } from "./userCustomConfig.js";

type PromptInput = {
  chatId: string;
  characterId?: string | null;
  before?: Date;
  excludeMessageIds?: string[];
  settings?: UserSettings;
};

type LoreTriggerMode = "user" | "assistant" | "both";
type LoreEntryScope = "prefix" | "prompt" | "suffix";

export type MatchedLoreEntry = {
  id: string;
  characterId: string;
  characterName: string;
  keys: string[];
  content: string;
  priority: number;
  scope: LoreEntryScope;
  triggerMode: LoreTriggerMode;
  alwaysActive: boolean;
  enabled: boolean;
};

export type PromptBreakdownSectionId =
  | "character"
  | "user_persona"
  | "user_profile"
  | "lore"
  | "memory"
  | "history"
  | "generation_instruction"
  | "formatting";

export type PromptBreakdown = {
  promptTokens: number;
  promptTokensEstimated: boolean;
  includedMessageCount: number;
  sections: Array<{
    id: PromptBreakdownSectionId;
    tokenEstimate: number;
    characterCount: number;
    itemCount: number;
  }>;
};

const toStringArray = (value: Prisma.JsonValue): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
};

const toContextMessageLimit = (memoryTurns: number) =>
  Math.max(1, Math.min(memoryTurns, 50)) * 2 + 1;

const estimatePromptTokens = (content: string) => {
  const compact = content.trim();
  return compact ? Math.max(1, Math.ceil(compact.length / 2)) : 0;
};

const createPromptBreakdownSection = (
  id: PromptBreakdownSectionId,
  contents: string[],
  itemCount = contents.filter((content) => content.trim()).length
) => {
  const nonEmptyContents = contents.filter((content) => content.trim());
  return {
    id,
    tokenEstimate: nonEmptyContents.reduce(
      (total, content) => total + estimatePromptTokens(content),
      0
    ),
    characterCount: nonEmptyContents.reduce((total, content) => total + content.trim().length, 0),
    itemCount
  };
};

const normalizeLoreTriggerMode = (value: string | null | undefined): LoreTriggerMode => {
  if (value === "user" || value === "assistant") {
    return value;
  }

  return "both";
};

const normalizeLoreScope = (value: string | null | undefined): LoreEntryScope => {
  if (value === "prefix" || value === "suffix") {
    return value;
  }
  return "prompt";
};

const resolvePromptCharacterId = (chat: { characterId: string | null } | null, requestedCharacterId?: string | null) => {
  if (!chat) {
    return requestedCharacterId ?? null;
  }

  if (requestedCharacterId && requestedCharacterId === chat.characterId) {
    return requestedCharacterId;
  }

  return chat.characterId;
};

const buildCharacterSystemPrompt = (
  character: Character | null,
  loreEntries: MatchedLoreEntry[] = []
): string => {
  if (!character) {
    return "";
  }

  const promptFields = resolveCharacterPromptFields(character);
  const prefixLore = loreEntries.filter((e) => e.scope === "prefix");
  const promptLore = loreEntries.filter((e) => e.scope === "prompt");
  const suffixLore = loreEntries.filter((e) => e.scope === "suffix");
  const loreContents = (entries: MatchedLoreEntry[]) =>
    entries.map((e) => e.content.trim()).filter(Boolean).join("\n\n");

  return [
    [promptFields.prefix.trim(), loreContents(prefixLore)].filter(Boolean).join("\n\n"),
    [promptFields.prompt.trim(), loreContents(promptLore)].filter(Boolean).join("\n\n"),
    [promptFields.suffix.trim(), loreContents(suffixLore)].filter(Boolean).join("\n\n")
  ]
    .filter(Boolean)
    .join("\n\n");
};

const formatMessageContent = (message: Message, characterNames: Map<string, string>) => {
  if (message.role !== "assistant" || !message.characterId) {
    return message.content;
  }

  const name = characterNames.get(message.characterId);
  return name ? `${name}: ${message.content}` : message.content;
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const isBoundaryKeyword = (value: string) => /^[a-z0-9][a-z0-9_-]*$/i.test(value);

const matchesKeyword = (key: string, contextText: string) => {
  const normalizedKey = key.trim().toLowerCase();
  if (!normalizedKey) {
    return false;
  }

  if (!isBoundaryKeyword(normalizedKey)) {
    return contextText.includes(normalizedKey);
  }

  return new RegExp(`(^|[^a-z0-9_])${escapeRegExp(normalizedKey)}(?=$|[^a-z0-9_])`, "i").test(
    contextText
  );
};

const matchesContext = (keys: string[], contextText: string) =>
  keys.some((key) => matchesKeyword(key, contextText));

const buildLoreContexts = (recentMessages: Message[]) => {
  const messageText = (roles: Array<Message["role"]>) =>
    recentMessages
      .filter((message) => roles.includes(message.role))
      .map((message) => message.content)
      .join("\n")
      .toLowerCase();

  return {
    user: messageText(["user"]),
    assistant: messageText(["assistant"]),
    both: messageText(["user", "assistant"])
  } satisfies Record<LoreTriggerMode, string>;
};

const findMatchedLoreEntries = (
  characterLoreEntries: Array<{
    id: string;
    keys: string[];
    content: string;
    priority: number;
    scope?: string;
    triggerMode: string;
    alwaysActive: boolean;
    enabled: boolean;
  }>,
  recentMessages: Message[],
  characterId: string,
  characterName: string
): MatchedLoreEntry[] => {
  if (characterLoreEntries.length === 0) {
    return [];
  }

  const contexts = buildLoreContexts(recentMessages);

  const entries = characterLoreEntries.filter((entry) => entry.enabled);

  return entries
    .filter((entry) => {
      if (entry.alwaysActive) {
        return true;
      }

      const triggerMode = normalizeLoreTriggerMode(entry.triggerMode);
      return matchesContext(entry.keys, contexts[triggerMode]);
    })
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 8)
    .map((entry) => ({
      id: entry.id,
      characterId,
      characterName,
      keys: entry.keys,
      content: entry.content,
      priority: entry.priority,
      scope: normalizeLoreScope(entry.scope),
      triggerMode: normalizeLoreTriggerMode(entry.triggerMode),
      alwaysActive: entry.alwaysActive,
      enabled: entry.enabled
    }));
};

const buildPromptBreakdown = ({
  messages,
  characterPrompt,
  userConfigSegments,
  userProfileSummary,
  matchedLoreEntries,
  memoryPrompt,
  memoryEntryCount,
  historyMessages
}: {
  messages: ChatCompletionMessage[];
  characterPrompt: string;
  userConfigSegments: string[];
  userProfileSummary: string;
  matchedLoreEntries: MatchedLoreEntry[];
  memoryPrompt: string;
  memoryEntryCount: number;
  historyMessages: ChatCompletionMessage[];
}): PromptBreakdown => {
  const sections = [
    createPromptBreakdownSection("character", [characterPrompt]),
    createPromptBreakdownSection(
      "lore",
      matchedLoreEntries.map((entry) => entry.content),
      matchedLoreEntries.length
    ),
    createPromptBreakdownSection("user_persona", userConfigSegments),
    createPromptBreakdownSection("user_profile", [userProfileSummary]),
    createPromptBreakdownSection("memory", [memoryPrompt], memoryEntryCount),
    createPromptBreakdownSection(
      "history",
      historyMessages.map((message) => message.content),
      historyMessages.length
    )
  ].filter((section) => section.tokenEstimate > 0 || section.itemCount > 0);
  const promptTokens = messages.reduce(
    (total, message) => total + estimatePromptTokens(message.content),
    0
  );
  const allocatedTokens = sections.reduce((total, section) => total + section.tokenEstimate, 0);
  if (promptTokens > allocatedTokens) {
    sections.push({
      id: "formatting",
      tokenEstimate: promptTokens - allocatedTokens,
      characterCount: 0,
      itemCount: 0
    });
  }

  return {
    promptTokens,
    promptTokensEstimated: true,
    includedMessageCount: historyMessages.length,
    sections
  };
};

export const appendPromptBreakdownInstruction = (
  breakdown: PromptBreakdown,
  content: string
): PromptBreakdown => {
  const section = createPromptBreakdownSection("generation_instruction", [content]);
  if (!section.tokenEstimate) return breakdown;
  return {
    ...breakdown,
    promptTokens: breakdown.promptTokens + section.tokenEstimate,
    sections: [...breakdown.sections, section]
  };
};

export const finalizePromptBreakdown = (
  breakdown: PromptBreakdown,
  promptTokens: number,
  promptTokensEstimated: boolean
): PromptBreakdown => {
  const normalizedTotal = Math.max(0, Math.round(promptTokens));
  const weightTotal = breakdown.sections.reduce(
    (total, section) => total + section.tokenEstimate,
    0
  );
  if (!breakdown.sections.length || weightTotal <= 0) {
    return { ...breakdown, promptTokens: normalizedTotal, promptTokensEstimated };
  }

  const allocations = breakdown.sections.map((section, index) => {
    const exact = (section.tokenEstimate / weightTotal) * normalizedTotal;
    return { index, floor: Math.floor(exact), fraction: exact - Math.floor(exact) };
  });
  let remaining = normalizedTotal - allocations.reduce((total, item) => total + item.floor, 0);
  const byFraction = [...allocations].sort((left, right) => right.fraction - left.fraction);
  for (let index = 0; remaining > 0; index += 1, remaining -= 1) {
    byFraction[index % byFraction.length].floor += 1;
  }
  const allocatedByIndex = new Map(allocations.map((item) => [item.index, item.floor]));

  return {
    ...breakdown,
    promptTokens: normalizedTotal,
    promptTokensEstimated,
    sections: breakdown.sections.map((section, index) => ({
      ...section,
      tokenEstimate: allocatedByIndex.get(index) ?? 0
    }))
  };
};

export const resolveChatCharacterId = async (
  chatId: string,
  requestedCharacterId?: string | null
) => {
  const chat = await prisma.chat.findFirst({ where: { id: chatId, deletedAt: null } });
  return resolvePromptCharacterId(chat, requestedCharacterId);
};

export const buildPromptMessages = async ({
  chatId,
  characterId,
  before,
  excludeMessageIds
}: PromptInput): Promise<ChatCompletionMessage[]> => {
  const context = await buildPromptContext({ chatId, characterId, before, excludeMessageIds });
  return context.messages;
};

export const buildPromptContext = async ({
  chatId,
  characterId,
  before,
  excludeMessageIds,
  settings
}: PromptInput): Promise<{
  messages: ChatCompletionMessage[];
  matchedLoreEntries: MatchedLoreEntry[];
  matchedMemoryEntries: MatchedMemoryEntry[];
  promptBreakdown: PromptBreakdown;
}> => {
  const chat = await prisma.chat.findFirst({ where: { id: chatId, deletedAt: null } });
  const resolvedCharacterId = resolvePromptCharacterId(chat, characterId);
  const character = resolvedCharacterId
    ? await prisma.character.findUnique({ where: { id: resolvedCharacterId } })
    : null;
  const contextMessageLimit = toContextMessageLimit(chat?.memoryTurns ?? 12);

  const recentMessagesDesc = await prisma.message.findMany({
    where: {
      chatId,
      contextIncluded: true,
      ...(before ? { createdAt: { lt: before } } : {})
    },
    orderBy: { createdAt: "desc" },
    take: contextMessageLimit
  });
  let recentMessages = recentMessagesDesc.reverse();
  if (excludeMessageIds?.length) {
    recentMessages = recentMessages.filter((m) => !excludeMessageIds.includes(m.id));
  }

  const speakerCharacterIds = [
    ...new Set(
      recentMessages.map((message) => message.characterId).filter((id): id is string => Boolean(id))
    )
  ];
  const characters = speakerCharacterIds.length
    ? await prisma.character.findMany({ where: { id: { in: speakerCharacterIds } } })
    : [];
  const characterNames = new Map(characters.map((item) => [item.id, item.name]));
  const promptFields = character ? resolveCharacterPromptFields(character) : null;

  const matchedLoreEntries = findMatchedLoreEntries(
    promptFields?.loreEntries ?? [],
    recentMessages,
    character?.id ?? "",
    character?.name ?? ""
  );
  const resolvedSettings =
    settings ??
    (await prisma.userSettings.findFirst({ orderBy: { createdAt: "asc" } })) ??
    (await prisma.userSettings.create({ data: {} }));
  const matchedMemoryEntries = await recallChatMemories({
    chatId,
    query: recentMessages.at(-1)?.content ?? "",
    recentMessages,
    settings: resolvedSettings
  });
  const userCustomConfigSegments = getUserCustomConfigSegments(chat?.userPersona);
  const characterPrompt = buildCharacterSystemPrompt(character, []);
  const characterPromptWithLore = buildCharacterSystemPrompt(character, matchedLoreEntries);
  const userProfileSummary = chat?.userProfileSummary.trim() ?? "";
  const memoryPrompt = formatMemorySystemPrompt(matchedMemoryEntries);

  const systemMessages: ChatCompletionMessage[] = [
    characterPromptWithLore,
    ...userCustomConfigSegments,
    userProfileSummary,
    memoryPrompt
  ]
    .filter(Boolean)
    .map((content) => ({
      role: "system" as const,
      content
    }));

  const historyMessages: ChatCompletionMessage[] = recentMessages.map((message) => ({
    role: message.role === "assistant" || message.role === "system" ? message.role : "user",
    content: formatMessageContent(message, characterNames)
  }));
  const messages = [...systemMessages, ...historyMessages];

  return {
    messages,
    matchedLoreEntries,
    matchedMemoryEntries,
    promptBreakdown: buildPromptBreakdown({
      messages,
      characterPrompt,
      userConfigSegments: userCustomConfigSegments,
      userProfileSummary,
      matchedLoreEntries,
      memoryPrompt,
      memoryEntryCount: matchedMemoryEntries.length,
      historyMessages
    })
  };
};

export const appendVariant = (value: Prisma.JsonValue, content: string) => {
  const variants = toStringArray(value);
  return [...variants, content];
};
