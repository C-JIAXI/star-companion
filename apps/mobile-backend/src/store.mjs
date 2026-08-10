import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import initSqlJs from "sql.js";
import { analyzeBackupCandidate } from "../server-dist/services/backupContract.js";
import { backupImportSchema } from "../server-dist/schemas.js";
import { generatedBuildInfo } from "../server-dist/generated/buildInfo.js";
import { runProtectedMobileMigrations } from "./migration-safety.mjs";

const now = () => new Date().toISOString();
const clone = (value) => JSON.parse(JSON.stringify(value));
const dropUndefined = (value) =>
  Object.fromEntries(Object.entries(value).filter(([_key, entry]) => entry !== undefined));

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
    moduleModelPreferences: {},
    userPersonaPresets: [],
    userProfileSummary: "",
    autoSummarizeUser: true,
    showMessageAvatars: true,
    showMessageTimestamps: false,
    ttsVoice: "alloy",
    ttsPlaybackRate: 1,
    ttsAutoPlay: false,
    userProfileUpdatedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
};

const compareDesc = (field) => (a, b) => String(b[field]).localeCompare(String(a[field]));
const compareAsc = (field) => (a, b) => String(a[field]).localeCompare(String(b[field]));

const toInteger = (value) => (value === undefined || value === null ? null : Number(value));
const RECOVERY_POINT_LIMIT = 10;
const RECOVERY_POINT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export class MobileStore {
  constructor(filePath) {
    this.filePath = filePath.replace(/\.json$/i, ".sqlite");
    this.SQL = null;
    this.db = null;
    this.writeQueue = Promise.resolve();
    this.migrationReport = null;
  }

  async load() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    this.SQL = await initSqlJs();

    const migrated = await runProtectedMobileMigrations({
      SQL: this.SQL,
      filePath: this.filePath,
      appVersion: generatedBuildInfo.appVersion
    });
    this.db = migrated.db;
    this.migrationReport = migrated.report;

    if (!this.readRecord("settings", "settings")) {
      await this.writeRecord("settings", defaultSettings());
      await this.persist();
    }
  }

  async persist() {
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, Buffer.from(this.db.export()));
    });
    await this.writeQueue;
  }

  async atomicWrite(operation) {
    const before = this.db.export();
    this.db.run("BEGIN");
    try {
      const result = await operation();
      this.db.run("COMMIT");
      await this.persist();
      return result;
    } catch (error) {
      try {
        this.db.run("ROLLBACK");
      } catch {
        this.db.close();
        this.db = new this.SQL.Database(before);
      }
      throw error;
    }
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
      ...dropUndefined(updates),
      updatedAt: now()
    };
    await this.writeRecord("settings", settings);
    await this.persist();
    return this.getSettings();
  }

  listCharacters() {
    return clone(
      this.readRecords("character", "", [], "ORDER BY updatedAt DESC").sort(
        (left, right) => Number(right.isFavorite === true) - Number(left.isFavorite === true)
      )
    );
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
      isFavorite: input.isFavorite === true,
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

  async batchUpdateCharacterTags(ids, operation, tags, applyOperation) {
    const characters = ids.map((id) => this.readRecord("character", id));
    if (characters.some((character) => !character)) {
      return null;
    }

    const updates = characters.map((character) => ({
      ...character,
      tags: applyOperation(character.tags, operation, tags),
      updatedAt: now()
    }));

    for (const character of updates) {
      await this.writeRecord("character", character);
    }
    await this.persist();
    return updates.length;
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
      })).sort((a, b) => {
        const trashOrder = Number(Boolean(a.deletedAt)) - Number(Boolean(b.deletedAt));
        const archiveOrder = Number(a.isArchived === true) - Number(b.isArchived === true);
        const pinOrder = Number(b.isPinned === true) - Number(a.isPinned === true);
        return trashOrder || archiveOrder || pinOrder || String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? ""));
      })
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
      parentChatId: input.parentChatId ?? null,
      branchSourceMessageId: input.branchSourceMessageId ?? null,
      isCheckpoint: input.isCheckpoint === true,
      isPinned: input.isPinned === true,
      isArchived: input.isArchived === true,
      folder: input.folder ?? "",
      deletedAt: input.deletedAt ?? null,
      backgroundUrl: input.backgroundUrl ?? "",
      memoryTurns: input.memoryTurns ?? 12,
      autoMemoryEnabled: input.autoMemoryEnabled ?? true,
      memoryUpdatedAt: input.memoryUpdatedAt ?? null,
      userPersona: input.userPersona ?? "",
      userAvatar: input.userAvatar ?? "",
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

  async updateChats(ids, updates) {
    const timestamp = updates.updatedAt ?? now();
    let updated = 0;
    this.db.run("BEGIN");
    try {
      for (const id of new Set(ids)) {
        const existing = this.readRecord("chat", id);
        if (!existing) continue;
        await this.writeRecord("chat", { ...existing, ...updates, updatedAt: timestamp });
        updated += 1;
      }
      this.db.run("COMMIT");
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
    await this.persist();
    return updated;
  }

  async updateChatTrash(ids, action) {
    const uniqueIds = [...new Set(ids)];
    const chats = uniqueIds.map((id) => this.readRecord("chat", id));
    const expected = action === "trash"
      ? chats.every((chat) => chat && !chat.deletedAt)
      : chats.every((chat) => chat?.deletedAt);
    if (!expected) return null;

    const timestamp = now();
    this.db.run("BEGIN");
    try {
      for (const chat of chats) {
        await this.writeRecord("chat", {
          ...chat,
          ...(action === "trash"
            ? { deletedAt: timestamp, isArchived: false, isPinned: false }
            : { deletedAt: null }),
          updatedAt: timestamp
        });
      }
      this.db.run("COMMIT");
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
    await this.persist();
    return uniqueIds.length;
  }

  async permanentlyDeleteChats(ids) {
    const uniqueIds = [...new Set(ids)];
    const chats = uniqueIds.map((id) => this.readRecord("chat", id));
    if (!chats.every((chat) => chat?.deletedAt)) return null;

    const deletedIds = new Set(uniqueIds);
    const timestamp = now();
    this.db.run("BEGIN");
    try {
      for (const child of this.readRecords("chat")) {
        if (child.parentChatId && deletedIds.has(child.parentChatId)) {
          await this.writeRecord("chat", {
            ...child,
            parentChatId: null,
            branchSourceMessageId: null,
            updatedAt: timestamp
          });
        }
      }
      for (const id of uniqueIds) {
        await this.deleteRecord("chat", id);
        this.db.run("DELETE FROM records WHERE type IN ('message', 'memory') AND chatId = ?", [id]);
      }
      this.db.run("COMMIT");
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
    await this.persist();
    return uniqueIds.length;
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
      contextIncluded: input.contextIncluded !== false,
      isBookmarked: input.isBookmarked === true,
      variants: input.variants ?? [],
      activeVariantIndex: input.activeVariantIndex ?? 0,
      tokenUsage: input.tokenUsage ?? null,
      promptBreakdown: input.promptBreakdown ?? null,
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
    const embedding =
      Array.isArray(input.embedding) &&
      input.embedding.length > 0 &&
      input.embedding.every((entry) => typeof entry === "number" && Number.isFinite(entry))
        ? input.embedding
        : null;
    const memory = {
      id: input.id ?? randomUUID(),
      chatId: input.chatId,
      title: input.title,
      content: input.content,
      keywords: input.keywords ?? [],
      importance: input.importance ?? 3,
      enabled: input.enabled ?? true,
      sourceMessageIds: input.sourceMessageIds ?? [],
      embedding,
      embeddingModel: embedding ? input.embeddingModel ?? null : null,
      embeddingSource: embedding ? input.embeddingSource ?? null : null,
      embeddingDimensions: embedding ? input.embeddingDimensions ?? embedding.length : null,
      embeddingStatus: input.embeddingStatus ?? (embedding ? "ready" : "stale"),
      embeddingUpdatedAt: embedding ? input.embeddingUpdatedAt ?? null : null,
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

  async markMemoryEmbeddingsStale() {
    const memories = this.readRecords("memory");
    for (const memory of memories) {
      await this.writeRecord("memory", {
        ...memory,
        embedding: null,
        embeddingSource: null,
        embeddingDimensions: null,
        embeddingStatus: "stale",
        embeddingUpdatedAt: null,
        updatedAt: now()
      });
    }
    await this.persist();
  }

  async deleteMemory(chatId, memoryId) {
    const existing = this.getMemory(chatId, memoryId);
    if (!existing) return false;
    await this.deleteRecord("memory", memoryId);
    await this.persist();
    return true;
  }

  previewBackup(candidate, settings) {
    const current = backupImportSchema.parse({
      ...this.exportBackup(settings),
      mode: "merge"
    });
    return analyzeBackupCandidate(candidate, current).preview;
  }

  listRecoveryPoints() {
    return clone(
      this.readRecords("recoveryPoint", "", [], "ORDER BY createdAt DESC").map(
        ({ snapshot: _snapshot, ...point }) => point
      )
    );
  }

  async createRecoveryPoint(reason, settings) {
    const snapshot = { ...this.exportBackup(settings), mode: "replace" };
    const point = {
      id: randomUUID(),
      reason,
      createdAt: now(),
      summary: {
        settings: snapshot.settings ? 1 : 0,
        characters: snapshot.characters.length,
        chats: snapshot.chats.length,
        messages: snapshot.messages.length,
        memories: snapshot.memories.length
      },
      snapshot
    };
    await this.writeRecord("recoveryPoint", point);
    const points = this.readRecords("recoveryPoint", "", [], "ORDER BY createdAt DESC");
    const cutoff = Date.now() - RECOVERY_POINT_MAX_AGE_MS;
    for (const [index, entry] of points.entries()) {
      if (index >= RECOVERY_POINT_LIMIT || Date.parse(entry.createdAt) < cutoff) {
        await this.deleteRecord("recoveryPoint", entry.id);
      }
    }
    return point;
  }

  mergeProviderKeys(incoming, existing) {
    if (!Array.isArray(incoming)) return incoming;
    const keys = new Map(
      (Array.isArray(existing) ? existing : []).flatMap((provider) =>
        provider && typeof provider.id === "string" && typeof provider.key === "string"
          ? [[provider.id, provider.key]]
          : []
      )
    );
    return incoming.map((provider) => {
      const key = provider && typeof provider.id === "string" ? keys.get(provider.id) : undefined;
      return key ? { ...provider, key } : provider;
    });
  }

  shouldApplyBackupRecord(record, mode, resolutions) {
    if (record.status === "invalid") return false;
    if (mode === "replace") return true;
    if (record.status === "skipped") return false;
    if (record.status === "added") return true;
    return Boolean(record.key && resolutions.get(record.key) === "use_incoming");
  }

  async applyBackupAnalysis(analysis, resolutions) {
    const { backup, records } = analysis;
    if (backup.mode === "replace") {
      this.db.run("DELETE FROM records WHERE type IN ('character', 'chat', 'message', 'memory')");
    }

    const existingSettings = this.getSettings();
    let settingsImported = false;
    if (records.settings && this.shouldApplyBackupRecord(records.settings, backup.mode, resolutions)) {
      const incoming = records.settings.value;
      await this.writeRecord("settings", {
        ...existingSettings,
        ...incoming,
        ...(incoming.providers
          ? { providers: this.mergeProviderKeys(incoming.providers, existingSettings.providers) }
          : {}),
        id: "settings",
        updatedAt: now()
      });
      settingsImported = true;
    }

    const appliedCounts = { characters: 0, chats: 0, messages: 0, memories: 0 };
    for (const entity of ["characters", "chats", "messages", "memories"]) {
      const type = entity === "characters" ? "character" : entity === "chats" ? "chat" : entity === "messages" ? "message" : "memory";
      for (const record of records[entity]) {
        if (!this.shouldApplyBackupRecord(record, backup.mode, resolutions)) continue;
        const value = {
          ...record.value,
          id: record.value.id ?? randomUUID(),
          ...(entity === "chats" ? { folder: record.value.folder ?? "", deletedAt: record.value.deletedAt ?? null } : {}),
          ...(entity === "memories"
            ? {
                embedding: null,
                embeddingModel: null,
                embeddingSource: null,
                embeddingDimensions: null,
                embeddingStatus: "stale",
                embeddingUpdatedAt: null
              }
            : {}),
          updatedAt: record.value.updatedAt ?? now()
        };
        await this.writeRecord(type, value);
        appliedCounts[entity] += 1;
      }
    }

    let added = 0;
    let updated = 0;
    let skipped = 0;
    let conflictsResolved = 0;
    const allRecords = [
      ...(records.settings ? [records.settings] : []),
      ...records.characters,
      ...records.chats,
      ...records.messages,
      ...records.memories
    ];
    for (const record of allRecords) {
      if (record.status === "added") added += 1;
      else if (record.status === "skipped") skipped += 1;
      else if (record.status === "conflict") {
        const action = backup.mode === "replace" ? "use_incoming" : resolutions.get(record.key);
        if (action === "use_incoming") {
          updated += 1;
          conflictsResolved += 1;
        } else {
          skipped += 1;
        }
      }
    }
    return { mode: backup.mode, ...appliedCounts, settingsImported, added, updated, skipped, conflictsResolved };
  }

  async importBackup(input, settings) {
    return this.atomicWrite(async () => {
      const current = backupImportSchema.parse({ ...this.exportBackup(settings), mode: "merge" });
      const analysis = analyzeBackupCandidate(input, current);
      if (analysis.preview.previewId !== input.previewId) {
        const error = new Error("Data changed after the preview. Run the preview again before importing.");
        error.status = 409;
        throw error;
      }
      if (!analysis.preview.canExecute) {
        const error = new Error("The backup cannot be imported until its validation issues are fixed.");
        error.status = 400;
        throw error;
      }
      const resolutions = new Map((input.conflictResolutions ?? []).map((entry) => [entry.key, entry.action]));
      if (input.mode === "merge" && analysis.preview.conflicts.some((entry) => !resolutions.has(entry.key))) {
        const error = new Error("Choose an action for every conflict before importing.");
        error.status = 409;
        throw error;
      }
      const recoveryPoint = analysis.preview.requiresRecoveryPoint
        ? await this.createRecoveryPoint("before_import", settings)
        : null;
      const applied = await this.applyBackupAnalysis(analysis, resolutions);
      return {
        ...applied,
        recoveryPointId: recoveryPoint?.id ?? null,
        completedAt: now()
      };
    });
  }

  async restoreRecoveryPoint(id, settings) {
    return this.atomicWrite(async () => {
      const point = this.readRecord("recoveryPoint", id);
      if (!point) {
        const error = new Error("Recovery point not found.");
        error.status = 404;
        throw error;
      }
      const current = backupImportSchema.parse({ ...this.exportBackup(settings), mode: "merge" });
      const analysis = analyzeBackupCandidate({ ...point.snapshot, mode: "replace" }, current);
      if (!analysis.preview.canExecute) {
        const error = new Error("This recovery point failed integrity validation and was not restored.");
        error.status = 400;
        throw error;
      }
      const safetyPoint = await this.createRecoveryPoint("before_restore", settings);
      const applied = await this.applyBackupAnalysis(analysis, new Map());
      const completedAt = now();
      return {
        recoveryPointId: id,
        safetyRecoveryPointId: safetyPoint.id,
        completedAt,
        summary: { ...applied, recoveryPointId: safetyPoint.id, completedAt }
      };
    });
  }

  exportBackup(settings) {
    const memories = this.readRecords("memory", "", [], "ORDER BY updatedAt DESC").map(
      ({ embedding: _embedding, ...memory }) => memory
    );
    return {
      schemaVersion: 1,
      exportedAt: now(),
      settings,
      characters: clone(this.readRecords("character", "", [], "ORDER BY updatedAt DESC")),
      chats: clone(
        this.readRecords("chat", "", [], "ORDER BY updatedAt DESC").map((chat) => ({
          ...chat,
          deletedAt: chat.deletedAt ?? null
        }))
      ),
      messages: clone(this.readRecords("message", "", [], "ORDER BY createdAt ASC")),
      memories: clone(memories)
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
