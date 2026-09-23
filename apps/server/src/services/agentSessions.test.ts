import assert from "node:assert/strict";
import { after, it } from "node:test";
import { prisma } from "../db.js";
import { createManualMemory, executeMemoryOperationUndo, previewSpecificMemoryOperationUndo, updateManualMemory } from "./memoryHistory.js";
import { confirmAgentLoreCandidate, confirmAgentMemoryCandidate, previewAgentCandidate } from "./agentSessions.js";

const chatIds: string[] = [];
const characterIds: string[] = [];
after(async () => {
  if (chatIds.length) await prisma.chat.deleteMany({ where: { id: { in: chatIds } } });
  if (characterIds.length) await prisma.character.deleteMany({ where: { id: { in: characterIds } } });
  await prisma.$disconnect();
});

it("previews and updates one embedded Lore entry without changing its trigger settings", async () => {
  const character = await prisma.character.create({ data: { name: "Gatekeeper", prompt: "Watch the gate.", loreEntries: [{
    id: "gate-lore", keys: ["gate"], content: "The gate is red.", priority: 7, scope: "prompt", triggerMode: "both",
    alwaysActive: true, enabled: true
  }] } });
  characterIds.push(character.id);
  const chat = await prisma.chat.create({ data: { title: "Gate", characterId: character.id } });
  chatIds.push(chat.id);
  const session = await prisma.agentSession.create({ data: { chatId: chat.id } });
  const action = { id: `lore-${chat.id}`, kind: "lore_candidate", loreAction: "update", targetLoreEntryId: "gate-lore",
    title: "Gate color", content: "The gate is blue.", keywords: ["gate"], targetCharacterId: character.id,
    targetVersion: character.updatedAt.toISOString(), sourceMessageIds: [], sourceMemoryIds: [] };
  await prisma.agentEntry.create({ data: { sessionId: session.id, role: "assistant", mode: "memory_lore_candidates",
    content: "Update the color", status: "succeeded", actions: [action] } });
  const candidate = { title: action.title, content: action.content, keywords: action.keywords };
  const preview = await previewAgentCandidate(chat.id, action.id, candidate);
  assert.equal(preview.loreTarget?.content, "The gate is red.");
  const saved = await confirmAgentLoreCandidate(chat.id, action.id, candidate);
  assert.equal(saved.alreadyApplied, false);
  const updated = await prisma.character.findUniqueOrThrow({ where: { id: character.id } });
  const lore = updated.loreEntries as Array<{ id: string; content: string; priority: number; alwaysActive: boolean }>;
  assert.equal(lore.length, 1);
  assert.equal(lore[0].content, "The gate is blue.");
  assert.equal(lore[0].priority, 7);
  assert.equal(lore[0].alwaysActive, true);
  assert.equal((await confirmAgentLoreCandidate(chat.id, action.id, candidate)).alreadyApplied, true);
});

const fixture = async (memoryAction: "merge" | "update" | "disable") => {
  const chat = await prisma.chat.create({ data: { title: `Agent ${memoryAction}` } });
  chatIds.push(chat.id);
  const first = await createManualMemory(chat.id, { title: "Promise A", content: "We agreed at dusk", keywords: ["promise"] });
  const second = await createManualMemory(chat.id, { title: "Promise B", content: "The dusk agreement", keywords: ["dusk"] });
  const session = await prisma.agentSession.create({ data: { chatId: chat.id } });
  const action = {
    id: `candidate-${chat.id}`, kind: "memory_candidate", memoryAction,
    title: "One promise", content: "We agreed at dusk", keywords: ["promise", "dusk"],
    sourceMessageIds: [], sourceMemoryIds: [],
    targetMemoryIds: memoryAction === "merge" ? [first.memory.id, second.memory.id] : [first.memory.id],
    targetMemoryRevisions: memoryAction === "merge" ? [1, 1] : [1]
  };
  await prisma.agentEntry.create({ data: {
    sessionId: session.id, role: "assistant", mode: "memory_lore_candidates", content: "Proposal",
    status: "succeeded", actions: [action]
  } });
  return { chat, first, second, action, candidate: { title: action.title, content: action.content, keywords: action.keywords } };
};

it("previews and atomically merges memories, keeps an idempotent receipt, and undoes both revisions", async () => {
  const { chat, first, second, action, candidate } = await fixture("merge");
  const preview = await previewAgentCandidate(chat.id, action.id, candidate);
  assert.equal(preview.memoryAction, "merge");
  assert.deepEqual(preview.targets?.map((target) => target.currentRevision), [1, 1]);
  const saved = await confirmAgentMemoryCandidate(chat.id, action.id, candidate);
  assert.equal(saved.memory.title, "One promise");
  assert.equal((await prisma.chatMemory.findUniqueOrThrow({ where: { id: second.memory.id } })).enabled, false);
  const operation = await prisma.memoryOperation.findFirstOrThrow({ where: { chatId: chat.id, type: "agent_maintenance" } });
  assert.equal(operation.updatedCount, 1);
  assert.equal(operation.disabledCount, 1);
  assert.equal((await prisma.memoryRevision.count({ where: { operationId: operation.id } })), 2);
  const repeated = await confirmAgentMemoryCandidate(chat.id, action.id, candidate);
  assert.equal(repeated.alreadyApplied, true);
  assert.equal((await prisma.memoryOperation.count({ where: { chatId: chat.id, type: "agent_maintenance" } })), 1);
  const undo = await previewSpecificMemoryOperationUndo(chat.id, operation.id);
  await executeMemoryOperationUndo(chat.id, operation.id, undo.items.map((item) => ({ memoryId: item.memoryId, expectedCurrentRevision: item.currentRevision, action: "restore" })));
  assert.equal((await prisma.chatMemory.findUniqueOrThrow({ where: { id: first.memory.id } })).title, "Promise A");
  assert.equal((await prisma.chatMemory.findUniqueOrThrow({ where: { id: second.memory.id } })).enabled, true);
});

it("rejects a target revision changed after proposal without writing an operation", async () => {
  const { chat, first, action, candidate } = await fixture("update");
  await updateManualMemory(chat.id, first.memory.id, { content: "A later correction" });
  await assert.rejects(previewAgentCandidate(chat.id, action.id, candidate), /Target memory changed/);
  await assert.rejects(confirmAgentMemoryCandidate(chat.id, action.id, candidate), /Target memory changed/);
  assert.equal((await prisma.memoryOperation.count({ where: { chatId: chat.id } })), 0);
});

it("updates or disables a single memory with a revision and reversible operation", async () => {
  for (const memoryAction of ["update", "disable"] as const) {
    const { chat, first, action, candidate } = await fixture(memoryAction);
    const saved = await confirmAgentMemoryCandidate(chat.id, action.id, candidate);
    const current = await prisma.chatMemory.findUniqueOrThrow({ where: { id: first.memory.id } });
    assert.equal(current.currentRevision, 2);
    assert.equal(current.enabled, memoryAction !== "disable");
    assert.equal(current.title, memoryAction === "disable" ? "Promise A" : "One promise");
    const operation = await prisma.memoryOperation.findFirstOrThrow({ where: { chatId: chat.id, type: "agent_maintenance" } });
    assert.equal(saved.operationId, operation.id);
    const undo = await previewSpecificMemoryOperationUndo(chat.id, operation.id);
    assert.equal(undo.items.length, 1);
    await executeMemoryOperationUndo(chat.id, operation.id, [{ memoryId: first.memory.id, expectedCurrentRevision: current.currentRevision, action: "restore" }]);
    const restored = await prisma.chatMemory.findUniqueOrThrow({ where: { id: first.memory.id } });
    assert.equal(restored.title, "Promise A");
    assert.equal(restored.enabled, true);
  }
});
