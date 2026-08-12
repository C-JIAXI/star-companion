import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
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
    modelReliability: { retry: { enabled: false, maxRetries: 0 }, fallback: {} },
    usageBudgets: { dailySoftMicros: null, dailyHardMicros: null, monthlySoftMicros: null, monthlyHardMicros: null, allowUnknownPricing: true },
    usageTimezone: "UTC",
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
    this.transactionQueue = Promise.resolve();
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
    await this.recoverInterruptedModelCalls();
    await this.ensureMemoryHistoryBaselines();
  }

  async persist() {
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, Buffer.from(this.db.export()));
    });
    await this.writeQueue;
  }

  async atomicWrite(operation) {
    const run = async () => {
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
    };
    const result = this.transactionQueue.then(run, run);
    this.transactionQueue = result.then(() => undefined, () => undefined);
    return result;
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

  async createCharacter(input, persist = true) {
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
    if (persist) await this.persist();
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

  async createChat(input, persist = true) {
    const timestamp = now();
    const initialProfile = (input.userProfileSummary ?? "").trim();
    const shouldCreateProfileBaseline = initialProfile.length > 0 && input.profileRevision === undefined;
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
      userProfileSummary: initialProfile,
      userProfileUpdatedAt: input.userProfileUpdatedAt ?? null,
      profileRevision: input.profileRevision ?? (shouldCreateProfileBaseline ? 1 : 0),
      createdAt: input.createdAt ?? timestamp,
      updatedAt: input.updatedAt ?? timestamp
    };
    if (persist) this.db.run("BEGIN");
    try {
      await this.writeRecord("chat", chat);
      if (shouldCreateProfileBaseline) {
        await this.writeRecord("profileSummaryRevision", {
          id: randomUUID(),
          chatId: chat.id,
          revision: 1,
          action: "baseline",
          actor: input.profileBaselineActor ?? "user",
          summary: initialProfile,
          sourceMessageIds: [],
          createdAt: timestamp
        });
      }
      if (persist) this.db.run("COMMIT");
    } catch (error) {
      if (persist) this.db.run("ROLLBACK");
      throw error;
    }
    if (persist) await this.persist();
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
        for (const message of this.listMessages(id)) for (const attachment of this.listMessageAttachments(message.id)) await this.deleteRecord("messageAttachment", attachment.id);
        await this.deleteRecord("chat", id);
        this.db.run("DELETE FROM records WHERE type IN ('message', 'memory', 'memoryRevision', 'memoryOperation', 'profileSummaryRevision') AND chatId = ?", [id]);
      }
      await this.cleanupOrphanAssets();
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

  listMessageAttachments(messageId) {
    return clone(this.readRecords("messageAttachment").filter((item) => item.messageId === messageId).sort((a, b) => a.sortOrder - b.sortOrder));
  }

  listDraftAttachments(draftId) {
    return clone(this.readRecords("messageAttachment").filter((item) => item.draftId === draftId && !item.messageId).sort((a, b) => a.sortOrder - b.sortOrder));
  }

  getMediaAsset(id) {
    return clone(this.readRecord("mediaAsset", id));
  }

  async createDraftAttachment({ draftId, asset, originalFilename }) {
    return this.atomicWrite(async () => {
      const current = this.listDraftAttachments(draftId);
      if (current.length >= 4) { const error = new Error("A message can contain at most 4 images."); error.status = 413; throw error; }
      const total = current.reduce((sum, item) => sum + (this.getMediaAsset(item.assetId)?.byteSize ?? 0), 0);
      if (total + asset.byteSize > 20 * 1024 * 1024) { const error = new Error("Images in one message can total at most 20 MB."); error.status = 413; throw error; }
      const existingAsset = this.readRecords("mediaAsset").find((item) => item.contentHash === asset.contentHash);
      const storedAsset = existingAsset ?? { ...asset, id: randomUUID(), storageKey: `sha256:${asset.contentHash}`, createdAt: now() };
      if (!existingAsset) await this.writeRecord("mediaAsset", storedAsset);
      const attachment = { id: randomUUID(), messageId: null, draftId, assetId: storedAsset.id, sortOrder: current.length, originalFilename: originalFilename ?? null, createdAt: now() };
      await this.writeRecord("messageAttachment", attachment);
      return { attachment, asset: storedAsset };
    });
  }

  async attachDraftToMessage(draftId, messageId) {
    if (!draftId) return [];
    const attachments = this.listDraftAttachments(draftId);
    if (!attachments.length) { const error = new Error("The selected draft images are unavailable. Add them again before sending."); error.status = 409; throw error; }
    for (const attachment of attachments) await this.writeRecord("messageAttachment", { ...attachment, draftId: null, messageId });
    return attachments.map((item) => ({ ...item, draftId: null, messageId }));
  }

  async cleanupOrphanAssets() {
    const referenced = new Set(this.readRecords("messageAttachment").map((item) => item.assetId));
    for (const item of this.readRecords("recoveryPointMediaAsset")) referenced.add(item.assetId);
    for (const asset of this.readRecords("mediaAsset")) if (!referenced.has(asset.id)) await this.deleteRecord("mediaAsset", asset.id);
  }

  async removeDraftAttachment(draftId, attachmentId) {
    return this.atomicWrite(async () => {
      const attachment = this.readRecord("messageAttachment", attachmentId);
      if (!attachment || attachment.draftId !== draftId || attachment.messageId) return null;
      await this.deleteRecord("messageAttachment", attachmentId);
      for (const [sortOrder, item] of this.listDraftAttachments(draftId).entries()) await this.writeRecord("messageAttachment", { ...item, sortOrder });
      await this.cleanupOrphanAssets();
      return attachment;
    });
  }

  async reorderDraftAttachments(draftId, attachmentIds) {
    return this.atomicWrite(async () => {
      const current = this.listDraftAttachments(draftId);
      if (current.length !== attachmentIds.length || new Set(attachmentIds).size !== current.length || current.some((item) => !attachmentIds.includes(item.id))) {
        const error = new Error("The draft images changed. Reload them before reordering."); error.status = 409; throw error;
      }
      const byId = new Map(current.map((item) => [item.id, item]));
      for (const [sortOrder, id] of attachmentIds.entries()) await this.writeRecord("messageAttachment", { ...byId.get(id), sortOrder });
      return this.listDraftAttachments(draftId);
    });
  }

  async discardDraftAttachments(draftId) {
    return this.atomicWrite(async () => {
      const attachments = this.listDraftAttachments(draftId);
      for (const item of attachments) await this.deleteRecord("messageAttachment", item.id);
      await this.cleanupOrphanAssets();
      return attachments.length;
    });
  }

  getMessage(id) {
    return clone(this.readRecord("message", id));
  }

  async createMessage(input, persist = true) {
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
      generationMetadata: input.generationMetadata ?? null,
      variantMetadata: input.variantMetadata ?? [],
      promptBreakdown: input.promptBreakdown ?? null,
      loreMatches: input.loreMatches ?? null,
      memoryMatches: input.memoryMatches ?? null,
      createdAt: input.createdAt ?? timestamp,
      updatedAt: input.updatedAt ?? timestamp
    };
    await this.writeRecord("message", message);
    await this.touchChat(message.chatId, false);
    if (persist) await this.persist();
    return clone(message);
  }

  async createMessageWithDraft(input, draftId) {
    return this.atomicWrite(async () => {
      const message = await this.createMessage(input, false);
      await this.attachDraftToMessage(draftId, message.id);
      return message;
    });
  }

  async copyMessageAttachments(sourceMessageId, targetMessageId) {
    for (const attachment of this.listMessageAttachments(sourceMessageId)) await this.writeRecord("messageAttachment", {
      ...attachment,
      id: randomUUID(),
      messageId: targetMessageId,
      draftId: null
    });
    await this.persist();
  }

  async stageMessageAttachmentsForEdit(messageId, draftId) {
    return this.atomicWrite(async () => {
      const message = this.getMessage(messageId);
      if (!message) return null;
      if (message.role !== "user") { const error = new Error("Image attachments can only be edited on user messages."); error.status = 400; throw error; }
      for (const attachment of this.listDraftAttachments(draftId)) await this.deleteRecord("messageAttachment", attachment.id);
      for (const attachment of this.listMessageAttachments(messageId)) await this.writeRecord("messageAttachment", { ...attachment, id: randomUUID(), messageId: null, draftId });
      return this.listDraftAttachments(draftId);
    });
  }

  async updateMessageWithAttachments(id, updates, { replaceAttachments = false, draftId } = {}) {
    return this.atomicWrite(async () => {
      const existing = this.readRecord("message", id);
      if (!existing) return null;
      if (replaceAttachments && existing.role !== "user") { const error = new Error("Image attachments can only be edited on user messages."); error.status = 400; throw error; }
      if (replaceAttachments) {
        for (const attachment of this.listMessageAttachments(id)) await this.deleteRecord("messageAttachment", attachment.id);
        if (draftId) await this.attachDraftToMessage(draftId, id);
      }
      const nextContent = typeof updates.content === "string" ? updates.content : existing.content;
      if (!String(nextContent ?? "").trim() && this.listMessageAttachments(id).length === 0) { const error = new Error("A message must contain text or an image attachment."); error.status = 400; throw error; }
      const message = { ...existing, ...updates, updatedAt: now() };
      await this.writeRecord("message", message);
      await this.touchChat(message.chatId, false);
      await this.cleanupOrphanAssets();
      return clone(message);
    });
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
    for (const attachment of this.listMessageAttachments(id)) await this.deleteRecord("messageAttachment", attachment.id);
    await this.cleanupOrphanAssets();
    await this.touchChat(existing.chatId, false);
    await this.persist();
    return clone(existing);
  }

  async deleteMessagesAfter(message) {
    return this.atomicWrite(async () => {
      const removed = this.readRecords("message", "AND chatId = ? AND createdAt >= ?", [
        message.chatId,
        message.createdAt
      ]);
      for (const item of removed) for (const attachment of this.listMessageAttachments(item.id)) await this.deleteRecord("messageAttachment", attachment.id);
      this.db.run("DELETE FROM records WHERE type = 'message' AND chatId = ? AND createdAt >= ?", [
        message.chatId,
        message.createdAt
      ]);
      const disabledMemoryCount = await this.disableMemoriesForRemovedSourcesInTransaction(
        message.chatId,
        removed.map((item) => item.id)
      );
      await this.cleanupOrphanAssets();
      await this.touchChat(message.chatId, false);
      return { removed: clone(removed), disabledMemoryCount };
    });
  }

  async prepareUserMessageResend(message) {
    return this.atomicWrite(async () => {
      const sourceAttachments = this.listMessageAttachments(message.id);
      const removed = this.readRecords("message", "AND chatId = ? AND createdAt >= ?", [message.chatId, message.createdAt]);
      for (const item of removed) {
        for (const attachment of this.listMessageAttachments(item.id)) await this.deleteRecord("messageAttachment", attachment.id);
        await this.deleteRecord("message", item.id);
      }
      const userMessage = await this.createMessage({
        chatId: message.chatId,
        role: "user",
        content: message.content,
        variants: [],
        activeVariantIndex: 0
      }, false);
      for (const attachment of sourceAttachments) await this.writeRecord("messageAttachment", {
        ...attachment,
        id: randomUUID(),
        messageId: userMessage.id,
        draftId: null
      });
      const disabledMemoryCount = await this.disableMemoriesForRemovedSourcesInTransaction(message.chatId, removed.map((item) => item.id));
      await this.cleanupOrphanAssets();
      await this.touchChat(message.chatId, false);
      return { userMessage, disabledMemoryCount };
    });
  }

  async deleteMessageTimeline(messageId) {
    return this.atomicWrite(async () => {
      const target = this.readRecord("message", messageId);
      if (!target) return null;
      const timeline = this.readRecords(
        "message",
        "AND chatId = ?",
        [target.chatId],
        "ORDER BY createdAt ASC"
      );
      const targetIndex = timeline.findIndex((message) => message.id === target.id);
      if (targetIndex < 0) return null;
      const removed = target.role === "user" ? timeline.slice(targetIndex) : [target];
      for (const message of removed) {
        for (const attachment of this.listMessageAttachments(message.id)) await this.deleteRecord("messageAttachment", attachment.id);
        await this.deleteRecord("message", message.id);
      }
      await this.cleanupOrphanAssets();
      const disabledMemoryCount = await this.disableMemoriesForRemovedSourcesInTransaction(
        target.chatId,
        removed.map((message) => message.id)
      );
      await this.touchChat(target.chatId, false);
      return { chatId: target.chatId, deletedCount: removed.length, disabledMemoryCount };
    });
  }

  async disableMemoriesForRemovedSourcesInTransaction(chatId, removedMessageIds) {
    const removedIds = new Set(removedMessageIds);
    const affected = this.listMemories(chatId).filter(
      (memory) =>
        !memory.deletedAt &&
        memory.enabled &&
        (memory.sourceMessageIds ?? []).some((messageId) => removedIds.has(messageId))
    );
    for (const memory of affected) {
      await this.updateAuditedMemoryInTransaction(
        memory,
        { enabled: false },
        {
          actor: "timeline_cleanup",
          action: "timeline_disable",
          reasonCode: "source_timeline_deleted",
          allowMissingSources: true
        }
      );
    }
    return affected.length;
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

  memorySnapshot(memory) {
    return {
      title: memory.title,
      content: memory.content,
      keywords: Array.isArray(memory.keywords) ? memory.keywords : [],
      importance: memory.importance,
      enabled: memory.enabled,
      sourceMessageIds: Array.isArray(memory.sourceMessageIds) ? memory.sourceMessageIds : []
    };
  }

  sourceReferences(chatId, ids) {
    return [...new Set(ids ?? [])].map((messageId) => ({
      messageId,
      available: this.readRecords("message", "AND id = ? AND chatId = ?", [messageId, chatId]).length > 0
    }));
  }

  validateSourceMessageIds(chatId, ids, allowMissing = false) {
    const sourceMessageIds = [...new Set(ids ?? [])];
    for (const messageId of sourceMessageIds) {
      const message = this.readRecord("message", messageId);
      if (message && message.chatId !== chatId) {
        const error = new Error("A source message belongs to another chat.");
        error.status = 400;
        throw error;
      }
      if (!message && !allowMissing) {
        const error = new Error("One or more source messages are unavailable.");
        error.status = 400;
        throw error;
      }
    }
    return sourceMessageIds;
  }

  async ensureMemoryHistoryBaselines() {
    const memories = this.readRecords("memory");
    const chats = this.readRecords("chat");
    const needsMemory = memories.some((memory) => !Number.isInteger(memory.currentRevision) || memory.currentRevision < 1);
    const needsProfile = chats.some((chat) => chat.userProfileSummary && (!Number.isInteger(chat.profileRevision) || chat.profileRevision < 1));
    if (!needsMemory && !needsProfile) return;
    await this.atomicWrite(async () => {
      for (const existing of memories) {
        if (Number.isInteger(existing.currentRevision) && existing.currentRevision > 0) continue;
        const memory = { ...existing, deletedAt: existing.deletedAt ?? null, currentRevision: 1, lastActor: "restore", lastAction: "baseline" };
        await this.writeRecord("memory", memory);
        await this.writeRecord("memoryRevision", {
          id: `baseline:${memory.id}`, memoryId: memory.id, chatId: memory.chatId, revision: 1,
          action: "baseline", actor: "restore", beforeSnapshot: null, afterSnapshot: this.memorySnapshot(memory),
          sourceMessageIds: memory.sourceMessageIds ?? [], operationId: null, reasonCode: "existing_data_baseline",
          createdAt: memory.createdAt ?? now()
        });
      }
      for (const existing of chats) {
        if (!existing.userProfileSummary || (Number.isInteger(existing.profileRevision) && existing.profileRevision > 0)) continue;
        await this.writeRecord("chat", { ...existing, profileRevision: 1 });
        await this.writeRecord("profileSummaryRevision", {
          id: `baseline:${existing.id}`, chatId: existing.id, revision: 1, action: "baseline", actor: "restore",
          summary: existing.userProfileSummary, sourceMessageIds: [], createdAt: existing.userProfileUpdatedAt ?? existing.createdAt ?? now()
        });
      }
    });
  }

  async pruneMemoryRevisions(memoryId) {
    const revisions = this.readRecords("memoryRevision").filter((item) => item.memoryId === memoryId).sort((a, b) => b.revision - a.revision);
    for (const revision of revisions.slice(30)) await this.deleteRecord("memoryRevision", revision.id);
  }

  async pruneMemoryOperations(chatId) {
    const operations = this.readRecords("memoryOperation", "AND chatId = ?", [chatId], "ORDER BY createdAt DESC");
    for (const operation of operations.slice(100)) await this.deleteRecord("memoryOperation", operation.id);
  }

  async createAuditedMemory(input, audit = { actor: "user", action: "manual_create", reasonCode: "user_created" }) {
    return this.atomicWrite(async () => this.createAuditedMemoryInTransaction(input, audit));
  }

  async createAuditedMemoryInTransaction(input, audit) {
    const timestamp = now();
    const sourceMessageIds = this.validateSourceMessageIds(input.chatId, input.sourceMessageIds ?? []);
    const memory = {
      id: input.id ?? randomUUID(), chatId: input.chatId, title: input.title, content: input.content,
      keywords: input.keywords ?? [], importance: input.importance ?? 3, enabled: input.enabled ?? true,
      deletedAt: null, currentRevision: 1, lastActor: audit.actor, lastAction: audit.action,
      sourceMessageIds, embedding: null, embeddingModel: null, embeddingSource: null, embeddingDimensions: null,
      embeddingStatus: "stale", embeddingUpdatedAt: null, lastMatchedAt: input.lastMatchedAt ?? null,
      createdAt: input.createdAt ?? timestamp, updatedAt: input.updatedAt ?? timestamp
    };
    await this.writeRecord("memory", memory);
    const revision = {
      id: randomUUID(), memoryId: memory.id, chatId: memory.chatId, revision: 1,
      action: audit.action, actor: audit.actor, beforeSnapshot: null, afterSnapshot: this.memorySnapshot(memory),
      sourceMessageIds, operationId: audit.operationId ?? null, reasonCode: audit.reasonCode, createdAt: timestamp
    };
    await this.writeRecord("memoryRevision", revision);
    return { memory: clone(memory), revision: clone(revision) };
  }

  async updateAuditedMemory(chatId, memoryId, updates, audit = { actor: "user", reasonCode: "user_edit" }) {
    return this.atomicWrite(async () => {
      const existing = this.getMemory(chatId, memoryId);
      if (!existing || existing.deletedAt) return null;
      const action = audit.action ?? (typeof updates.enabled === "boolean" && updates.enabled !== existing.enabled ? updates.enabled ? "manual_enable" : "manual_disable" : "manual_edit");
      return this.updateAuditedMemoryInTransaction(existing, updates, { ...audit, action });
    });
  }

  async updateAuditedMemoryInTransaction(existing, updates, audit) {
    const before = this.memorySnapshot(existing);
    const sourceMessageIds = this.validateSourceMessageIds(existing.chatId, updates.sourceMessageIds ?? before.sourceMessageIds, audit.allowMissingSources === true);
    const after = { ...before, ...updates, sourceMessageIds };
    if (JSON.stringify(before) === JSON.stringify(after) && !existing.deletedAt) return { memory: clone(existing), revision: null, changed: false };
    const revisionNumber = (existing.currentRevision ?? 0) + 1;
    const contentChanged = audit.action === "restore" || before.title !== after.title || before.content !== after.content || JSON.stringify(before.keywords) !== JSON.stringify(after.keywords);
    const memory = {
      ...existing, ...after, deletedAt: null, currentRevision: revisionNumber, lastActor: audit.actor, lastAction: audit.action,
      ...(contentChanged ? { embedding: null, embeddingModel: null, embeddingSource: null, embeddingDimensions: null, embeddingStatus: "stale", embeddingUpdatedAt: null } : {}),
      updatedAt: now()
    };
    await this.writeRecord("memory", memory);
    const revision = {
      id: randomUUID(), memoryId: memory.id, chatId: memory.chatId, revision: revisionNumber,
      action: audit.action, actor: audit.actor, beforeSnapshot: before, afterSnapshot: after,
      sourceMessageIds, operationId: audit.operationId ?? null, reasonCode: audit.reasonCode, createdAt: now()
    };
    await this.writeRecord("memoryRevision", revision);
    await this.pruneMemoryRevisions(memory.id);
    return { memory: clone(memory), revision: clone(revision), changed: true };
  }

  async tombstoneMemory(chatId, memoryId, audit = { actor: "user", action: "manual_delete", reasonCode: "user_deleted" }) {
    return this.atomicWrite(async () => {
      const existing = this.getMemory(chatId, memoryId);
      if (!existing) return null;
      return this.tombstoneMemoryInTransaction(existing, audit);
    });
  }

  async tombstoneMemoryInTransaction(existing, audit) {
    if (existing.deletedAt) return { memory: clone(existing), revision: null, changed: false };
    const before = this.memorySnapshot(existing);
    const revisionNumber = (existing.currentRevision ?? 0) + 1;
    const memory = { ...existing, enabled: false, deletedAt: now(), currentRevision: revisionNumber, lastActor: audit.actor, lastAction: audit.action, embedding: null, embeddingStatus: "stale", updatedAt: now() };
    await this.writeRecord("memory", memory);
    const revision = { id: randomUUID(), memoryId: memory.id, chatId: memory.chatId, revision: revisionNumber, action: audit.action, actor: audit.actor, beforeSnapshot: before, afterSnapshot: null, sourceMessageIds: before.sourceMessageIds, operationId: audit.operationId ?? null, reasonCode: audit.reasonCode, createdAt: now() };
    await this.writeRecord("memoryRevision", revision);
    await this.pruneMemoryRevisions(memory.id);
    return { memory: clone(memory), revision: clone(revision), changed: true };
  }

  listMemoryRevisions(chatId, memoryId) {
    const memory = this.getMemory(chatId, memoryId);
    if (!memory) return null;
    return clone(this.readRecords("memoryRevision").filter((item) => item.chatId === chatId && item.memoryId === memoryId).sort((a, b) => b.revision - a.revision).slice(0, 30).map((revision) => ({ ...revision, sources: this.sourceReferences(chatId, revision.sourceMessageIds), isCurrent: revision.revision === memory.currentRevision })));
  }

  previewMemoryRestore(chatId, memoryId, revisionNumber) {
    const memory = this.getMemory(chatId, memoryId);
    const revision = this.readRecords("memoryRevision").find((item) => item.memoryId === memoryId && item.revision === revisionNumber && item.chatId === chatId);
    if (!memory || !revision) return null;
    const restored = revision.afterSnapshot ?? revision.beforeSnapshot;
    if (!restored) return null;
    return { memoryId, revision: revisionNumber, expectedCurrentRevision: memory.currentRevision, current: memory.deletedAt ? null : this.memorySnapshot(memory), restored, sources: this.sourceReferences(chatId, restored.sourceMessageIds) };
  }

  async restoreMemory(chatId, memoryId, revisionNumber, expectedCurrentRevision) {
    return this.atomicWrite(async () => {
      const memory = this.getMemory(chatId, memoryId);
      if (!memory) return null;
      if (memory.currentRevision !== expectedCurrentRevision) { const error = new Error("Memory changed after the preview. Review the latest version before restoring."); error.status = 409; throw error; }
      const revision = this.readRecords("memoryRevision").find((item) => item.memoryId === memoryId && item.revision === revisionNumber && item.chatId === chatId);
      const restored = revision?.afterSnapshot ?? revision?.beforeSnapshot;
      if (!restored) return null;
      return this.updateAuditedMemoryInTransaction(memory, restored, { actor: "restore", action: "restore", reasonCode: "user_restored_revision", allowMissingSources: true });
    });
  }

  async purgeMemory(chatId, memoryId) {
    return this.atomicWrite(async () => {
      const memory = this.getMemory(chatId, memoryId);
      if (!memory?.deletedAt) return false;
      await this.deleteRecord("memory", memoryId);
      for (const revision of this.readRecords("memoryRevision").filter((item) => item.memoryId === memoryId)) await this.deleteRecord("memoryRevision", revision.id);
      return true;
    });
  }

  listMemoryOperations(chatId, limit = 20) {
    return clone(this.readRecords("memoryOperation", "AND chatId = ?", [chatId], "ORDER BY createdAt DESC").slice(0, Math.min(Math.max(limit, 1), 100)).map((operation) => ({ ...operation, sources: this.sourceReferences(chatId, operation.sourceMessageIds) })));
  }

  createMemoryOperation(input) {
    const operation = {
      id: input.id ?? randomUUID(), chatId: input.chatId, type: input.type ?? "automatic_maintenance",
      actor: input.actor ?? "automatic_memory", status: input.status ?? "running",
      startedAt: input.startedAt ?? now(), completedAt: input.completedAt ?? null,
      created: input.created ?? 0, updated: input.updated ?? 0, disabled: input.disabled ?? 0, unchanged: input.unchanged ?? 0,
      sourceMessageIds: input.sourceMessageIds ?? [], errorCode: input.errorCode ?? null,
      undoneAt: input.undoneAt ?? null, undoOperationId: input.undoOperationId ?? null,
      createdAt: input.startedAt ?? now(), updatedAt: now()
    };
    return this.writeRecord("memoryOperation", operation).then(() => clone(operation));
  }

  previewMemoryOperationUndo(chatId, operationId) {
    const operation = this.readRecord("memoryOperation", operationId);
    if (!operation || operation.chatId !== chatId) return null;
    if (operation.type !== "automatic_maintenance" || ["running", "failed"].includes(operation.status)) { const error = new Error("This operation cannot be undone."); error.status = 409; throw error; }
    if (operation.undoneAt || operation.undoOperationId) { const error = new Error("This operation was already undone."); error.status = 409; throw error; }
    const revisions = this.readRecords("memoryRevision").filter((item) => item.chatId === chatId && item.operationId === operationId).sort((a, b) => a.revision - b.revision);
    const items = revisions.map((revision) => {
      const memory = this.getMemory(chatId, revision.memoryId);
      if (!memory) { const error = new Error("An affected memory is no longer available."); error.status = 409; throw error; }
      return {
        memoryId: memory.id, operationRevision: revision.revision, currentRevision: memory.currentRevision,
        effect: revision.beforeSnapshot === null ? "retire_created" : revision.action === "automatic_disable" ? "restore_disabled" : "restore_updated",
        conflict: memory.currentRevision !== revision.revision,
        current: memory.deletedAt ? null : this.memorySnapshot(memory), restored: revision.beforeSnapshot
      };
    });
    return { operation: { ...operation, sources: this.sourceReferences(chatId, operation.sourceMessageIds) }, items, conflicts: items.filter((item) => item.conflict).length, canExecute: items.length > 0 };
  }

  async executeMemoryOperationUndo(chatId, operationId, resolutions) {
    return this.atomicWrite(async () => {
      const preview = this.previewMemoryOperationUndo(chatId, operationId);
      if (!preview) return null;
      const decisions = new Map((resolutions ?? []).map((item) => [item.memoryId, item]));
      const undo = await this.createMemoryOperation({ chatId, type: "operation_undo", actor: "restore", status: "running", sourceMessageIds: preview.operation.sourceMessageIds });
      let restored = 0;
      let retired = 0;
      let skippedConflicts = 0;
      for (const item of preview.items) {
        const memory = this.getMemory(chatId, item.memoryId);
        const decision = decisions.get(item.memoryId);
        if (decision && decision.expectedCurrentRevision !== memory.currentRevision) { const error = new Error("A memory changed after the undo preview. Review the operation again."); error.status = 409; throw error; }
        const conflict = memory.currentRevision !== item.operationRevision;
        if (conflict && decision?.action !== "restore") { skippedConflicts += 1; continue; }
        if (item.effect === "retire_created") {
          const result = await this.tombstoneMemoryInTransaction(memory, { actor: "restore", action: "undo_create", reasonCode: "automatic_operation_undo", operationId: undo.id });
          if (result.changed) retired += 1;
        } else {
          const result = await this.updateAuditedMemoryInTransaction(memory, item.restored, { actor: "restore", action: item.effect === "restore_disabled" ? "undo_disable" : "undo_update", reasonCode: "automatic_operation_undo", operationId: undo.id, allowMissingSources: true });
          if (result.changed) restored += 1;
        }
      }
      const completedAt = now();
      await this.writeRecord("memoryOperation", { ...undo, status: skippedConflicts ? "partial" : "succeeded", completedAt, updated: restored, disabled: retired, unchanged: skippedConflicts, updatedAt: completedAt });
      const { sources: _sources, ...originalOperation } = preview.operation;
      await this.writeRecord("memoryOperation", { ...originalOperation, undoneAt: completedAt, undoOperationId: undo.id, updatedAt: completedAt });
      await this.pruneMemoryOperations(chatId);
      return { operationId, undoOperationId: undo.id, restored, retired, skippedConflicts };
    });
  }

  async updateProfileSummary(chatId, summary, actor = "user", sourceIds = [], action) {
    return this.atomicWrite(async () => this.updateProfileSummaryInTransaction(chatId, summary, actor, sourceIds, action));
  }

  async updateProfileSummaryInTransaction(chatId, summary, actor = "user", sourceIds = [], action, allowMissingSources = false) {
    const chat = this.readRecord("chat", chatId);
    if (!chat) return null;
    if ((chat.userProfileSummary ?? "") === summary) return null;
    const sourceMessageIds = this.validateSourceMessageIds(chatId, sourceIds, allowMissingSources);
    const revision = (chat.profileRevision ?? 0) + 1;
    const resolvedAction = action ?? (actor === "automatic_memory" ? "automatic_update" : summary ? "manual_edit" : "manual_clear");
    const updatedChat = { ...chat, userProfileSummary: summary, userProfileUpdatedAt: summary ? now() : null, profileRevision: revision, updatedAt: now() };
    const history = { id: randomUUID(), chatId, revision, action: resolvedAction, actor, summary, sourceMessageIds, createdAt: now() };
    await this.writeRecord("chat", updatedChat);
    await this.writeRecord("profileSummaryRevision", history);
    const revisions = this.readRecords("profileSummaryRevision", "AND chatId = ?", [chatId], "ORDER BY createdAt DESC");
    for (const stale of revisions.slice(30)) await this.deleteRecord("profileSummaryRevision", stale.id);
    return { chat: clone(updatedChat), revision: clone(history) };
  }

  listProfileSummaryRevisions(chatId) {
    const chat = this.readRecord("chat", chatId);
    if (!chat) return null;
    return clone(this.readRecords("profileSummaryRevision", "AND chatId = ?", [chatId], "ORDER BY createdAt DESC").slice(0, 30).map((revision) => ({ ...revision, sources: this.sourceReferences(chatId, revision.sourceMessageIds), isCurrent: revision.revision === chat.profileRevision })));
  }

  listRawMemoryRevisions(chatId) {
    return clone(this.readRecords("memoryRevision").filter((revision) => revision.chatId === chatId).sort(compareAsc("createdAt")));
  }

  listRawMemoryOperations(chatId) {
    return clone(this.readRecords("memoryOperation", "AND chatId = ?", [chatId], "ORDER BY createdAt ASC"));
  }

  listRawProfileSummaryRevisions(chatId) {
    return clone(this.readRecords("profileSummaryRevision", "AND chatId = ?", [chatId], "ORDER BY createdAt ASC"));
  }

  previewProfileSummaryRestore(chatId, revisionNumber) {
    const chat = this.readRecord("chat", chatId);
    const revision = this.readRecords("profileSummaryRevision").find((item) => item.chatId === chatId && item.revision === revisionNumber);
    if (!chat || !revision) return null;
    return { chatId, revision: revisionNumber, expectedCurrentRevision: chat.profileRevision ?? 0, currentSummary: chat.userProfileSummary ?? "", restoredSummary: revision.summary, sources: this.sourceReferences(chatId, revision.sourceMessageIds) };
  }

  async restoreProfileSummary(chatId, revisionNumber, expectedCurrentRevision) {
    return this.atomicWrite(async () => {
      const chat = this.readRecord("chat", chatId);
      if (!chat) return null;
      if ((chat.profileRevision ?? 0) !== expectedCurrentRevision) { const error = new Error("Profile summary changed after the preview. Review the latest version before restoring."); error.status = 409; throw error; }
      const revision = this.readRecords("profileSummaryRevision").find((item) => item.chatId === chatId && item.revision === revisionNumber);
      if (!revision) return null;
      return this.updateProfileSummaryInTransaction(chatId, revision.summary, "restore", revision.sourceMessageIds, "restore", true);
    });
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

  getModelRequest(id) {
    return clone(this.readRecord("modelRequest", id));
  }

  async beginModelRequest(input) {
    return this.atomicWrite(async () => {
      const existing = this.readRecord("modelRequest", input.requestId);
      if (existing) return { created: false, request: clone(existing) };
      const timestamp = now();
      const request = {
        id: input.requestId,
        module: input.module,
        operation: input.operation,
        chatId: input.chatId ?? null,
        messageId: input.messageId ?? null,
        status: "queued",
        activeAttemptId: null,
        outputStarted: false,
        errorCode: null,
        errorSummary: null,
        diagnosticId: null,
        overrideHardBudget: input.overrideHardBudget === true,
        createdAt: timestamp,
        startedAt: null,
        completedAt: null,
        updatedAt: timestamp
      };
      await this.writeRecord("modelRequest", request);
      return { created: true, request: clone(request) };
    });
  }

  async updateModelRequest(id, updates) {
    const existing = this.readRecord("modelRequest", id);
    if (!existing) return null;
    const request = { ...existing, ...updates, updatedAt: now() };
    await this.writeRecord("modelRequest", request);
    await this.persist();
    return clone(request);
  }

  async reserveUsageAttempt(input) {
    return this.atomicWrite(async () => {
      const request = this.readRecord("modelRequest", input.requestId);
      if (!request) throw new Error("Model request not found");
      const budgets = input.settings?.usageBudgets ?? {};
      const timezone = input.settings?.usageTimezone || "UTC";
      const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
      const part = (type) => parts.find((entry) => entry.type === type)?.value ?? "";
      const reservationDay = `${part("year")}-${part("month")}-${part("day")}`;
      const reservationMonth = reservationDay.slice(0, 7);
      const pricing = input.pricing;
      const reservedCostMicros = pricing
        ? Math.ceil((input.promptTokens * pricing.inputMicrosPerMillion + input.maxOutputTokens * pricing.outputMicrosPerMillion) / 1_000_000)
        : null;
      const rows = this.readRecords("usageAttempt");
      const sum = (key, value) => rows
        .filter((row) => row[key] === value)
        .reduce((total, row) => total + (row.estimatedCostMicros ?? 0) + (row.reservedCostMicros ?? 0), 0);
      const blocked = !request.overrideHardBudget && (
        (reservedCostMicros === null && budgets.allowUnknownPricing === false) ||
        (reservedCostMicros !== null && Number.isSafeInteger(budgets.dailyHardMicros) && sum("reservationDay", reservationDay) + reservedCostMicros > budgets.dailyHardMicros) ||
        (reservedCostMicros !== null && Number.isSafeInteger(budgets.monthlyHardMicros) && sum("reservationMonth", reservationMonth) + reservedCostMicros > budgets.monthlyHardMicros)
      );
      const timestamp = now();
      const attempt = {
        id: input.id ?? `att_${randomUUID()}`,
        requestId: input.requestId,
        attemptNumber: input.attemptNumber,
        module: input.module,
        chatId: input.chatId ?? null,
        messageId: input.messageId ?? null,
        providerId: input.providerId,
        providerType: input.providerType,
        modelId: input.modelId,
        status: blocked ? "blocked" : "running",
        startedAt: timestamp,
        completedAt: blocked ? timestamp : null,
        promptTokens: null,
        outputTokens: null,
        totalTokens: null,
        usageSource: null,
        inputPriceMicros: pricing?.inputMicrosPerMillion ?? null,
        outputPriceMicros: pricing?.outputMicrosPerMillion ?? null,
        estimatedCostMicros: null,
        currency: pricing?.currency ?? null,
        specialTokensUnknown: input.specialTokensUnknown === true,
        usedFallback: input.usedFallback === true,
        fallbackFromProviderId: input.fallbackFromProviderId ?? null,
        fallbackFromModelId: input.fallbackFromModelId ?? null,
        errorCode: blocked ? "budget_blocked" : null,
        diagnosticId: blocked ? `mdl_${randomUUID().replaceAll("-", "").slice(0, 16)}` : null,
        reservedCostMicros: blocked ? 0 : reservedCostMicros ?? 0,
        reservationDay,
        reservationMonth,
        createdAt: timestamp
      };
      await this.writeRecord("usageAttempt", attempt);
      await this.writeRecord("modelRequest", {
        ...request,
        status: blocked ? "blocked" : "running",
        activeAttemptId: attempt.id,
        startedAt: request.startedAt ?? timestamp,
        completedAt: blocked ? timestamp : null,
        errorCode: blocked ? "budget_blocked" : null,
        errorSummary: blocked ? "The local hard budget prevented this model call." : null,
        diagnosticId: attempt.diagnosticId,
        updatedAt: timestamp
      });
      return clone(attempt);
    });
  }

  listUsageAttempts() {
    return clone(this.readRecords("usageAttempt", "", [], "ORDER BY createdAt DESC"));
  }

  async createUsageAttempt(input) {
    const attempt = { id: input.id ?? `att_${randomUUID()}`, createdAt: now(), ...input };
    await this.writeRecord("usageAttempt", attempt);
    await this.persist();
    return clone(attempt);
  }

  async updateUsageAttempt(id, updates) {
    return this.atomicWrite(async () => {
      const existing = this.readRecord("usageAttempt", id);
      if (!existing) return null;
      const attempt = { ...existing, ...updates, updatedAt: now() };
      await this.writeRecord("usageAttempt", attempt);
      return clone(attempt);
    });
  }

  async settleModelAttempt({ attemptId, requestId, attemptUpdates, requestUpdates }) {
    return this.atomicWrite(async () => {
      const existingAttempt = this.readRecord("usageAttempt", attemptId);
      const existingRequest = this.readRecord("modelRequest", requestId);
      if (!existingAttempt || !existingRequest) throw new Error("Model attempt settlement target not found");
      const timestamp = now();
      const attempt = { ...existingAttempt, ...attemptUpdates, updatedAt: timestamp };
      const request = { ...existingRequest, ...requestUpdates, updatedAt: timestamp };
      await this.writeRecord("usageAttempt", attempt);
      await this.writeRecord("modelRequest", request);
      return { attempt: clone(attempt), request: clone(request) };
    });
  }

  async recoverInterruptedModelCalls() {
    const requests = this.readRecords("modelRequest").filter((request) =>
      ["queued", "running", "streaming"].includes(request.status)
    );
    const attempts = this.readRecords("usageAttempt").filter((attempt) =>
      ["queued", "running", "streaming"].includes(attempt.status) || (attempt.reservedCostMicros ?? 0) > 0
    );
    if (!requests.length && !attempts.length) return { requests: 0, attempts: 0 };
    return this.atomicWrite(async () => {
      const timestamp = now();
      for (const attempt of attempts) {
        await this.writeRecord("usageAttempt", {
          ...attempt,
          status: "interrupted",
          completedAt: attempt.completedAt ?? timestamp,
          reservedCostMicros: 0,
          errorCode: attempt.errorCode ?? "stream_interrupted",
          updatedAt: timestamp
        });
      }
      for (const request of requests) {
        const diagnosticId = request.diagnosticId ?? `mdl_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
        await this.writeRecord("modelRequest", {
          ...request,
          status: "interrupted",
          completedAt: timestamp,
          errorCode: request.errorCode ?? "stream_interrupted",
          errorSummary: request.errorSummary ?? "The previous model request was interrupted when the local service stopped.",
          diagnosticId,
          updatedAt: timestamp
        });
      }
      return { requests: requests.length, attempts: attempts.length };
    });
  }

  async clearUsageHistory() {
    const attempts = this.readRecords("usageAttempt").length;
    const requests = this.readRecords("modelRequest").filter((request) => ["succeeded", "failed", "cancelled", "interrupted", "blocked"].includes(request.status)).length;
    this.db.run("DELETE FROM records WHERE type = 'usageAttempt'");
    for (const request of this.readRecords("modelRequest")) {
      if (["succeeded", "failed", "cancelled", "interrupted", "blocked"].includes(request.status)) await this.deleteRecord("modelRequest", request.id);
    }
    await this.persist();
    return { attempts, requests };
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
    const storedSnapshot = snapshot.media ? { ...snapshot, media: { ...snapshot.media, assets: snapshot.media.assets.map(({ dataBase64: _data, ...asset }) => asset) } } : snapshot;
    const point = {
      id: randomUUID(),
      reason,
      createdAt: now(),
      summary: {
        settings: snapshot.settings ? 1 : 0,
        characters: snapshot.characters.length,
        chats: snapshot.chats.length,
        messages: snapshot.messages.length,
        memories: snapshot.memories.length,
        memoryRevisions: snapshot.memoryRevisions.length,
        memoryOperations: snapshot.memoryOperations.length,
        profileSummaryRevisions: snapshot.profileSummaryRevisions.length
        ,mediaAssets: snapshot.media?.assets.length ?? 0
        ,messageAttachments: snapshot.media?.attachments.length ?? 0
      },
      snapshot: storedSnapshot
    };
    await this.writeRecord("recoveryPoint", point);
    for (const asset of snapshot.media?.assets ?? []) await this.writeRecord("recoveryPointMediaAsset", { id: `${point.id}:${asset.id}`, recoveryPointId: point.id, assetId: asset.id, createdAt: point.createdAt });
    const points = this.readRecords("recoveryPoint", "", [], "ORDER BY createdAt DESC");
    const cutoff = Date.now() - RECOVERY_POINT_MAX_AGE_MS;
    for (const [index, entry] of points.entries()) {
      if (index >= RECOVERY_POINT_LIMIT || Date.parse(entry.createdAt) < cutoff) {
        await this.deleteRecord("recoveryPoint", entry.id);
        for (const reference of this.readRecords("recoveryPointMediaAsset").filter((item) => item.recoveryPointId === entry.id)) await this.deleteRecord("recoveryPointMediaAsset", reference.id);
      }
    }
    await this.cleanupOrphanAssets();
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
      this.db.run("DELETE FROM records WHERE type IN ('character', 'chat', 'message', 'messageAttachment', 'memory', 'memoryRevision', 'memoryOperation', 'profileSummaryRevision')");
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

    const importedAssetIds = new Map();
    for (const asset of backup.media?.assets ?? []) {
      const existing = this.readRecords("mediaAsset").find((item) => item.contentHash === asset.contentHash);
      const idInUse = this.readRecord("mediaAsset", asset.id);
      const stored = existing ?? { ...asset, id: idInUse ? randomUUID() : asset.id, storageKey: `sha256:${asset.contentHash}` };
      if (!existing) await this.writeRecord("mediaAsset", stored);
      importedAssetIds.set(asset.id, stored.id);
    }
    if (backup.media) {
      const appliedMessageIds = new Set(records.messages.filter((record) => this.shouldApplyBackupRecord(record, backup.mode, resolutions)).flatMap((record) => record.value.id ? [record.value.id] : []));
      for (const messageId of appliedMessageIds) for (const attachment of this.listMessageAttachments(messageId)) await this.deleteRecord("messageAttachment", attachment.id);
      for (const attachment of backup.media.attachments) {
        if (!appliedMessageIds.has(attachment.messageId)) continue;
        const assetId = importedAssetIds.get(attachment.assetId);
        if (!assetId) throw new Error("An image attachment refers to unavailable image data.");
        const idInUse = this.readRecord("messageAttachment", attachment.id);
        await this.writeRecord("messageAttachment", { ...attachment, id: idInUse ? randomUUID() : attachment.id, assetId, draftId: null });
      }
    }

    for (const [entity, type] of [["memoryRevisions", "memoryRevision"], ["memoryOperations", "memoryOperation"], ["profileSummaryRevisions", "profileSummaryRevision"]]) {
      for (const record of records[entity]) {
        if (!this.shouldApplyBackupRecord(record, backup.mode, resolutions)) continue;
        const value = { ...record.value, id: record.value.id ?? randomUUID(), createdAt: record.value.createdAt ?? record.value.startedAt ?? now(), updatedAt: now() };
        await this.writeRecord(type, value);
      }
    }

    // Conflict decisions are per record. Re-align current pointers after applying
    // them so an imported current state can never reference skipped/mismatched history.
    for (const record of records.memories) {
      if (!this.shouldApplyBackupRecord(record, backup.mode, resolutions) || !record.value.id) continue;
      const memory = this.readRecord("memory", record.value.id);
      if (!memory) continue;
      const snapshot = this.memorySnapshot(memory);
      const revisions = this.readRecords("memoryRevision")
        .filter((revision) => revision.memoryId === memory.id)
        .sort((a, b) => b.revision - a.revision);
      const latestRevision = revisions[0]?.revision ?? 0;
      const matching = revisions.find((revision) => revision.revision === latestRevision && (memory.deletedAt
        ? revision.afterSnapshot === null
        : JSON.stringify(revision.afterSnapshot) === JSON.stringify(snapshot)));
      if (matching) {
        if (memory.currentRevision !== matching.revision) {
          await this.writeRecord("memory", { ...memory, currentRevision: matching.revision });
        }
        continue;
      }
      const revision = latestRevision + 1;
      await this.writeRecord("memory", { ...memory, currentRevision: revision, lastActor: "restore", lastAction: "baseline" });
      await this.writeRecord("memoryRevision", {
        id: randomUUID(), memoryId: memory.id, chatId: memory.chatId, revision,
        action: "baseline", actor: "restore", beforeSnapshot: memory.deletedAt ? snapshot : null, afterSnapshot: memory.deletedAt ? null : snapshot,
        sourceMessageIds: snapshot.sourceMessageIds, operationId: null,
        reasonCode: "import_current_state_baseline", createdAt: memory.updatedAt ?? now()
      });
    }
    for (const record of records.chats) {
      if (!this.shouldApplyBackupRecord(record, backup.mode, resolutions) || !record.value.id) continue;
      const chat = this.readRecord("chat", record.value.id);
      if (!chat) continue;
      const revisions = this.readRecords("profileSummaryRevision")
        .filter((revision) => revision.chatId === chat.id)
        .sort((a, b) => b.revision - a.revision);
      const latestRevision = revisions[0]?.revision ?? 0;
      const matching = revisions.find((revision) => revision.revision === latestRevision && revision.summary === (chat.userProfileSummary ?? ""));
      if (matching) {
        if (chat.profileRevision !== matching.revision) {
          await this.writeRecord("chat", { ...chat, profileRevision: matching.revision });
        }
        continue;
      }
      if (!(chat.userProfileSummary ?? "") && revisions.length === 0) {
        if ((chat.profileRevision ?? 0) !== 0) await this.writeRecord("chat", { ...chat, profileRevision: 0 });
        continue;
      }
      const revision = latestRevision + 1;
      await this.writeRecord("chat", { ...chat, profileRevision: revision });
      await this.writeRecord("profileSummaryRevision", {
        id: randomUUID(), chatId: chat.id, revision, action: "baseline", actor: "restore",
        summary: chat.userProfileSummary ?? "", sourceMessageIds: [],
        createdAt: chat.userProfileUpdatedAt ?? chat.updatedAt ?? now()
      });
    }
    const historyMemoryIds = new Set(backup.memoryRevisions.map((item) => item.memoryId));
    for (const record of records.memories) {
      if (!this.shouldApplyBackupRecord(record, backup.mode, resolutions) || !record.value.id || historyMemoryIds.has(record.value.id)) continue;
      const memory = this.readRecord("memory", record.value.id);
      if (!memory || (memory.currentRevision ?? 0) > 0) continue;
      const baseline = { ...memory, currentRevision: 1, lastActor: "restore", lastAction: "baseline", deletedAt: memory.deletedAt ?? null };
      await this.writeRecord("memory", baseline);
      await this.writeRecord("memoryRevision", { id: `baseline:${memory.id}`, memoryId: memory.id, chatId: memory.chatId, revision: 1, action: "baseline", actor: "restore", beforeSnapshot: null, afterSnapshot: this.memorySnapshot(baseline), sourceMessageIds: baseline.sourceMessageIds ?? [], operationId: null, reasonCode: "legacy_backup_baseline", createdAt: baseline.createdAt ?? now() });
    }
    const profileChatIds = new Set(backup.profileSummaryRevisions.map((item) => item.chatId));
    for (const record of records.chats) {
      if (!this.shouldApplyBackupRecord(record, backup.mode, resolutions) || !record.value.id || profileChatIds.has(record.value.id) || !record.value.userProfileSummary) continue;
      const chat = this.readRecord("chat", record.value.id);
      if (!chat || (chat.profileRevision ?? 0) > 0) continue;
      await this.writeRecord("chat", { ...chat, profileRevision: 1 });
      await this.writeRecord("profileSummaryRevision", { id: `baseline:${chat.id}`, chatId: chat.id, revision: 1, action: "baseline", actor: "restore", summary: chat.userProfileSummary, sourceMessageIds: [], createdAt: chat.userProfileUpdatedAt ?? chat.createdAt ?? now() });
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
      ...records.memories,
      ...records.memoryRevisions,
      ...records.memoryOperations,
      ...records.profileSummaryRevisions
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
    await this.cleanupOrphanAssets();
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
      const rawMedia = point.snapshot.media;
      const assets = this.readRecords("recoveryPointMediaAsset").filter((item) => item.recoveryPointId === id).map((item) => this.getMediaAsset(item.assetId)).filter(Boolean).map(({ storageKey: _storageKey, ...asset }) => asset);
      const analysis = analyzeBackupCandidate({ ...point.snapshot, ...(rawMedia ? { media: { ...rawMedia, assets } } : {}), mode: "replace" }, current);
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
    const withoutInternalUpdatedAt = ({ updatedAt: _updatedAt, ...record }) => record;
    const memories = this.readRecords("memory", "", [], "ORDER BY updatedAt DESC").map(
      ({ embedding: _embedding, ...memory }) => memory
    );
    const attachments = this.readRecords("messageAttachment").filter((item) => item.messageId).sort((a, b) => `${a.messageId}:${a.sortOrder}`.localeCompare(`${b.messageId}:${b.sortOrder}`)).map((item) => ({ id: item.id, messageId: item.messageId, assetId: item.assetId, sortOrder: item.sortOrder, originalFilename: item.originalFilename ?? null, createdAt: item.createdAt }));
    const assetIds = new Set(attachments.map((item) => item.assetId));
    const assets = this.readRecords("mediaAsset").filter((item) => assetIds.has(item.id)).sort((a, b) => a.id.localeCompare(b.id)).map((asset) => ({ id: asset.id, contentHash: asset.contentHash, mimeType: asset.mimeType, byteSize: asset.byteSize, width: asset.width, height: asset.height, dataBase64: asset.dataBase64, createdAt: asset.createdAt }));
    const manifestAssets = assets.map(({ dataBase64: _data, ...asset }) => asset);
    const manifestHash = createHash("sha256").update(JSON.stringify({ assets: manifestAssets, attachments })).digest("hex");
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
      memories: clone(memories),
      memoryRevisions: clone(this.readRecords("memoryRevision", "", [], "ORDER BY createdAt ASC").map(withoutInternalUpdatedAt)),
      memoryOperations: clone(this.readRecords("memoryOperation", "", [], "ORDER BY createdAt ASC").map(withoutInternalUpdatedAt)),
      profileSummaryRevisions: clone(this.readRecords("profileSummaryRevision", "", [], "ORDER BY createdAt ASC").map(withoutInternalUpdatedAt)),
      ...(assets.length ? { media: { version: 1, manifestHash, assets: clone(assets), attachments: clone(attachments) } } : {})
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
