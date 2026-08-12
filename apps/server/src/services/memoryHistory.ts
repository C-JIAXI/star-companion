import { Prisma, type Chat, type ChatMemory, type MemoryOperation, type MemoryRevision, type ProfileSummaryRevision } from "@prisma/client";
import { prisma } from "../db.js";
import { HttpError } from "../lib/http.js";
import { serializeChatMemory } from "../serializers.js";

export const MEMORY_REVISION_LIMIT = 30;
export const MEMORY_OPERATION_LIMIT = 100;

export type MemoryActor = "user" | "automatic_memory" | "agent_confirmed" | "timeline_cleanup" | "restore";
export type MemoryAction =
  | "baseline"
  | "automatic_create"
  | "automatic_update"
  | "automatic_disable"
  | "manual_create"
  | "manual_edit"
  | "manual_enable"
  | "manual_disable"
  | "manual_delete"
  | "agent_confirmed_create"
  | "timeline_disable"
  | "restore"
  | "undo_create"
  | "undo_update"
  | "undo_disable";

export type MemorySnapshot = {
  title: string;
  content: string;
  keywords: string[];
  importance: number;
  enabled: boolean;
  sourceMessageIds: string[];
};

type MemoryInput = Partial<MemorySnapshot> & Pick<MemorySnapshot, "title" | "content">;

const toStringArray = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const uniqueIds = (ids: string[]) => [...new Set(ids)];

export const snapshotMemory = (memory: Pick<ChatMemory, "title" | "content" | "keywords" | "importance" | "enabled" | "sourceMessageIds">): MemorySnapshot => ({
  title: memory.title,
  content: memory.content,
  keywords: toStringArray(memory.keywords),
  importance: memory.importance,
  enabled: memory.enabled,
  sourceMessageIds: toStringArray(memory.sourceMessageIds)
});

export const parseMemorySnapshot = (value: Prisma.JsonValue | null): MemorySnapshot | null => {
  if (!value || Array.isArray(value) || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (
    typeof item.title !== "string" ||
    typeof item.content !== "string" ||
    typeof item.importance !== "number" ||
    typeof item.enabled !== "boolean"
  ) return null;
  return {
    title: item.title,
    content: item.content,
    keywords: toStringArray(item.keywords),
    importance: item.importance,
    enabled: item.enabled,
    sourceMessageIds: toStringArray(item.sourceMessageIds)
  };
};

const sameSnapshot = (left: MemorySnapshot | null, right: MemorySnapshot | null) =>
  JSON.stringify(left) === JSON.stringify(right);

export const validateSourceMessageIds = async (
  tx: Prisma.TransactionClient,
  chatId: string,
  ids: string[],
  allowMissing = false
) => {
  const sourceMessageIds = uniqueIds(ids);
  if (!sourceMessageIds.length) return sourceMessageIds;
  const messages = await tx.message.findMany({
    where: { id: { in: sourceMessageIds } },
    select: { id: true, chatId: true }
  });
  if (messages.some((message) => message.chatId !== chatId)) {
    throw new HttpError(400, "A source message belongs to another chat.");
  }
  if (!allowMissing && messages.length !== sourceMessageIds.length) {
    throw new HttpError(400, "One or more source messages are unavailable.");
  }
  return sourceMessageIds;
};

const sourceReferences = async (chatId: string, ids: string[], tx: Prisma.TransactionClient | typeof prisma = prisma) => {
  const sourceMessageIds = uniqueIds(ids);
  if (!sourceMessageIds.length) return [];
  const messages = await tx.message.findMany({
    where: { id: { in: sourceMessageIds }, chatId },
    select: { id: true }
  });
  const available = new Set(messages.map((message) => message.id));
  return sourceMessageIds.map((messageId) => ({ messageId, available: available.has(messageId) }));
};

const pruneMemoryRevisions = async (tx: Prisma.TransactionClient, memoryId: string) => {
  const stale = await tx.memoryRevision.findMany({
    where: { memoryId },
    orderBy: { revision: "desc" },
    skip: MEMORY_REVISION_LIMIT,
    select: { id: true }
  });
  if (stale.length) await tx.memoryRevision.deleteMany({ where: { id: { in: stale.map((item) => item.id) } } });
};

export const pruneMemoryOperations = async (tx: Prisma.TransactionClient, chatId: string) => {
  const stale = await tx.memoryOperation.findMany({
    where: { chatId },
    orderBy: { startedAt: "desc" },
    skip: MEMORY_OPERATION_LIMIT,
    select: { id: true }
  });
  if (stale.length) await tx.memoryOperation.deleteMany({ where: { id: { in: stale.map((item) => item.id) } } });
};

const appendRevision = async (
  tx: Prisma.TransactionClient,
  input: {
    memoryId: string;
    chatId: string;
    revision: number;
    action: MemoryAction;
    actor: MemoryActor;
    before: MemorySnapshot | null;
    after: MemorySnapshot | null;
    sourceMessageIds: string[];
    operationId?: string | null;
    reasonCode: string;
  }
) => {
  const revision = await tx.memoryRevision.create({
    data: {
      memoryId: input.memoryId,
      chatId: input.chatId,
      revision: input.revision,
      action: input.action,
      actor: input.actor,
      beforeSnapshot: input.before === null ? Prisma.JsonNull : input.before,
      afterSnapshot: input.after === null ? Prisma.JsonNull : input.after,
      sourceMessageIds: input.sourceMessageIds,
      operationId: input.operationId ?? null,
      reasonCode: input.reasonCode
    }
  });
  await pruneMemoryRevisions(tx, input.memoryId);
  return revision;
};

export const createMemoryInTransaction = async (
  tx: Prisma.TransactionClient,
  input: MemoryInput & { chatId: string },
  audit: { actor: MemoryActor; action: MemoryAction; reasonCode: string; operationId?: string | null }
) => {
  const sourceMessageIds = await validateSourceMessageIds(tx, input.chatId, input.sourceMessageIds ?? []);
  const memory = await tx.chatMemory.create({
    data: {
      chatId: input.chatId,
      title: input.title,
      content: input.content,
      keywords: input.keywords ?? [],
      importance: input.importance ?? 3,
      enabled: input.enabled ?? true,
      sourceMessageIds,
      currentRevision: 1,
      lastActor: audit.actor,
      lastAction: audit.action
    }
  });
  const revision = await appendRevision(tx, {
    memoryId: memory.id,
    chatId: memory.chatId,
    revision: 1,
    action: audit.action,
    actor: audit.actor,
    before: null,
    after: snapshotMemory(memory),
    sourceMessageIds,
    operationId: audit.operationId,
    reasonCode: audit.reasonCode
  });
  return { memory, revision };
};

export const updateMemoryInTransaction = async (
  tx: Prisma.TransactionClient,
  existing: ChatMemory,
  updates: Partial<MemorySnapshot>,
  audit: { actor: MemoryActor; action: MemoryAction; reasonCode: string; operationId?: string | null; allowMissingSources?: boolean }
) => {
  const before = snapshotMemory(existing);
  const requestedSources = updates.sourceMessageIds ?? before.sourceMessageIds;
  const sourceMessageIds = await validateSourceMessageIds(tx, existing.chatId, requestedSources, audit.allowMissingSources ?? false);
  const after: MemorySnapshot = {
    title: updates.title ?? before.title,
    content: updates.content ?? before.content,
    keywords: updates.keywords ?? before.keywords,
    importance: updates.importance ?? before.importance,
    enabled: updates.enabled ?? before.enabled,
    sourceMessageIds
  };
  if (sameSnapshot(before, after) && existing.deletedAt === null) return { memory: existing, revision: null, changed: false };
  const embeddingSourceChanged = audit.action === "restore" || before.title !== after.title || before.content !== after.content || !sameSnapshot({ ...before, title: "", content: "", importance: 0, enabled: false, sourceMessageIds: [] }, { ...after, title: "", content: "", importance: 0, enabled: false, sourceMessageIds: [] });
  const nextRevision = existing.currentRevision + 1;
  const memory = await tx.chatMemory.update({
    where: { id: existing.id },
    data: {
      ...after,
      deletedAt: null,
      currentRevision: nextRevision,
      lastActor: audit.actor,
      lastAction: audit.action,
      ...(embeddingSourceChanged
        ? { embedding: Prisma.JsonNull, embeddingSource: null, embeddingDimensions: null, embeddingStatus: "stale", embeddingUpdatedAt: null }
        : {})
    }
  });
  const revision = await appendRevision(tx, {
    memoryId: memory.id,
    chatId: memory.chatId,
    revision: nextRevision,
    action: audit.action,
    actor: audit.actor,
    before,
    after,
    sourceMessageIds,
    operationId: audit.operationId,
    reasonCode: audit.reasonCode
  });
  return { memory, revision, changed: true };
};

export const tombstoneMemoryInTransaction = async (
  tx: Prisma.TransactionClient,
  existing: ChatMemory,
  audit: { actor: MemoryActor; action: MemoryAction; reasonCode: string; operationId?: string | null }
) => {
  if (existing.deletedAt) return { memory: existing, revision: null, changed: false };
  const before = snapshotMemory(existing);
  const nextRevision = existing.currentRevision + 1;
  const memory = await tx.chatMemory.update({
    where: { id: existing.id },
    data: {
      deletedAt: new Date(),
      enabled: false,
      currentRevision: nextRevision,
      lastActor: audit.actor,
      lastAction: audit.action,
      embedding: Prisma.JsonNull,
      embeddingSource: null,
      embeddingDimensions: null,
      embeddingStatus: "stale",
      embeddingUpdatedAt: null
    }
  });
  const revision = await appendRevision(tx, {
    memoryId: memory.id,
    chatId: memory.chatId,
    revision: nextRevision,
    action: audit.action,
    actor: audit.actor,
    before,
    after: null,
    sourceMessageIds: before.sourceMessageIds,
    operationId: audit.operationId,
    reasonCode: audit.reasonCode
  });
  return { memory, revision, changed: true };
};

const serializeRevision = async (revision: MemoryRevision, currentRevision: number, tx: Prisma.TransactionClient | typeof prisma = prisma) => {
  const sourceMessageIds = toStringArray(revision.sourceMessageIds);
  return {
    id: revision.id,
    memoryId: revision.memoryId,
    chatId: revision.chatId,
    revision: revision.revision,
    action: revision.action,
    actor: revision.actor,
    beforeSnapshot: parseMemorySnapshot(revision.beforeSnapshot),
    afterSnapshot: parseMemorySnapshot(revision.afterSnapshot),
    sourceMessageIds,
    sources: await sourceReferences(revision.chatId, sourceMessageIds, tx),
    operationId: revision.operationId,
    reasonCode: revision.reasonCode,
    isCurrent: revision.revision === currentRevision,
    createdAt: revision.createdAt.toISOString()
  };
};

const serializeOperation = async (operation: MemoryOperation, tx: Prisma.TransactionClient | typeof prisma = prisma) => {
  const sourceMessageIds = toStringArray(operation.sourceMessageIds);
  return {
    id: operation.id,
    chatId: operation.chatId,
    type: operation.type,
    actor: operation.actor,
    status: operation.status,
    startedAt: operation.startedAt.toISOString(),
    completedAt: operation.completedAt?.toISOString() ?? null,
    created: operation.createdCount,
    updated: operation.updatedCount,
    disabled: operation.disabledCount,
    unchanged: operation.unchangedCount,
    sourceMessageIds,
    sources: await sourceReferences(operation.chatId, sourceMessageIds, tx),
    errorCode: operation.errorCode,
    undoneAt: operation.undoneAt?.toISOString() ?? null,
    undoOperationId: operation.undoOperationId
  };
};

export const createManualMemory = (chatId: string, input: MemoryInput, actor: "user" | "agent_confirmed" = "user") =>
  prisma.$transaction(async (tx) => {
    const chat = await tx.chat.findFirst({ where: { id: chatId, deletedAt: null }, select: { id: true } });
    if (!chat) throw new HttpError(404, "Chat not found");
    return createMemoryInTransaction(tx, { ...input, chatId }, {
      actor,
      action: actor === "agent_confirmed" ? "agent_confirmed_create" : "manual_create",
      reasonCode: actor === "agent_confirmed" ? "agent_candidate_confirmed" : "user_created"
    });
  });

export const updateManualMemory = (chatId: string, memoryId: string, updates: Partial<MemorySnapshot>) =>
  prisma.$transaction(async (tx) => {
    const existing = await tx.chatMemory.findFirst({ where: { id: memoryId, chatId, chat: { deletedAt: null }, deletedAt: null } });
    if (!existing) throw new HttpError(404, "Memory not found");
    const action: MemoryAction = typeof updates.enabled === "boolean" && updates.enabled !== existing.enabled
      ? updates.enabled ? "manual_enable" : "manual_disable"
      : "manual_edit";
    return updateMemoryInTransaction(tx, existing, updates, { actor: "user", action, reasonCode: `user_${action}` });
  });

export const deleteManualMemory = (chatId: string, memoryId: string) =>
  prisma.$transaction(async (tx) => {
    const existing = await tx.chatMemory.findFirst({ where: { id: memoryId, chatId, chat: { deletedAt: null } } });
    if (!existing) throw new HttpError(404, "Memory not found");
    return tombstoneMemoryInTransaction(tx, existing, { actor: "user", action: "manual_delete", reasonCode: "user_deleted" });
  });

export const listMemoryRevisions = async (chatId: string, memoryId: string, limit = MEMORY_REVISION_LIMIT) => {
  const memory = await prisma.chatMemory.findFirst({ where: { id: memoryId, chatId }, select: { currentRevision: true } });
  if (!memory) throw new HttpError(404, "Memory not found");
  const revisions = await prisma.memoryRevision.findMany({ where: { memoryId, chatId }, orderBy: { revision: "desc" }, take: Math.min(limit, MEMORY_REVISION_LIMIT) });
  return Promise.all(revisions.map((revision) => serializeRevision(revision, memory.currentRevision)));
};

export const previewMemoryRestore = async (chatId: string, memoryId: string, revisionNumber: number) => {
  const [memory, revision] = await Promise.all([
    prisma.chatMemory.findFirst({ where: { id: memoryId, chatId } }),
    prisma.memoryRevision.findUnique({ where: { memoryId_revision: { memoryId, revision: revisionNumber } } })
  ]);
  if (!memory || !revision || revision.chatId !== chatId) throw new HttpError(404, "Memory revision not found");
  const restored = parseMemorySnapshot(revision.afterSnapshot) ?? parseMemorySnapshot(revision.beforeSnapshot);
  if (!restored) throw new HttpError(400, "This revision cannot be restored.");
  return {
    memoryId,
    revision: revisionNumber,
    expectedCurrentRevision: memory.currentRevision,
    current: memory.deletedAt ? null : snapshotMemory(memory),
    restored,
    sources: await sourceReferences(chatId, restored.sourceMessageIds)
  };
};

export const restoreMemoryRevision = (chatId: string, memoryId: string, revisionNumber: number, expectedCurrentRevision: number) =>
  prisma.$transaction(async (tx) => {
    const memory = await tx.chatMemory.findFirst({ where: { id: memoryId, chatId } });
    if (!memory) throw new HttpError(404, "Memory not found");
    if (memory.currentRevision !== expectedCurrentRevision) throw new HttpError(409, "Memory changed after the preview. Review the latest version before restoring.");
    const selected = await tx.memoryRevision.findUnique({ where: { memoryId_revision: { memoryId, revision: revisionNumber } } });
    if (!selected || selected.chatId !== chatId) throw new HttpError(404, "Memory revision not found");
    const restored = parseMemorySnapshot(selected.afterSnapshot) ?? parseMemorySnapshot(selected.beforeSnapshot);
    if (!restored) throw new HttpError(400, "This revision cannot be restored.");
    const result = await updateMemoryInTransaction(tx, memory, restored, { actor: "restore", action: "restore", reasonCode: "user_restored_revision", allowMissingSources: true });
    if (!result.revision) throw new HttpError(409, "The selected revision already matches the current memory.");
    return { memory: serializeChatMemory(result.memory), revision: await serializeRevision(result.revision, result.memory.currentRevision, tx) };
  });

export const purgeMemoryHistory = (chatId: string, memoryId: string) =>
  prisma.$transaction(async (tx) => {
    const memory = await tx.chatMemory.findFirst({ where: { id: memoryId, chatId, deletedAt: { not: null } }, select: { id: true } });
    if (!memory) throw new HttpError(409, "Only a deleted memory can be permanently purged.");
    await tx.chatMemory.delete({ where: { id: memoryId } });
    return { purged: true };
  });

export const listMemoryOperations = async (chatId: string, limit = 20) => {
  const operations = await prisma.memoryOperation.findMany({ where: { chatId }, orderBy: { startedAt: "desc" }, take: Math.min(Math.max(limit, 1), 100) });
  return Promise.all(operations.map((operation) => serializeOperation(operation)));
};

const buildUndoPreviewInTransaction = async (tx: Prisma.TransactionClient, chatId: string, operationId: string) => {
  const operation = await tx.memoryOperation.findFirst({ where: { id: operationId, chatId } });
  if (!operation) throw new HttpError(404, "Memory operation not found");
  if (operation.type !== "automatic_maintenance" || operation.status === "running" || operation.status === "failed") throw new HttpError(409, "This operation cannot be undone.");
  if (operation.undoneAt || operation.undoOperationId) throw new HttpError(409, "This operation was already undone.");
  const revisions = await tx.memoryRevision.findMany({ where: { chatId, operationId }, orderBy: { revision: "asc" } });
  const memoryIds = uniqueIds(revisions.map((revision) => revision.memoryId));
  const memories = await tx.chatMemory.findMany({ where: { id: { in: memoryIds }, chatId } });
  const memoryById = new Map(memories.map((memory) => [memory.id, memory]));
  const items = revisions.map((revision) => {
    const memory = memoryById.get(revision.memoryId);
    if (!memory) throw new HttpError(409, "An affected memory is no longer available.");
    const before = parseMemorySnapshot(revision.beforeSnapshot);
    const isCreate = before === null;
    return {
      memoryId: memory.id,
      operationRevision: revision.revision,
      currentRevision: memory.currentRevision,
      effect: isCreate ? "retire_created" : revision.action === "automatic_disable" ? "restore_disabled" : "restore_updated",
      conflict: memory.currentRevision !== revision.revision,
      current: memory.deletedAt ? null : snapshotMemory(memory),
      restored: before
    };
  });
  return { operation, items, conflicts: items.filter((item) => item.conflict).length };
};

export const previewMemoryOperationUndo = () => prisma.$transaction(async (tx) => {
  const operation = await tx.memoryOperation.findFirst({
    where: { type: "automatic_maintenance", status: { in: ["succeeded", "partial"] }, undoneAt: null },
    orderBy: { completedAt: "desc" }
  });
  if (!operation) throw new HttpError(404, "No completed memory maintenance operation is available to undo.");
  const preview = await buildUndoPreviewInTransaction(tx, operation.chatId, operation.id);
  return { operation: await serializeOperation(preview.operation, tx), items: preview.items, conflicts: preview.conflicts, canExecute: preview.items.length > 0 };
});

export const previewSpecificMemoryOperationUndo = (chatId: string, operationId: string) => prisma.$transaction(async (tx) => {
  const preview = await buildUndoPreviewInTransaction(tx, chatId, operationId);
  return { operation: await serializeOperation(preview.operation, tx), items: preview.items, conflicts: preview.conflicts, canExecute: preview.items.length > 0 };
});

export const executeMemoryOperationUndo = (
  chatId: string,
  operationId: string,
  resolutions: Array<{ memoryId: string; expectedCurrentRevision: number; action: "skip" | "restore" }>
) => prisma.$transaction(async (tx) => {
  const preview = await buildUndoPreviewInTransaction(tx, chatId, operationId);
  const decisions = new Map(resolutions.map((item) => [item.memoryId, item]));
  const undoOperation = await tx.memoryOperation.create({ data: { chatId, type: "operation_undo", actor: "restore", status: "running", sourceMessageIds: toStringArray(preview.operation.sourceMessageIds) } });
  let restored = 0;
  let retired = 0;
  let skippedConflicts = 0;
  for (const item of preview.items) {
    const current = await tx.chatMemory.findUniqueOrThrow({ where: { id: item.memoryId } });
    const decision = decisions.get(item.memoryId);
    if (decision && decision.expectedCurrentRevision !== current.currentRevision) {
      throw new HttpError(409, "A memory changed after the undo preview. Review the operation again.");
    }
    const conflict = current.currentRevision !== item.operationRevision;
    if (conflict && decision?.action !== "restore") {
      skippedConflicts += 1;
      continue;
    }
    if (item.effect === "retire_created") {
      const result = await tombstoneMemoryInTransaction(tx, current, { actor: "restore", action: "undo_create", reasonCode: "automatic_operation_undo", operationId: undoOperation.id });
      if (result.changed) retired += 1;
      continue;
    }
    if (!item.restored) throw new HttpError(409, "An operation snapshot is incomplete.");
    const result = await updateMemoryInTransaction(tx, current, item.restored, {
      actor: "restore",
      action: item.effect === "restore_disabled" ? "undo_disable" : "undo_update",
      reasonCode: "automatic_operation_undo",
      operationId: undoOperation.id,
      allowMissingSources: true
    });
    if (result.changed) restored += 1;
  }
  const completedAt = new Date();
  await tx.memoryOperation.update({
    where: { id: undoOperation.id },
    data: { status: skippedConflicts ? "partial" : "succeeded", completedAt, updatedCount: restored, disabledCount: retired, unchangedCount: skippedConflicts }
  });
  await tx.memoryOperation.update({ where: { id: operationId }, data: { undoneAt: completedAt, undoOperationId: undoOperation.id } });
  await pruneMemoryOperations(tx, chatId);
  return { operationId, undoOperationId: undoOperation.id, restored, retired, skippedConflicts };
});

const serializeProfileRevision = async (revision: ProfileSummaryRevision, currentRevision: number, tx: Prisma.TransactionClient | typeof prisma = prisma) => {
  const sourceMessageIds = toStringArray(revision.sourceMessageIds);
  return {
    id: revision.id,
    chatId: revision.chatId,
    revision: revision.revision,
    action: revision.action,
    actor: revision.actor,
    summary: revision.summary,
    sourceMessageIds,
    sources: await sourceReferences(revision.chatId, sourceMessageIds, tx),
    isCurrent: revision.revision === currentRevision,
    createdAt: revision.createdAt.toISOString()
  };
};

const pruneProfileRevisions = async (tx: Prisma.TransactionClient, chatId: string) => {
  const stale = await tx.profileSummaryRevision.findMany({ where: { chatId }, orderBy: { revision: "desc" }, skip: MEMORY_REVISION_LIMIT, select: { id: true } });
  if (stale.length) await tx.profileSummaryRevision.deleteMany({ where: { id: { in: stale.map((item) => item.id) } } });
};

export const updateProfileSummaryInTransaction = async (
  tx: Prisma.TransactionClient,
  chat: Pick<Chat, "id" | "userProfileSummary" | "profileRevision">,
  summary: string,
  actor: "user" | "automatic_memory" | "restore",
  sourceIds: string[],
  action?: "automatic_update" | "manual_edit" | "manual_clear" | "restore",
  allowMissingSources = false
) => {
  if (chat.userProfileSummary === summary) return null;
  const sourceMessageIds = await validateSourceMessageIds(tx, chat.id, sourceIds, allowMissingSources);
  const revisionNumber = chat.profileRevision + 1;
  const resolvedAction = action ?? (actor === "automatic_memory" ? "automatic_update" : summary ? "manual_edit" : "manual_clear");
  const updated = await tx.chat.update({ where: { id: chat.id }, data: { userProfileSummary: summary, userProfileUpdatedAt: summary ? new Date() : null, profileRevision: revisionNumber } });
  const revision = await tx.profileSummaryRevision.create({ data: { chatId: chat.id, revision: revisionNumber, action: resolvedAction, actor, summary, sourceMessageIds } });
  await pruneProfileRevisions(tx, chat.id);
  return { chat: updated, revision };
};

export const updateManualProfileSummary = (chatId: string, summary: string) => prisma.$transaction(async (tx) => {
  const chat = await tx.chat.findFirst({ where: { id: chatId, deletedAt: null } });
  if (!chat) throw new HttpError(404, "Chat not found");
  return updateProfileSummaryInTransaction(tx, chat, summary, "user", []);
});

export const listProfileSummaryRevisions = async (chatId: string, limit = MEMORY_REVISION_LIMIT) => {
  const chat = await prisma.chat.findFirst({ where: { id: chatId, deletedAt: null }, select: { profileRevision: true } });
  if (!chat) throw new HttpError(404, "Chat not found");
  const revisions = await prisma.profileSummaryRevision.findMany({ where: { chatId }, orderBy: { revision: "desc" }, take: Math.min(limit, MEMORY_REVISION_LIMIT) });
  return Promise.all(revisions.map((revision) => serializeProfileRevision(revision, chat.profileRevision)));
};

export const previewProfileSummaryRestore = async (chatId: string, revisionNumber: number) => {
  const [chat, revision] = await Promise.all([
    prisma.chat.findFirst({ where: { id: chatId, deletedAt: null } }),
    prisma.profileSummaryRevision.findUnique({ where: { chatId_revision: { chatId, revision: revisionNumber } } })
  ]);
  if (!chat || !revision) throw new HttpError(404, "Profile summary revision not found");
  const sourceMessageIds = toStringArray(revision.sourceMessageIds);
  return { chatId, revision: revisionNumber, expectedCurrentRevision: chat.profileRevision, currentSummary: chat.userProfileSummary, restoredSummary: revision.summary, sources: await sourceReferences(chatId, sourceMessageIds) };
};

export const restoreProfileSummaryRevision = (chatId: string, revisionNumber: number, expectedCurrentRevision: number) => prisma.$transaction(async (tx) => {
  const chat = await tx.chat.findFirst({ where: { id: chatId, deletedAt: null } });
  if (!chat) throw new HttpError(404, "Chat not found");
  if (chat.profileRevision !== expectedCurrentRevision) throw new HttpError(409, "Profile summary changed after the preview. Review the latest version before restoring.");
  const selected = await tx.profileSummaryRevision.findUnique({ where: { chatId_revision: { chatId, revision: revisionNumber } } });
  if (!selected) throw new HttpError(404, "Profile summary revision not found");
  const result = await updateProfileSummaryInTransaction(tx, chat, selected.summary, "restore", toStringArray(selected.sourceMessageIds), "restore", true);
  if (!result) throw new HttpError(409, "The selected revision already matches the current profile summary.");
  return { chat: result.chat, revision: await serializeProfileRevision(result.revision, result.chat.profileRevision, tx) };
});
