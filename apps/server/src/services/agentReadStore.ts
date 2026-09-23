import { prisma } from "../db.js";
import { searchMessagesPage } from "./messageSearch.js";
import type { AgentReadStore } from "./agentReadTools.js";
import { recallChatMemories } from "./chatMemories.js";
import { getOrCreateSettings } from "../routes/settings.js";
import { resolveCharacterRecord } from "./characterCards.js";
import { loadEnabledAgentSkill } from "./skillRegistry.js";

export const desktopAgentReadStore: AgentReadStore = {
  async searchHistory({ chatId, query, limit, cursor }) {
    const page = await searchMessagesPage({ chatId, query, limit, cursor, contextOnly: true });
    return {
      messages: page.results.map((result) => ({
        id: result.message.id, role: result.message.role,
        content: result.snippet, createdAt: result.message.createdAt
      })),
      nextCursor: page.nextCursor
    };
  },
  async readMessages({ chatId, ids }) {
    const rows = await prisma.message.findMany({
      where: { chatId, id: { in: ids }, contextIncluded: true, chat: { deletedAt: null } },
      select: { id: true, role: true, content: true, createdAt: true }
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids.flatMap((id) => {
      const row = byId.get(id);
      return row ? [{ id: row.id, role: row.role, content: row.content, createdAt: row.createdAt.toISOString() }] : [];
    });
  },
  async searchMemories({ chatId, query, limit }) {
    const chat = await prisma.chat.findFirst({ where: { id: chatId, deletedAt: null }, select: { id: true } });
    if (!chat) return [];
    const recalled = await recallChatMemories({ chatId, query, recentMessages: [], settings: await getOrCreateSettings() });
    const rows = await prisma.chatMemory.findMany({ where: { chatId, id: { in: recalled.map((memory) => memory.id) }, enabled: true, deletedAt: null }, select: { id: true, currentRevision: true } });
    const revisions = new Map(rows.map((memory) => [memory.id, memory.currentRevision]));
    return recalled.filter((memory) => memory.enabled).slice(0, limit).map((memory) => ({
      id: memory.id, title: memory.title, content: memory.content, keywords: memory.keywords,
      importance: memory.importance, embeddingStatus: memory.embeddingStatus, currentRevision: revisions.get(memory.id)
    }));
  },
  async readCharacter({ chatId }) {
    const chat = await prisma.chat.findFirst({
      where: { id: chatId, deletedAt: null }, include: { character: true }
    });
    if (!chat?.character) return null;
    const resolved = resolveCharacterRecord(chat.character);
    return {
      name: resolved.name, description: resolved.description, visibility: resolved.visibility,
      locked: !resolved.canViewPrompt, prefix: resolved.prefix, prompt: resolved.prompt, suffix: resolved.suffix,
      loreEntries: resolved.loreEntries.filter((entry) => entry.enabled).map((entry) => ({
        id: entry.id, keys: entry.keys, content: entry.content,
        priority: entry.priority, alwaysActive: entry.alwaysActive
      }))
    };
  },
  async loadSkill({ name, path }) { return loadEnabledAgentSkill(name, path); }
};
