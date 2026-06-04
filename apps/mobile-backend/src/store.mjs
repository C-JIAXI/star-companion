import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import initSqlJs from "sql.js";

const now = () => new Date().toISOString();
const clone = (value) => JSON.parse(JSON.stringify(value));

const defaultSettings = () => {
  const timestamp = now();
  return {
    id: "settings",
    activeProvider: "openai-compatible",
    apiBaseUrl: "https://api.openai.com/v1",
    apiKey: null,
    model: "gpt-4o-mini",
    temperature: 0.8,
    maxTokens: 800,
    topP: 1,
    language: "zh-CN",
    models: [],
    providers: [],
    activeProviderId: "",
    activeModelId: "",
    userProfileSummary: "",
    autoSummarizeUser: true,
    showMessageAvatars: true,
    userProfileUpdatedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
};

const compareDesc = (field) => (a, b) => String(b[field]).localeCompare(String(a[field]));
const compareAsc = (field) => (a, b) => String(a[field]).localeCompare(String(b[field]));

const toInteger = (value) => (value === undefined || value === null ? null : Number(value));

export class MobileStore {
  constructor(filePath) {
    this.filePath = filePath.replace(/\.json$/i, ".sqlite");
    this.SQL = null;
    this.db = null;
    this.writeQueue = Promise.resolve();
  }

  async load() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    this.SQL = await initSqlJs();

    try {
      const bytes = await readFile(this.filePath);
      this.db = new this.SQL.Database(bytes);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      this.db = new this.SQL.Database();
    }

    this.migrate();

    if (!this.readRecord("settings", "settings")) {
      await this.writeRecord("settings", defaultSettings());
      await this.persist();
    }
  }

  migrate() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS records (
        type TEXT NOT NULL,
        id TEXT NOT NULL,
        data TEXT NOT NULL,
        cardId TEXT,
        chatId TEXT,
        characterId TEXT,
        role TEXT,
        enabled INTEGER,
        importance INTEGER,
        createdAt TEXT,
        updatedAt TEXT,
        PRIMARY KEY (type, id)
      )
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_records_type_updated ON records(type, updatedAt)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_records_type_created ON records(type, createdAt)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_records_type_card ON records(type, cardId)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_records_type_chat ON records(type, chatId)");
  }

  async persist() {
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, Buffer.from(this.db.export()));
    });
    await this.writeQueue;
  }

  select(sql, params = []) {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject());
      }
      return rows;
    } finally {
      stmt.free();
    }
  }

  readRecord(type, id) {
    const row = this.select("SELECT data FROM records WHERE type = ? AND id = ?", [type, id])[0];
    return row ? JSON.parse(String(row.data)) : null;
  }

  readRecords(type, whereSql = "", params = [], orderSql = "") {
    const rows = this.select(
      `SELECT data FROM records WHERE type = ? ${whereSql} ${orderSql}`,
      [type, ...params]
    );
    return rows.map((row) => JSON.parse(String(row.data)));
  }

  async writeRecord(type, record, persist = false) {
    this.db.run(
      `
        INSERT OR REPLACE INTO records (
          type,
          id,
          data,
          cardId,
          chatId,
          characterId,
          role,
          enabled,
          importance,
          createdAt,
          updatedAt
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        type,
        record.id,
        JSON.stringify(record),
        record.cardId ?? null,
        record.chatId ?? null,
        record.characterId ?? null,
        record.role ?? null,
        toInteger(record.enabled),
        toInteger(record.importance),
        record.createdAt ?? null,
        record.updatedAt ?? null
      ]
    );

    if (persist) {
      await this.persist();
    }
  }

  async deleteRecord(type, id, persist = false) {
    const existing = this.readRecord(type, id);
    if (!existing) {
      return null;
    }
    this.db.run("DELETE FROM records WHERE type = ? AND id = ?", [type, id]);
    if (persist) {
      await this.persist();
    }
    return existing;
  }

  getSettings() {
    return clone(this.readRecord("settings", "settings") ?? defaultSettings());
  }

  async updateSettings(updates) {
    const settings = {
      ...this.getSettings(),
      ...updates,
      updatedAt: now()
    };
    await this.writeRecord("settings", settings);
    await this.persist();
    return this.getSettings();
  }

  listCharacters() {
    return clone(this.readRecords("character", "", [], "ORDER BY updatedAt DESC"));
  }

  getCharacter(id) {
    return clone(this.readRecord("character", id));
  }

  getCharacterByCardId(cardId) {
    const row = this.readRecords("character", "AND cardId = ?", [cardId], "LIMIT 1")[0] ?? null;
    return clone(row);
  }

  async createCharacter(input) {
    const timestamp = now();
    const character = {
      id: input.id ?? randomUUID(),
      cardId: input.cardId ?? randomUUID(),
      name: input.name,
      avatar: input.avatar ?? null,
      description: input.description ?? "",
      tags: input.tags ?? [],
      prefix: input.prefix ?? "",
      prompt: input.prompt ?? "",
      suffix: input.suffix ?? "",
      htmlCss: input.htmlCss ?? "",
      openingHtml: input.openingHtml ?? "",
      loreEntries: input.loreEntries ?? [],
      quickReplies: input.quickReplies ?? [],
      createdAt: input.createdAt ?? timestamp,
      updatedAt: input.updatedAt ?? timestamp
    };
    await this.writeRecord("character", character);
    await this.persist();
    return clone(character);
  }

  async updateCharacter(id, updates) {
    const existing = this.readRecord("character", id);
    if (!existing) return null;
    const character = { ...existing, ...updates, updatedAt: updates.updatedAt ?? now() };
    await this.writeRecord("character", character);
    await this.persist();
    return clone(character);
  }

  async upsertCharacterByCardId(input) {
    const existing = this.getCharacterByCardId(input.cardId);
    if (existing) {
      return this.updateCharacter(existing.id, input);
    }
    return this.createCharacter(input);
  }

  async deleteCharacter(id) {
    const existing = await this.deleteRecord("character", id);
    if (!existing) {
      return false;
    }
    for (const chat of this.readRecords("chat", "AND characterId = ?", [id])) {
      await this.writeRecord("chat", { ...chat, characterId: null, updatedAt: now() });
    }
    for (const message of this.readRecords("message", "AND characterId = ?", [id])) {
      await this.writeRecord("message", { ...message, characterId: null, updatedAt: now() });
    }
    await this.persist();
    return true;
  }

  listChats() {
    return clone(
      this.readRecords("chat", "", [], "ORDER BY updatedAt DESC").map((chat) => ({
        ...chat,
        messageCount: this.readRecords("message", "AND chatId = ?", [chat.id]).length
      }))
    );
  }

  getChat(id) {
    return clone(this.readRecord("chat", id));
  }

  async createChat(input) {
    const timestamp = now();
    const chat = {
      id: input.id ?? randomUUID(),
      title: input.title,
      characterId: input.characterId ?? null,
      backgroundUrl: input.backgroundUrl ?? "",
      memoryTurns: input.memoryTurns ?? 12,
      autoMemoryEnabled: input.autoMemoryEnabled ?? true,
      memoryUpdatedAt: input.memoryUpdatedAt ?? null,
      userPersona: input.userPersona ?? "",
      userProfileSummary: input.userProfileSummary ?? "",
      userProfileUpdatedAt: input.userProfileUpdatedAt ?? null,
      createdAt: input.createdAt ?? timestamp,
      updatedAt: input.updatedAt ?? timestamp
    };
    await this.writeRecord("chat", chat);
    await this.persist();
    return clone(chat);
  }

  async updateChat(id, updates) {
    const existing = this.readRecord("chat", id);
    if (!existing) return null;
    const chat = { ...existing, ...updates, updatedAt: updates.updatedAt ?? now() };
    await this.writeRecord("chat", chat);
    await this.persist();
    return clone(chat);
  }

  async deleteChat(id) {
    const existing = await this.deleteRecord("chat", id);
    if (!existing) {
      return false;
    }
    this.db.run("DELETE FROM records WHERE type IN ('message', 'memory') AND chatId = ?", [id]);
    await this.persist();
    return true;
  }

  listMessages(chatId) {
    return clone(
      this.readRecords(
        "message",
        chatId ? "AND chatId = ?" : "",
        chatId ? [chatId] : [],
        "ORDER BY createdAt ASC"
      )
    );
  }

  getMessage(id) {
    return clone(this.readRecord("message", id));
  }

  async createMessage(input) {
    const timestamp = now();
    const message = {
      id: input.id ?? randomUUID(),
      chatId: input.chatId,
      role: input.role,
      characterId: input.characterId ?? null,
      content: input.content ?? "",
      variants: input.variants ?? [],
      activeVariantIndex: input.activeVariantIndex ?? 0,
      tokenUsage: input.tokenUsage ?? null,
      loreMatches: input.loreMatches ?? null,
      memoryMatches: input.memoryMatches ?? null,
      createdAt: input.createdAt ?? timestamp,
      updatedAt: input.updatedAt ?? timestamp
    };
    await this.writeRecord("message", message);
    await this.touchChat(message.chatId, false);
    await this.persist();
    return clone(message);
  }

  async updateMessage(id, updates) {
    const existing = this.readRecord("message", id);
    if (!existing) return null;
    const message = { ...existing, ...updates, updatedAt: updates.updatedAt ?? now() };
    await this.writeRecord("message", message);
    await this.touchChat(message.chatId, false);
    await this.persist();
    return clone(message);
  }

  async deleteMessage(id) {
    const existing = await this.deleteRecord("message", id);
    if (!existing) return null;
    await this.touchChat(existing.chatId, false);
    await this.persist();
    return clone(existing);
  }

  async deleteMessagesAfter(message) {
    const removed = this.readRecords("message", "AND chatId = ? AND createdAt >= ?", [
      message.chatId,
      message.createdAt
    ]);
    this.db.run("DELETE FROM records WHERE type = 'message' AND chatId = ? AND createdAt >= ?", [
      message.chatId,
      message.createdAt
    ]);
    await this.touchChat(message.chatId, false);
    await this.persist();
    return clone(removed);
  }

  listMemories(chatId) {
    return clone(
      this.readRecords(
        "memory",
        "AND chatId = ?",
        [chatId],
        "ORDER BY enabled DESC, importance DESC, updatedAt DESC"
      )
    );
  }

  getMemory(chatId, memoryId) {
    return clone(this.readRecords("memory", "AND chatId = ? AND id = ?", [chatId, memoryId])[0] ?? null);
  }

  async createMemory(input) {
    const timestamp = now();
    const memory = {
      id: input.id ?? randomUUID(),
      chatId: input.chatId,
      title: input.title,
      content: input.content,
      keywords: input.keywords ?? [],
      importance: input.importance ?? 3,
      enabled: input.enabled ?? true,
      sourceMessageIds: input.sourceMessageIds ?? [],
      lastMatchedAt: input.lastMatchedAt ?? null,
      createdAt: input.createdAt ?? timestamp,
      updatedAt: input.updatedAt ?? timestamp
    };
    await this.writeRecord("memory", memory);
    await this.persist();
    return clone(memory);
  }

  async updateMemory(chatId, memoryId, updates) {
    const existing = this.getMemory(chatId, memoryId);
    if (!existing) return null;
    const memory = { ...existing, ...updates, updatedAt: updates.updatedAt ?? now() };
    await this.writeRecord("memory", memory);
    await this.persist();
    return clone(memory);
  }

  async deleteMemory(chatId, memoryId) {
    const existing = this.getMemory(chatId, memoryId);
    if (!existing) return false;
    await this.deleteRecord("memory", memoryId);
    await this.persist();
    return true;
  }

  async importBackup(backup) {
    if (backup.mode === "replace") {
      this.db.run("DELETE FROM records WHERE type IN ('character', 'chat', 'message', 'memory')");
    }

    if (backup.settings) {
      await this.writeRecord("settings", {
        ...this.getSettings(),
        ...backup.settings,
        id: "settings",
        updatedAt: now()
      });
    }

    for (const character of backup.characters ?? []) {
      await this.upsertCharacterByCardId(character);
    }

    for (const chat of backup.chats ?? []) {
      const existing = this.readRecord("chat", chat.id);
      await this.writeRecord("chat", {
        ...(existing ?? {}),
        ...chat,
        id: chat.id ?? randomUUID(),
        updatedAt: chat.updatedAt ?? now()
      });
    }

    let memories = 0;
    for (const memory of backup.memories ?? []) {
      if (!this.readRecord("chat", memory.chatId)) continue;
      await this.writeRecord("memory", {
        ...memory,
        id: memory.id ?? randomUUID(),
        updatedAt: memory.updatedAt ?? now()
      });
      memories += 1;
    }

    let messages = 0;
    for (const message of backup.messages ?? []) {
      if (!this.readRecord("chat", message.chatId)) continue;
      await this.writeRecord("message", {
        ...message,
        id: message.id ?? randomUUID(),
        updatedAt: message.updatedAt ?? now()
      });
      messages += 1;
    }

    await this.persist();
    return {
      mode: backup.mode,
      characters: backup.characters?.length ?? 0,
      chats: backup.chats?.length ?? 0,
      messages,
      memories,
      settingsImported: Boolean(backup.settings)
    };
  }

  exportBackup(settings) {
    return {
      schemaVersion: 1,
      exportedAt: now(),
      settings,
      characters: clone(this.readRecords("character", "", [], "ORDER BY updatedAt DESC")),
      chats: clone(this.readRecords("chat", "", [], "ORDER BY updatedAt DESC")),
      messages: clone(this.readRecords("message", "", [], "ORDER BY createdAt ASC")),
      memories: clone(this.readRecords("memory", "", [], "ORDER BY updatedAt DESC"))
    };
  }

  async touchChat(chatId, persist = true) {
    const chat = this.readRecord("chat", chatId);
    if (chat) {
      await this.writeRecord("chat", { ...chat, updatedAt: now() });
    }
    if (persist) {
      await this.persist();
    }
  }
}
