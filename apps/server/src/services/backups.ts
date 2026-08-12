import { Prisma, type UserSettings } from "@prisma/client";
import { createHash } from "node:crypto";
import type { z } from "zod";
import { prisma } from "../db.js";
import { HttpError } from "../lib/http.js";
import type { backupExecuteSchema, backupPreviewRequestSchema } from "../schemas.js";
import { backupImportSchema } from "../schemas.js";
import {
  serializeCharacterForBackup,
  serializeChat,
  serializeChatMemory,
  serializeMemoryOperationForBackup,
  serializeMemoryRevisionForBackup,
  serializeMessage,
  serializeProfileSummaryRevisionForBackup,
  serializeSettings
} from "../serializers.js";
import {
  analyzeBackupCandidate,
  type BackupAnalysis,
  type BackupConflictAction,
  type BackupMode,
  type ParsedBackup
} from "./backupContract.js";
import { deleteUnreferencedAssets } from "./messageAttachments.js";

type BackupPreviewInput = z.infer<typeof backupPreviewRequestSchema>;
type BackupExecuteInput = z.infer<typeof backupExecuteSchema>;
type DbClient = Prisma.TransactionClient | typeof prisma;
type ExportedBackup = {
  schemaVersion: 1;
  exportedAt: string;
  settings: unknown;
  characters: unknown[];
  chats: unknown[];
  messages: unknown[];
  memories: unknown[];
  memoryRevisions: unknown[];
  memoryOperations: unknown[];
  profileSummaryRevisions: unknown[];
  media?: unknown;
};

const RECOVERY_POINT_LIMIT = 10;
const RECOVERY_POINT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const importedDates = (value: { createdAt?: string; updatedAt?: string }) => ({
  ...(value.createdAt ? { createdAt: new Date(value.createdAt) } : {}),
  ...(value.updatedAt ? { updatedAt: new Date(value.updatedAt) } : {})
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stableJson = (value: unknown) => JSON.stringify(value);

const memorySnapshotForImport = (memory: {
  title: string;
  content: string;
  keywords: Prisma.JsonValue;
  importance: number;
  enabled: boolean;
  sourceMessageIds: Prisma.JsonValue;
}) => ({
  title: memory.title,
  content: memory.content,
  keywords: Array.isArray(memory.keywords) ? memory.keywords : [],
  importance: memory.importance,
  enabled: memory.enabled,
  sourceMessageIds: Array.isArray(memory.sourceMessageIds) ? memory.sourceMessageIds : []
});

const getProviderKeys = (settings: UserSettings | null) => {
  const keys = new Map<string, unknown>();
  if (!settings || !Array.isArray(settings.providers)) return keys;
  for (const provider of settings.providers) {
    if (isRecord(provider) && typeof provider.id === "string" && typeof provider.key === "string") {
      keys.set(provider.id, provider.key);
    }
  }
  return keys;
};

const preserveProviderKeys = (incoming: unknown, existing: UserSettings | null) => {
  if (!Array.isArray(incoming)) return incoming;
  const keys = getProviderKeys(existing);
  return incoming.map((provider) => {
    if (!isRecord(provider) || typeof provider.id !== "string") return provider;
    const key = keys.get(provider.id);
    return key ? { ...provider, key } : provider;
  });
};

const readExportedBackup = async (client: DbClient): Promise<ExportedBackup> => {
  const [settings, characters, chats, messages, memories, memoryRevisions, memoryOperations, profileSummaryRevisions, assets, attachments] = await Promise.all([
    client.userSettings.findFirst({ orderBy: { createdAt: "asc" } }),
    client.character.findMany({ orderBy: { updatedAt: "desc" } }),
    client.chat.findMany({ orderBy: { updatedAt: "desc" } }),
    client.message.findMany({ orderBy: { createdAt: "asc" } }),
    client.chatMemory.findMany({ orderBy: { updatedAt: "desc" } }),
    client.memoryRevision.findMany({ orderBy: { createdAt: "asc" } }),
    client.memoryOperation.findMany({ orderBy: { startedAt: "asc" } }),
    client.profileSummaryRevision.findMany({ orderBy: { createdAt: "asc" } }),
    client.mediaAsset.findMany({ where: { attachments: { some: { messageId: { not: null } } } }, orderBy: { id: "asc" } }),
    client.messageAttachment.findMany({ where: { messageId: { not: null } }, orderBy: [{ messageId: "asc" }, { sortOrder: "asc" }] })
  ]);

  const mediaAssets = assets.map((asset) => ({ id: asset.id, contentHash: asset.contentHash, mimeType: asset.mimeType, byteSize: asset.byteSize, width: asset.width, height: asset.height, dataBase64: Buffer.from(asset.data).toString("base64"), createdAt: asset.createdAt.toISOString() }));
  const mediaAttachments = attachments.map((attachment) => ({ id: attachment.id, messageId: attachment.messageId!, assetId: attachment.assetId, sortOrder: attachment.sortOrder, originalFilename: attachment.originalFilename, createdAt: attachment.createdAt.toISOString() }));
  const manifestHash = createHash("sha256").update(JSON.stringify({ assets: mediaAssets.map(({ dataBase64: _data, ...asset }) => asset), attachments: mediaAttachments })).digest("hex");

  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    settings: settings ? serializeSettings(settings) : null,
    characters: characters.map(serializeCharacterForBackup),
    chats: chats.map((chat) => serializeChat(chat)),
    messages: messages.map(serializeMessage),
    memories: memories.map(serializeChatMemory),
    memoryRevisions: memoryRevisions.map(serializeMemoryRevisionForBackup),
    memoryOperations: memoryOperations.map(serializeMemoryOperationForBackup),
    profileSummaryRevisions: profileSummaryRevisions.map(serializeProfileSummaryRevisionForBackup),
    ...(mediaAssets.length ? { media: { version: 1 as const, manifestHash, assets: mediaAssets, attachments: mediaAttachments } } : {})
  } as const;
};

const readBackup = async (client: DbClient): Promise<ParsedBackup> =>
  backupImportSchema.parse({ ...(await readExportedBackup(client)), mode: "merge" });

export const exportBackup = async (): Promise<ExportedBackup> => readExportedBackup(prisma);

const recoverySummary = (backup: ParsedBackup) => ({
  settings: backup.settings ? 1 : 0,
  characters: backup.characters.length,
  chats: backup.chats.length,
  messages: backup.messages.length,
  memories: backup.memories.length,
  memoryRevisions: backup.memoryRevisions.length,
  memoryOperations: backup.memoryOperations.length,
  profileSummaryRevisions: backup.profileSummaryRevisions.length
  ,mediaAssets: backup.media?.assets.length ?? 0
  ,messageAttachments: backup.media?.attachments.length ?? 0
});

const pruneRecoveryPoints = async (tx: Prisma.TransactionClient) => {
  const points = await tx.recoveryPoint.findMany({
    select: { id: true, createdAt: true },
    orderBy: { createdAt: "desc" }
  });
  const cutoff = Date.now() - RECOVERY_POINT_MAX_AGE_MS;
  const ids = points
    .filter((point, index) => index >= RECOVERY_POINT_LIMIT || point.createdAt.getTime() < cutoff)
    .map((point) => point.id);
  if (ids.length) {
    await tx.recoveryPoint.deleteMany({ where: { id: { in: ids } } });
    await deleteUnreferencedAssets(tx);
  }
};

const createRecoveryPoint = async (
  tx: Prisma.TransactionClient,
  reason: "before_import" | "before_restore"
) => {
  const snapshot = await readBackup(tx);
  const storedSnapshot = snapshot.media ? {
    ...snapshot,
    media: { ...snapshot.media, assets: snapshot.media.assets.map(({ dataBase64: _data, ...asset }) => asset) }
  } : snapshot;
  const point = await tx.recoveryPoint.create({
    data: {
      reason,
      summary: recoverySummary(snapshot) as Prisma.InputJsonValue,
      snapshot: storedSnapshot as Prisma.InputJsonValue
    }
  });
  if (snapshot.media?.assets.length) await tx.recoveryPointMediaAsset.createMany({ data: snapshot.media.assets.map((asset) => ({ recoveryPointId: point.id, assetId: asset.id })) });
  await pruneRecoveryPoints(tx);
  return point;
};

export const listRecoveryPoints = async () => {
  const points = await prisma.recoveryPoint.findMany({
    select: { id: true, reason: true, summary: true, createdAt: true },
    orderBy: { createdAt: "desc" }
  });
  return points.map((point) => ({
    id: point.id,
    reason: point.reason === "before_restore" ? "before_restore" : "before_import",
    createdAt: point.createdAt.toISOString(),
    summary: point.summary
  }));
};

export const previewBackup = async (input: BackupPreviewInput) => {
  const current = await readBackup(prisma);
  return analyzeBackupCandidate(input as BackupPreviewInput & { mode: BackupMode }, current).preview;
};

const resolutionMap = (input: BackupExecuteInput) =>
  new Map<string, BackupConflictAction>(
    input.conflictResolutions.map((resolution) => [resolution.key, resolution.action])
  );

const shouldApplyRecord = (
  record: { status: string; key: string | null },
  mode: BackupMode,
  resolutions: Map<string, BackupConflictAction>
) => {
  if (record.status === "invalid") return false;
  if (mode === "replace") return true;
  if (record.status === "skipped") return false;
  if (record.status === "added") return true;
  return Boolean(record.key && resolutions.get(record.key) === "use_incoming");
};

const assertExecutable = (
  analysis: BackupAnalysis,
  input: BackupExecuteInput,
  resolutions: Map<string, BackupConflictAction>
) => {
  if (analysis.preview.previewId !== input.previewId) {
    throw new HttpError(409, "Data changed after the preview. Run the preview again before importing.");
  }
  if (!analysis.preview.canExecute) {
    throw new HttpError(400, "The backup cannot be imported until its validation issues are fixed.", {
      issues: analysis.preview.issues
    });
  }
  if (analysis.preview.mode === "merge") {
    const unresolved = analysis.preview.conflicts.filter((conflict) => !resolutions.has(conflict.key));
    if (unresolved.length) {
      throw new HttpError(409, "Choose an action for every conflict before importing.", {
        conflicts: unresolved
      });
    }
  }
};

const applyBackup = async (
  tx: Prisma.TransactionClient,
  analysis: BackupAnalysis,
  resolutions: Map<string, BackupConflictAction>
) => {
  const { backup, records } = analysis;
  if (backup.mode === "replace") {
    await tx.messageAttachment.deleteMany();
    await tx.chatMemory.deleteMany();
    await tx.message.deleteMany();
    await tx.chat.deleteMany();
    await tx.character.deleteMany();
  }

  const importedAssetIds = new Map<string, string>();
  if (backup.media) for (const asset of backup.media.assets) {
    const bytes = Buffer.from(asset.dataBase64, "base64");
    const existing = await tx.mediaAsset.findUnique({ where: { contentHash: asset.contentHash } });
    if (existing) importedAssetIds.set(asset.id, existing.id);
    else {
      const idInUse = await tx.mediaAsset.findUnique({ where: { id: asset.id }, select: { id: true } });
      const created = await tx.mediaAsset.create({ data: { ...(!idInUse ? { id: asset.id } : {}), contentHash: asset.contentHash, mimeType: asset.mimeType, byteSize: asset.byteSize, width: asset.width, height: asset.height, storageKey: `sha256:${asset.contentHash}`, data: new Uint8Array(bytes), ...(asset.createdAt ? { createdAt: new Date(asset.createdAt) } : {}) } });
      importedAssetIds.set(asset.id, created.id);
    }
  }

  const existingSettings = await tx.userSettings.findFirst({ orderBy: { createdAt: "asc" } });
  let settingsImported = false;
  if (records.settings && shouldApplyRecord(records.settings, backup.mode, resolutions)) {
    const settingsData = {
      ...records.settings.value,
      ...(records.settings.value.providers
        ? { providers: preserveProviderKeys(records.settings.value.providers, existingSettings) }
        : {})
    };
    if (existingSettings) {
      await tx.userSettings.update({
        where: { id: existingSettings.id },
        data: settingsData as Prisma.UserSettingsUpdateInput
      });
    } else {
      await tx.userSettings.create({ data: settingsData as Prisma.UserSettingsCreateInput });
    }
    settingsImported = true;
  }

  for (const record of records.characters) {
    if (!shouldApplyRecord(record, backup.mode, resolutions)) continue;
    const character = record.value;
    const data = {
      cardId: character.cardId,
      name: character.name,
      avatar: character.avatar ?? null,
      description: character.description,
      tags: character.tags,
      prefix: character.prefix,
      prompt: character.prompt,
      suffix: character.suffix,
      htmlCss: character.htmlCss ?? "",
      openingHtml: character.openingHtml ?? "",
      loreEntries: character.loreEntries ?? [],
      quickReplies: character.quickReplies ?? [],
      isFavorite: character.isFavorite,
      ...importedDates(character)
    };
    if (character.id) {
      await tx.character.upsert({ where: { id: character.id }, update: data, create: { id: character.id, ...data } });
    } else {
      await tx.character.create({ data });
    }
  }

  for (const record of records.chats) {
    if (!shouldApplyRecord(record, backup.mode, resolutions)) continue;
    const chat = record.value;
    const data = {
      title: chat.title,
      characterId: chat.characterId ?? null,
      parentChatId: chat.parentChatId ?? null,
      branchSourceMessageId: chat.branchSourceMessageId ?? null,
      isCheckpoint: chat.isCheckpoint,
      isPinned: chat.isPinned,
      isArchived: chat.isArchived,
      folder: chat.folder,
      deletedAt: chat.deletedAt ? new Date(chat.deletedAt) : null,
      backgroundUrl: chat.backgroundUrl,
      memoryTurns: chat.memoryTurns,
      autoMemoryEnabled: chat.autoMemoryEnabled,
      memoryUpdatedAt: chat.memoryUpdatedAt ? new Date(chat.memoryUpdatedAt) : null,
      userPersona: chat.userPersona,
      userAvatar: chat.userAvatar,
      userProfileSummary: chat.userProfileSummary,
      userProfileUpdatedAt: chat.userProfileUpdatedAt ? new Date(chat.userProfileUpdatedAt) : null,
      profileRevision: chat.profileRevision,
      ...importedDates(chat)
    };
    if (chat.id) {
      await tx.chat.upsert({ where: { id: chat.id }, update: data, create: { id: chat.id, ...data } });
    } else {
      await tx.chat.create({ data });
    }
  }

  for (const record of records.messages) {
    if (!shouldApplyRecord(record, backup.mode, resolutions)) continue;
    const message = record.value;
    const data = {
      chatId: message.chatId,
      role: message.role,
      characterId: message.characterId ?? null,
      content: message.content,
      contextIncluded: message.contextIncluded,
      isBookmarked: message.isBookmarked,
      variants: message.variants,
      activeVariantIndex: message.activeVariantIndex,
      tokenUsage: message.tokenUsage ?? undefined,
      generationMetadata: message.generationMetadata ?? undefined,
      variantMetadata: message.variantMetadata,
      promptBreakdown: message.promptBreakdown ?? undefined,
      loreMatches: message.loreMatches ?? undefined,
      memoryMatches: message.memoryMatches ?? undefined,
      ...importedDates(message)
    };
    if (message.id) {
      await tx.message.upsert({ where: { id: message.id }, update: data, create: { id: message.id, ...data } });
    } else {
      await tx.message.create({ data });
    }
  }

  if (backup.media) {
    const appliedMessageIds = new Set(records.messages.filter((record) => shouldApplyRecord(record, backup.mode, resolutions)).flatMap((record) => record.value.id ? [record.value.id] : []));
    for (const messageId of appliedMessageIds) await tx.messageAttachment.deleteMany({ where: { messageId } });
    for (const attachment of backup.media.attachments) {
      if (!appliedMessageIds.has(attachment.messageId)) continue;
      const assetId = importedAssetIds.get(attachment.assetId);
      if (!assetId) throw new HttpError(400, "An image attachment refers to unavailable image data.");
      const idInUse = await tx.messageAttachment.findUnique({ where: { id: attachment.id }, select: { id: true } });
      await tx.messageAttachment.create({ data: { ...(!idInUse ? { id: attachment.id } : {}), messageId: attachment.messageId, assetId, sortOrder: attachment.sortOrder, originalFilename: attachment.originalFilename, ...(attachment.createdAt ? { createdAt: new Date(attachment.createdAt) } : {}) } });
    }
  }

  for (const record of records.memories) {
    if (!shouldApplyRecord(record, backup.mode, resolutions)) continue;
    const memory = record.value;
    const data = {
      chatId: memory.chatId,
      title: memory.title,
      content: memory.content,
      keywords: memory.keywords,
      importance: memory.importance,
      enabled: memory.enabled,
      deletedAt: memory.deletedAt ? new Date(memory.deletedAt) : null,
      currentRevision: memory.currentRevision,
      lastActor: memory.lastActor,
      lastAction: memory.lastAction,
      sourceMessageIds: memory.sourceMessageIds,
      embedding: Prisma.DbNull,
      embeddingModel: null,
      embeddingSource: null,
      embeddingDimensions: null,
      embeddingStatus: "stale",
      embeddingUpdatedAt: null,
      lastMatchedAt: memory.lastMatchedAt ? new Date(memory.lastMatchedAt) : null,
      ...importedDates(memory)
    };
    if (memory.id) {
      await tx.chatMemory.upsert({ where: { id: memory.id }, update: data, create: { id: memory.id, ...data } });
    } else {
      await tx.chatMemory.create({ data });
    }
  }

  for (const record of records.memoryOperations) {
    if (!shouldApplyRecord(record, backup.mode, resolutions)) continue;
    const operation = record.value;
    await tx.memoryOperation.upsert({ where: { id: operation.id }, update: {
      chatId: operation.chatId, type: operation.type, actor: operation.actor, status: operation.status,
      startedAt: new Date(operation.startedAt), completedAt: operation.completedAt ? new Date(operation.completedAt) : null,
      createdCount: operation.created, updatedCount: operation.updated, disabledCount: operation.disabled, unchangedCount: operation.unchanged,
      sourceMessageIds: operation.sourceMessageIds, errorCode: operation.errorCode,
      undoneAt: operation.undoneAt ? new Date(operation.undoneAt) : null, undoOperationId: operation.undoOperationId
    }, create: {
      id: operation.id, chatId: operation.chatId, type: operation.type, actor: operation.actor, status: operation.status,
      startedAt: new Date(operation.startedAt), completedAt: operation.completedAt ? new Date(operation.completedAt) : null,
      createdCount: operation.created, updatedCount: operation.updated, disabledCount: operation.disabled, unchangedCount: operation.unchanged,
      sourceMessageIds: operation.sourceMessageIds, errorCode: operation.errorCode,
      undoneAt: operation.undoneAt ? new Date(operation.undoneAt) : null, undoOperationId: operation.undoOperationId
    } });
  }

  for (const record of records.memoryRevisions) {
    if (!shouldApplyRecord(record, backup.mode, resolutions)) continue;
    const revision = record.value;
    const data = {
      chatId: revision.chatId, action: revision.action, actor: revision.actor,
      beforeSnapshot: revision.beforeSnapshot === null ? Prisma.JsonNull : revision.beforeSnapshot,
      afterSnapshot: revision.afterSnapshot === null ? Prisma.JsonNull : revision.afterSnapshot,
      sourceMessageIds: revision.sourceMessageIds, operationId: revision.operationId,
      reasonCode: revision.reasonCode, createdAt: new Date(revision.createdAt)
    };
    await tx.memoryRevision.upsert({
      where: { memoryId_revision: { memoryId: revision.memoryId, revision: revision.revision } },
      update: data,
      create: { id: revision.id, memoryId: revision.memoryId, revision: revision.revision, ...data }
    });
  }

  for (const record of records.profileSummaryRevisions) {
    if (!shouldApplyRecord(record, backup.mode, resolutions)) continue;
    const revision = record.value;
    const data = { action: revision.action, actor: revision.actor, summary: revision.summary, sourceMessageIds: revision.sourceMessageIds, createdAt: new Date(revision.createdAt) };
    await tx.profileSummaryRevision.upsert({
      where: { chatId_revision: { chatId: revision.chatId, revision: revision.revision } },
      update: data,
      create: { id: revision.id, chatId: revision.chatId, revision: revision.revision, ...data }
    });
  }
  await deleteUnreferencedAssets(tx);

  // Conflict choices are independent records in the preview. Re-align imported
  // current-state pointers so choosing a memory/chat without its matching history
  // can never leave a dangling or misleading revision pointer.
  for (const record of records.memories) {
    if (!shouldApplyRecord(record, backup.mode, resolutions) || !record.value.id) continue;
    const memory = await tx.chatMemory.findUniqueOrThrow({ where: { id: record.value.id } });
    const snapshot = memorySnapshotForImport(memory);
    const revisions = await tx.memoryRevision.findMany({
      where: { memoryId: memory.id },
      orderBy: { revision: "desc" },
      select: { revision: true, afterSnapshot: true }
    });
    const latestRevision = revisions[0]?.revision ?? 0;
    const matching = revisions.find((revision) => revision.revision === latestRevision && (memory.deletedAt
      ? revision.afterSnapshot === null
      : stableJson(revision.afterSnapshot) === stableJson(snapshot)));
    if (matching) {
      if (memory.currentRevision !== matching.revision) {
        await tx.chatMemory.update({ where: { id: memory.id }, data: { currentRevision: matching.revision } });
      }
      continue;
    }
    const nextRevision = latestRevision + 1;
    await tx.chatMemory.update({
      where: { id: memory.id },
      data: { currentRevision: nextRevision, lastActor: "restore", lastAction: "baseline" }
    });
    await tx.memoryRevision.create({
      data: {
        memoryId: memory.id,
        chatId: memory.chatId,
        revision: nextRevision,
        action: "baseline",
        actor: "restore",
        beforeSnapshot: memory.deletedAt ? snapshot as Prisma.InputJsonValue : Prisma.JsonNull,
        afterSnapshot: memory.deletedAt ? Prisma.JsonNull : snapshot as Prisma.InputJsonValue,
        sourceMessageIds: snapshot.sourceMessageIds as Prisma.InputJsonValue,
        reasonCode: "import_current_state_baseline",
        createdAt: memory.updatedAt
      }
    });
  }

  for (const record of records.chats) {
    if (!shouldApplyRecord(record, backup.mode, resolutions) || !record.value.id) continue;
    const chat = await tx.chat.findUniqueOrThrow({ where: { id: record.value.id } });
    const revisions = await tx.profileSummaryRevision.findMany({
      where: { chatId: chat.id },
      orderBy: { revision: "desc" },
      select: { revision: true, summary: true }
    });
    const latestRevision = revisions[0]?.revision ?? 0;
    const matching = revisions.find((revision) => revision.revision === latestRevision && revision.summary === chat.userProfileSummary);
    if (matching) {
      if (chat.profileRevision !== matching.revision) {
        await tx.chat.update({ where: { id: chat.id }, data: { profileRevision: matching.revision } });
      }
      continue;
    }
    if (!chat.userProfileSummary && revisions.length === 0) {
      if (chat.profileRevision !== 0) await tx.chat.update({ where: { id: chat.id }, data: { profileRevision: 0 } });
      continue;
    }
    const nextRevision = latestRevision + 1;
    await tx.chat.update({ where: { id: chat.id }, data: { profileRevision: nextRevision } });
    await tx.profileSummaryRevision.create({ data: {
      chatId: chat.id,
      revision: nextRevision,
      action: "baseline",
      actor: "restore",
      summary: chat.userProfileSummary,
      sourceMessageIds: [],
      createdAt: chat.userProfileUpdatedAt ?? chat.updatedAt
    } });
  }

  const importedHistoryMemoryIds = new Set(backup.memoryRevisions.map((revision) => revision.memoryId));
  for (const record of records.memories) {
    if (!shouldApplyRecord(record, backup.mode, resolutions) || !record.value.id || importedHistoryMemoryIds.has(record.value.id)) continue;
    const memory = await tx.chatMemory.findUniqueOrThrow({ where: { id: record.value.id } });
    if (memory.currentRevision > 0) continue;
    const snapshot = { title: memory.title, content: memory.content, keywords: Array.isArray(memory.keywords) ? memory.keywords : [], importance: memory.importance, enabled: memory.enabled, sourceMessageIds: Array.isArray(memory.sourceMessageIds) ? memory.sourceMessageIds : [] };
    await tx.chatMemory.update({ where: { id: memory.id }, data: { currentRevision: 1, lastActor: "restore", lastAction: "baseline" } });
    await tx.memoryRevision.create({ data: { id: `baseline:${memory.id}`, memoryId: memory.id, chatId: memory.chatId, revision: 1, action: "baseline", actor: "restore", beforeSnapshot: Prisma.JsonNull, afterSnapshot: snapshot as Prisma.InputJsonValue, sourceMessageIds: snapshot.sourceMessageIds as Prisma.InputJsonValue, reasonCode: "legacy_backup_baseline", createdAt: memory.createdAt } });
  }

  const importedProfileChatIds = new Set(backup.profileSummaryRevisions.map((revision) => revision.chatId));
  for (const record of records.chats) {
    if (!shouldApplyRecord(record, backup.mode, resolutions) || !record.value.id || importedProfileChatIds.has(record.value.id) || !record.value.userProfileSummary) continue;
    const chat = await tx.chat.findUniqueOrThrow({ where: { id: record.value.id } });
    if (chat.profileRevision > 0) continue;
    await tx.chat.update({ where: { id: chat.id }, data: { profileRevision: 1 } });
    await tx.profileSummaryRevision.create({ data: { id: `baseline:${chat.id}`, chatId: chat.id, revision: 1, action: "baseline", actor: "restore", summary: chat.userProfileSummary, sourceMessageIds: [], createdAt: chat.userProfileUpdatedAt ?? chat.createdAt } });
  }

  let added = 0;
  let updated = 0;
  let skipped = 0;
  let conflictsResolved = 0;
  for (const record of [
    ...(records.settings ? [records.settings] : []),
    ...records.characters,
    ...records.chats,
    ...records.messages,
    ...records.memories,
    ...records.memoryRevisions,
    ...records.memoryOperations,
    ...records.profileSummaryRevisions
  ]) {
    if (record.status === "added") added += 1;
    else if (record.status === "skipped") skipped += 1;
    else if (record.status === "conflict") {
      const action = backup.mode === "replace" ? "use_incoming" : record.key ? resolutions.get(record.key) : undefined;
      if (action === "use_incoming") {
        updated += 1;
        conflictsResolved += 1;
      } else {
        skipped += 1;
      }
    }
  }

  return {
    mode: backup.mode,
    characters: records.characters.filter((record) => shouldApplyRecord(record, backup.mode, resolutions)).length,
    chats: records.chats.filter((record) => shouldApplyRecord(record, backup.mode, resolutions)).length,
    messages: records.messages.filter((record) => shouldApplyRecord(record, backup.mode, resolutions)).length,
    memories: records.memories.filter((record) => shouldApplyRecord(record, backup.mode, resolutions)).length,
    settingsImported,
    added,
    updated,
    skipped,
    conflictsResolved
  };
};

export const importBackup = async (input: BackupExecuteInput) =>
  prisma.$transaction(async (tx) => {
    const current = await readBackup(tx);
    const analysis = analyzeBackupCandidate(input as BackupExecuteInput & { mode: BackupMode }, current);
    const resolutions = resolutionMap(input);
    assertExecutable(analysis, input, resolutions);

    const recoveryPoint = analysis.preview.requiresRecoveryPoint
      ? await createRecoveryPoint(tx, "before_import")
      : null;
    const applied = await applyBackup(tx, analysis, resolutions);
    return {
      ...applied,
      recoveryPointId: recoveryPoint?.id ?? null,
      completedAt: new Date().toISOString()
    };
  });

export const restoreRecoveryPoint = async (id: string) =>
  prisma.$transaction(async (tx) => {
    const point = await tx.recoveryPoint.findUnique({ where: { id }, include: { mediaAssets: { include: { asset: true } } } });
    if (!point) throw new HttpError(404, "Recovery point not found.");

    const rawSnapshot = point.snapshot as Record<string, unknown>;
    const rawMedia = rawSnapshot.media && typeof rawSnapshot.media === "object" && !Array.isArray(rawSnapshot.media) ? rawSnapshot.media as Record<string, unknown> : null;
    const assets = point.mediaAssets.map(({ asset }) => ({ id: asset.id, contentHash: asset.contentHash, mimeType: asset.mimeType, byteSize: asset.byteSize, width: asset.width, height: asset.height, dataBase64: Buffer.from(asset.data).toString("base64"), createdAt: asset.createdAt.toISOString() }));
    const snapshot = backupImportSchema.safeParse({ ...rawSnapshot, ...(rawMedia ? { media: { ...rawMedia, assets } } : {}), mode: "replace" });
    if (!snapshot.success) {
      throw new HttpError(400, "This recovery point is damaged and cannot be restored.");
    }

    const current = await readBackup(tx);
    const safetyPoint = await createRecoveryPoint(tx, "before_restore");
    const analysis = analyzeBackupCandidate(snapshot.data, current);
    if (!analysis.preview.canExecute) {
      throw new HttpError(400, "This recovery point failed integrity validation and was not restored.");
    }
    const applied = await applyBackup(tx, analysis, new Map());
    return {
      recoveryPointId: id,
      safetyRecoveryPointId: safetyPoint.id,
      completedAt: new Date().toISOString(),
      summary: {
        ...applied,
        recoveryPointId: safetyPoint.id,
        completedAt: new Date().toISOString()
      }
    };
  });
