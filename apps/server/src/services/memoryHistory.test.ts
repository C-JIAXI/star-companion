import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { prisma } from "../db.js";
import {
  createManualMemory,
  createMemoryInTransaction,
  deleteManualMemory,
  executeMemoryOperationUndo,
  listMemoryRevisions,
  listProfileSummaryRevisions,
  previewMemoryRestore,
  previewSpecificMemoryOperationUndo,
  restoreMemoryRevision,
  restoreProfileSummaryRevision,
  updateManualMemory,
  updateManualProfileSummary,
  updateMemoryInTransaction,
  pruneMemoryOperations
} from "./memoryHistory.js";

const chatIds: string[] = [];

const createChat = async (title: string) => {
  const chat = await prisma.chat.create({ data: { title } });
  chatIds.push(chat.id);
  return chat;
};

after(async () => {
  if (chatIds.length) await prisma.chat.deleteMany({ where: { id: { in: chatIds } } });
  await prisma.$disconnect();
});

describe("memory immutable history", () => {
  it("records manual create, edit, disable, enable, and tombstone revisions without embeddings", async () => {
    const chat = await createChat("manual history");
    const message = await prisma.message.create({ data: { chatId: chat.id, role: "user", content: "private fixture", variants: [] } });
    const created = await createManualMemory(chat.id, {
      title: "Initial",
      content: "Durable fact",
      keywords: ["fact"],
      importance: 3,
      enabled: true,
      sourceMessageIds: [message.id]
    });
    await updateManualMemory(chat.id, created.memory.id, { title: "Edited" });
    await updateManualMemory(chat.id, created.memory.id, { enabled: false });
    await updateManualMemory(chat.id, created.memory.id, { enabled: true });
    await deleteManualMemory(chat.id, created.memory.id);

    const memory = await prisma.chatMemory.findUniqueOrThrow({ where: { id: created.memory.id } });
    assert.ok(memory.deletedAt);
    assert.equal(memory.enabled, false);
    assert.equal(memory.currentRevision, 5);
    const revisions = await listMemoryRevisions(chat.id, memory.id);
    assert.deepEqual(revisions.map((item) => item.action).reverse(), [
      "manual_create",
      "manual_edit",
      "manual_disable",
      "manual_enable",
      "manual_delete"
    ]);
    assert.equal(revisions[0].afterSnapshot, null);
    assert.equal(revisions[0].sources[0]?.available, true);
    assert.doesNotMatch(JSON.stringify(revisions), /embedding|private fixture/);
  });

  it("rejects cross-chat source IDs and never creates a partial memory or revision", async () => {
    const chat = await createChat("source owner");
    const other = await createChat("foreign source");
    const message = await prisma.message.create({ data: { chatId: other.id, role: "user", content: "foreign fixture", variants: [] } });
    const before = await prisma.chatMemory.count({ where: { chatId: chat.id } });
    await assert.rejects(
      createManualMemory(chat.id, { title: "Invalid", content: "Should not exist", sourceMessageIds: [message.id] }),
      /another chat/
    );
    assert.equal(await prisma.chatMemory.count({ where: { chatId: chat.id } }), before);
    assert.equal(await prisma.memoryRevision.count({ where: { chatId: chat.id } }), 0);
  });

  it("restores a deleted revision as a new monotonic revision and marks embeddings stale", async () => {
    const chat = await createChat("restore history");
    const created = await createManualMemory(chat.id, { title: "Before", content: "Recoverable", keywords: ["restore"] });
    await prisma.chatMemory.update({ where: { id: created.memory.id }, data: { embedding: [1, 0], embeddingStatus: "ready", embeddingSource: "fixture" } });
    await deleteManualMemory(chat.id, created.memory.id);
    const preview = await previewMemoryRestore(chat.id, created.memory.id, 1);
    assert.equal(preview.current, null);
    assert.equal(preview.restored.title, "Before");
    const result = await restoreMemoryRevision(chat.id, created.memory.id, 1, preview.expectedCurrentRevision);
    assert.equal(result.memory.deletedAt, null);
    assert.equal(result.memory.currentRevision, 3);
    assert.equal(result.memory.embeddingStatus, "stale");
    assert.equal(result.revision.action, "restore");
    assert.equal((await prisma.memoryRevision.findMany({ where: { memoryId: created.memory.id } })).length, 3);
  });

  it("groups automatic create, update, and disable under one operation and undoes them atomically", async () => {
    const chat = await createChat("operation undo");
    const updatedBase = await createManualMemory(chat.id, { title: "Updated base", content: "Old content" });
    const disabledBase = await createManualMemory(chat.id, { title: "Disabled base", content: "Stay enabled" });
    const operation = await prisma.memoryOperation.create({ data: { chatId: chat.id, type: "automatic_maintenance", actor: "automatic_memory", status: "running", sourceMessageIds: [] } });
    let createdMemoryId = "";
    await prisma.$transaction(async (tx) => {
      const updated = await tx.chatMemory.findUniqueOrThrow({ where: { id: updatedBase.memory.id } });
      const disabled = await tx.chatMemory.findUniqueOrThrow({ where: { id: disabledBase.memory.id } });
      await updateMemoryInTransaction(tx, updated, { content: "Automatic content" }, { actor: "automatic_memory", action: "automatic_update", reasonCode: "fixture", operationId: operation.id });
      await updateMemoryInTransaction(tx, disabled, { enabled: false }, { actor: "automatic_memory", action: "automatic_disable", reasonCode: "fixture", operationId: operation.id });
      const created = await createMemoryInTransaction(tx, { chatId: chat.id, title: "Automatic create", content: "New fact" }, { actor: "automatic_memory", action: "automatic_create", reasonCode: "fixture", operationId: operation.id });
      createdMemoryId = created.memory.id;
      await tx.memoryOperation.update({ where: { id: operation.id }, data: { status: "succeeded", completedAt: new Date(), createdCount: 1, updatedCount: 2, disabledCount: 1 } });
    });

    const preview = await previewSpecificMemoryOperationUndo(chat.id, operation.id);
    assert.equal(preview.items.length, 3);
    assert.equal(preview.conflicts, 0);
    const result = await executeMemoryOperationUndo(chat.id, operation.id, preview.items.map((item) => ({ memoryId: item.memoryId, expectedCurrentRevision: item.currentRevision, action: "restore" })));
    assert.deepEqual({ restored: result.restored, retired: result.retired, skipped: result.skippedConflicts }, { restored: 2, retired: 1, skipped: 0 });
    assert.equal((await prisma.chatMemory.findUniqueOrThrow({ where: { id: updatedBase.memory.id } })).content, "Old content");
    assert.equal((await prisma.chatMemory.findUniqueOrThrow({ where: { id: disabledBase.memory.id } })).enabled, true);
    assert.ok((await prisma.chatMemory.findUniqueOrThrow({ where: { id: createdMemoryId } })).deletedAt);
    await assert.rejects(previewSpecificMemoryOperationUndo(chat.id, operation.id), /already undone/);
  });

  it("marks post-operation user edits as conflicts, skips by default, and rejects stale previews", async () => {
    const chat = await createChat("undo conflicts");
    const base = await createManualMemory(chat.id, { title: "Conflict", content: "Before" });
    const operation = await prisma.memoryOperation.create({ data: { chatId: chat.id, type: "automatic_maintenance", actor: "automatic_memory", status: "running", sourceMessageIds: [] } });
    await prisma.$transaction(async (tx) => {
      const current = await tx.chatMemory.findUniqueOrThrow({ where: { id: base.memory.id } });
      await updateMemoryInTransaction(tx, current, { content: "Automatic" }, { actor: "automatic_memory", action: "automatic_update", reasonCode: "fixture", operationId: operation.id });
      await tx.memoryOperation.update({ where: { id: operation.id }, data: { status: "succeeded", completedAt: new Date(), updatedCount: 1 } });
    });
    await updateManualMemory(chat.id, base.memory.id, { content: "User edit" });
    const preview = await previewSpecificMemoryOperationUndo(chat.id, operation.id);
    assert.equal(preview.conflicts, 1);
    const skipped = await executeMemoryOperationUndo(chat.id, operation.id, [{ memoryId: base.memory.id, expectedCurrentRevision: preview.items[0].currentRevision, action: "skip" }]);
    assert.equal(skipped.skippedConflicts, 1);
    assert.equal((await prisma.chatMemory.findUniqueOrThrow({ where: { id: base.memory.id } })).content, "User edit");

    const second = await prisma.memoryOperation.create({ data: { chatId: chat.id, type: "automatic_maintenance", actor: "automatic_memory", status: "running", sourceMessageIds: [] } });
    await prisma.$transaction(async (tx) => {
      const current = await tx.chatMemory.findUniqueOrThrow({ where: { id: base.memory.id } });
      await updateMemoryInTransaction(tx, current, { content: "Second automatic" }, { actor: "automatic_memory", action: "automatic_update", reasonCode: "fixture", operationId: second.id });
      await tx.memoryOperation.update({ where: { id: second.id }, data: { status: "succeeded", completedAt: new Date(), updatedCount: 1 } });
    });
    const stalePreview = await previewSpecificMemoryOperationUndo(chat.id, second.id);
    await updateManualMemory(chat.id, base.memory.id, { content: "Changed after preview" });
    await assert.rejects(
      executeMemoryOperationUndo(chat.id, second.id, [{ memoryId: base.memory.id, expectedCurrentRevision: stalePreview.items[0].currentRevision, action: "restore" }]),
      /changed after the undo preview/
    );
    assert.equal(await prisma.memoryOperation.count({ where: { chatId: chat.id, type: "operation_undo", status: "running" } }), 0);
  });

  it("keeps profile automatic/manual/clear/restore history and sources", async () => {
    const chat = await createChat("profile history");
    const message = await prisma.message.create({ data: { chatId: chat.id, role: "user", content: "profile fixture", variants: [] } });
    await prisma.$transaction(async (tx) => {
      const current = await tx.chat.findUniqueOrThrow({ where: { id: chat.id } });
      const { updateProfileSummaryInTransaction } = await import("./memoryHistory.js");
      await updateProfileSummaryInTransaction(tx, current, "Automatic profile", "automatic_memory", [message.id], "automatic_update");
    });
    await updateManualProfileSummary(chat.id, "Manual profile");
    await updateManualProfileSummary(chat.id, "");
    const previewChat = await prisma.chat.findUniqueOrThrow({ where: { id: chat.id } });
    const restored = await restoreProfileSummaryRevision(chat.id, 1, previewChat.profileRevision);
    assert.equal(restored.chat.userProfileSummary, "Automatic profile");
    assert.equal(restored.chat.profileRevision, 4);
    const history = await listProfileSummaryRevisions(chat.id);
    assert.deepEqual(history.map((item) => item.action).reverse(), ["automatic_update", "manual_edit", "manual_clear", "restore"]);
    assert.equal(history.at(-1)?.sources[0]?.available, true);
  });

  it("bounds revision and operation retention without rewinding monotonic counters", async () => {
    const chat = await createChat("bounded retention");
    const created = await createManualMemory(chat.id, { title: "Retention", content: "v0" });
    for (let index = 1; index <= 35; index += 1) {
      await updateManualMemory(chat.id, created.memory.id, { content: `v${index}` });
    }
    const memory = await prisma.chatMemory.findUniqueOrThrow({ where: { id: created.memory.id } });
    const revisions = await prisma.memoryRevision.findMany({ where: { memoryId: memory.id }, orderBy: { revision: "asc" } });
    assert.equal(memory.currentRevision, 36);
    assert.equal(revisions.length, 30);
    assert.equal(revisions[0].revision, 7);
    assert.equal(revisions.at(-1)?.revision, 36);

    await prisma.memoryOperation.createMany({
      data: Array.from({ length: 105 }, (_entry, index) => ({
        chatId: chat.id,
        type: "automatic_maintenance",
        actor: "automatic_memory",
        status: "failed",
        startedAt: new Date(Date.now() + index),
        completedAt: new Date(Date.now() + index),
        sourceMessageIds: [],
        errorCode: "retention_fixture"
      }))
    });
    await prisma.$transaction((tx) => pruneMemoryOperations(tx, chat.id));
    assert.equal(await prisma.memoryOperation.count({ where: { chatId: chat.id } }), 100);

    await updateManualMemory(chat.id, memory.id, { content: "v37" });
    assert.equal((await prisma.chatMemory.findUniqueOrThrow({ where: { id: memory.id } })).currentRevision, 37);
    assert.equal(await prisma.memoryRevision.count({ where: { memoryId: memory.id } }), 30);
  });
});
