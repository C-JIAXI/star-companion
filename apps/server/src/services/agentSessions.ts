import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { HttpError } from "../lib/http.js";
import { createChatAgentDraft, type ChatAgentMode, type AgentAction } from "./chatAgent.js";
import { createMemoryInTransaction, updateMemoryInTransaction, pruneMemoryOperations } from "./memoryHistory.js";
import { buildCharacterUpdateData, resolveCharacterPromptFields, resolveCharacterRecord } from "./characterCards.js";
import { emitAgentRunEvent, emitAgentToolEvent, getAgentRunEventSequence } from "./agentRunEvents.js";
import { getPendingMcpApproval } from "./mcpApprovals.js";

type AgentEntryDTO = {
  id: string; role: "user" | "assistant"; mode: ChatAgentMode | null; content: string;
  status: "running" | "succeeded" | "failed" | "interrupted" | "cancelled";
  sourceMessageIds: string[]; sourceMemoryIds: string[]; actions: AgentAction[]; createdAt: string; completedAt: string | null;
};
type AgentSessionDTO = { chatId: string; activeRunId: string | null; entries: AgentEntryDTO[] };
type AgentTaskRequestDTO = { mutationId: string; mode: ChatAgentMode; content: string; generation?: { temperature: number; maxTokens: number } };
type CandidateEdit = { title: string; content: string; keywords: string[] };

const activeRuns = new Map<string, { id: string; controller: AbortController }>();

const stringArray = (value: Prisma.JsonValue): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const actionsArray = (value: Prisma.JsonValue): AgentAction[] =>
  Array.isArray(value) ? value.filter((item) =>
    Boolean(item && typeof item === "object" && !Array.isArray(item) && typeof item.id === "string" &&
      typeof item.content === "string" && typeof item.title === "string" &&
      ["reply_draft", "memory_candidate", "lore_candidate"].includes(String(item.kind)))) as AgentAction[] : [];

const toEntry = (entry: {
  id: string; role: string; mode: string | null; content: string; status: string;
  sourceMessageIds: Prisma.JsonValue; sourceMemoryIds: Prisma.JsonValue; actions: Prisma.JsonValue; createdAt: Date; completedAt: Date | null;
}): AgentEntryDTO => ({
  id: entry.id,
  role: entry.role as AgentEntryDTO["role"],
  mode: entry.mode as ChatAgentMode | null,
  content: entry.content,
  status: entry.status as AgentEntryDTO["status"],
  sourceMessageIds: stringArray(entry.sourceMessageIds),
  sourceMemoryIds: stringArray(entry.sourceMemoryIds),
  actions: actionsArray(entry.actions),
  createdAt: entry.createdAt.toISOString(),
  completedAt: entry.completedAt?.toISOString() ?? null
});

const requireActiveChat = async (chatId: string) => {
  const chat = await prisma.chat.findFirst({ where: { id: chatId, deletedAt: null }, select: { id: true } });
  if (!chat) throw new HttpError(404, "Chat not found");
};

export const getAgentSession = async (chatId: string): Promise<AgentSessionDTO> => {
  await requireActiveChat(chatId);
  const session = await prisma.agentSession.findUnique({
    where: { chatId },
    include: { entries: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } }
  });
  return {
    chatId,
    activeRunId: session?.activeRunId ?? null,
    entries: session?.entries.map(toEntry) ?? []
  };
};

export const getAgentRunStatus = async (chatId: string, runId: string) => {
  await requireActiveChat(chatId);
  const entry = await prisma.agentEntry.findFirst({
    where: { id: runId, role: "user", session: { chatId } }, select: { status: true, completedAt: true }
  });
  if (!entry) throw new HttpError(404, "Agent run not found");
  return { runId, status: entry.status as AgentEntryDTO["status"], completedAt: entry.completedAt?.toISOString() ?? null,
    lastEventSeq: getAgentRunEventSequence(chatId, runId), pendingApproval: getPendingMcpApproval(chatId, runId) };
};

export const previewAgentCandidate = async (chatId: string, actionId: string, candidate: CandidateEdit, accessPassword?: string) => {
  const chat = await prisma.chat.findFirst({
    where: { id: chatId, deletedAt: null },
    select: { title: true, characterId: true, character: true }
  });
  if (!chat) throw new HttpError(404, "Chat not found");
  const entries = await prisma.agentEntry.findMany({
    where: { role: "assistant", status: "succeeded", session: { chatId } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }]
  });
  const action = entries.flatMap((entry) => actionsArray(entry.actions)).find((item) => item.id === actionId);
  if (!action || action.kind === "reply_draft") throw new HttpError(404, "Agent candidate not found");
  const sourceMessageIds = action.sourceMessageIds ?? [];
  if (sourceMessageIds.length) {
    const available = await prisma.message.count({ where: { chatId, id: { in: sourceMessageIds }, contextIncluded: true } });
    if (available !== new Set(sourceMessageIds).size) throw new HttpError(409, "Candidate sources changed; review the proposal again");
  }
  const sourceMemoryIds = action.sourceMemoryIds ?? [];
  if (sourceMemoryIds.length) {
    const available = await prisma.chatMemory.count({ where: { chatId, id: { in: sourceMemoryIds }, enabled: true, deletedAt: null } });
    if (available !== new Set(sourceMemoryIds).size) throw new HttpError(409, "Candidate memory sources changed; review the proposal again");
  }
  let targetName = chat.title;
  let targetVersion: string | null = null;
  let affectedChatCount = 1;
  let privateCharacter = false;
  let targets: Array<{ id: string; title: string; content: string; currentRevision: number; enabled: boolean }> | undefined;
  let loreTarget: { id: string; content: string; keywords: string[] } | null | undefined;
  if (action.kind === "memory_candidate" && action.memoryAction && action.memoryAction !== "create") {
    const ids = action.targetMemoryIds ?? [];
    const memories = await prisma.chatMemory.findMany({ where: { chatId, id: { in: ids }, deletedAt: null } });
    const byId = new Map(memories.map((memory) => [memory.id, memory]));
    targets = ids.map((id, index) => {
      const memory = byId.get(id);
      if (!memory || !memory.enabled || (!action.appliedTargetId && memory.currentRevision !== action.targetMemoryRevisions?.[index])) {
        throw new HttpError(409, "Target memory changed; review the proposal again");
      }
      return { id, title: memory.title, content: memory.content, currentRevision: memory.currentRevision, enabled: memory.enabled };
    });
    targetName = targets[0]?.title ?? chat.title;
    targetVersion = String(targets[0]?.currentRevision ?? "");
  }
  if (action.kind === "lore_candidate") {
    if (!chat.character || chat.characterId !== action.targetCharacterId || !action.targetVersion) {
      throw new HttpError(409, "Character binding changed; review the proposal again");
    }
    if (!action.appliedTargetId && chat.character.updatedAt.toISOString() !== action.targetVersion) {
      throw new HttpError(409, "Character changed; review the Lore diff again");
    }
    targetName = chat.character.name;
    targetVersion = chat.character.updatedAt.toISOString();
    affectedChatCount = await prisma.chat.count({ where: { characterId: chat.characterId, deletedAt: null } });
    privateCharacter = resolveCharacterRecord(chat.character).visibility === "private";
    if (action.loreAction === "update") {
      const target = privateCharacter && !accessPassword ? null
        : resolveCharacterPromptFields(chat.character, accessPassword).loreEntries.find((item) => item.id === action.targetLoreEntryId);
      if ((!privateCharacter || accessPassword) && !target) throw new HttpError(409, "Target Lore changed; review the proposal again");
      loreTarget = target ? { id: target.id, content: target.content, keywords: target.keys } : null;
    }
  }
  return {
    kind: action.kind, original: { title: action.title, content: action.content, keywords: action.keywords ?? [] },
    proposed: candidate, targetName, targetVersion, affectedChatCount,
    sourceMessageCount: sourceMessageIds.length, sourceMemoryCount: sourceMemoryIds.length,
    privateCharacter, alreadyApplied: Boolean(action.appliedTargetId), loreAction: action.loreAction ?? "create", loreTarget,
    memoryAction: action.kind === "memory_candidate" ? action.memoryAction ?? "create" : undefined, targets
  };
};

export const confirmAgentMemoryCandidate = async (chatId: string, actionId: string, candidate: CandidateEdit) => {
  await requireActiveChat(chatId);
  const confirmed = await prisma.$transaction(async (tx) => {
    const entries = await tx.agentEntry.findMany({
      where: { role: "assistant", status: "succeeded", session: { chatId } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }]
    });
    const entry = entries.find((item) => actionsArray(item.actions).some((action) => action.id === actionId));
    if (!entry) throw new HttpError(404, "Agent candidate not found");
    const actions = actionsArray(entry.actions);
    const action = actions.find((item) => item.id === actionId);
    if (!action || action.kind !== "memory_candidate") throw new HttpError(404, "Agent candidate not found");
    if (action.appliedTargetId) {
      const appliedInput = action.appliedInput ?? { title: action.title, content: action.content, keywords: action.keywords ?? [] };
      if (JSON.stringify(appliedInput) !== JSON.stringify(candidate)) throw new HttpError(409, "Candidate was already applied with different content");
      const existing = await tx.chatMemory.findFirst({ where: { id: action.appliedTargetId, chatId } });
      if (!existing) throw new HttpError(409, "Applied memory is no longer available");
      return { memory: existing, alreadyApplied: true };
    }
    const sourceIds = action.sourceMessageIds ?? [];
    if (sourceIds.length) {
      const available = await tx.message.count({ where: { chatId, id: { in: sourceIds }, contextIncluded: true } });
      if (available !== new Set(sourceIds).size) throw new HttpError(409, "Candidate sources changed; review the proposal again");
    }
    const sourceMemoryIds = action.sourceMemoryIds ?? [];
    if (sourceMemoryIds.length) {
      const available = await tx.chatMemory.count({ where: { chatId, id: { in: sourceMemoryIds }, enabled: true, deletedAt: null } });
      if (available !== new Set(sourceMemoryIds).size) throw new HttpError(409, "Candidate memory sources changed; review the proposal again");
    }
    const memoryAction = action.memoryAction ?? "create";
    let result: { memory: Awaited<ReturnType<typeof createMemoryInTransaction>>["memory"] };
    let operationId: string | undefined;
    if (memoryAction === "create") {
      result = await createMemoryInTransaction(tx, {
        id: action.id, chatId, title: candidate.title, content: candidate.content,
        keywords: candidate.keywords, importance: 3, enabled: true, sourceMessageIds: sourceIds
      }, { actor: "agent_confirmed", action: "agent_confirmed_create", reasonCode: "agent_candidate_confirmed" });
    } else {
      const ids = action.targetMemoryIds ?? [];
      const versions = action.targetMemoryRevisions ?? [];
      if (!ids.length || ids.length !== versions.length || (memoryAction === "merge" ? ids.length < 2 : ids.length !== 1)) {
        throw new HttpError(409, "Candidate targets are incomplete");
      }
      const rows = await tx.chatMemory.findMany({ where: { chatId, id: { in: ids }, deletedAt: null } });
      const byId = new Map(rows.map((memory) => [memory.id, memory]));
      const targets = ids.map((id, index) => {
        const memory = byId.get(id);
        if (!memory || !memory.enabled || memory.currentRevision !== versions[index]) {
          throw new HttpError(409, "Target memory changed; review the proposal again");
        }
        return memory;
      });
      const operation = await tx.memoryOperation.create({ data: {
        chatId, type: "agent_maintenance", actor: "agent_confirmed", status: "running", sourceMessageIds: sourceIds
      } });
      operationId = operation.id;
      const primary = targets[0];
      const mergedSources = [...new Set([...sourceIds, ...targets.flatMap((memory) => stringArray(memory.sourceMessageIds))])].slice(0, 20);
      const updatedPrimary = await updateMemoryInTransaction(tx, primary, memoryAction === "disable"
        ? { enabled: false }
        : { title: candidate.title, content: candidate.content, keywords: candidate.keywords, sourceMessageIds: mergedSources }, {
        actor: "agent_confirmed", action: memoryAction === "disable" ? "agent_confirmed_disable" : "agent_confirmed_update",
        reasonCode: "agent_candidate_confirmed", operationId, allowMissingSources: true
      });
      if (!updatedPrimary.changed && targets.length === 1) throw new HttpError(409, "The proposed memory change has no differences");
      result = updatedPrimary;
      let disabled = memoryAction === "disable" && updatedPrimary.changed ? 1 : 0;
      for (const duplicate of targets.slice(1)) {
        const changed = await updateMemoryInTransaction(tx, duplicate, { enabled: false }, {
          actor: "agent_confirmed", action: "agent_confirmed_disable", reasonCode: "agent_candidate_confirmed", operationId
        });
        if (changed.changed) disabled += 1;
      }
      await tx.memoryOperation.update({ where: { id: operationId }, data: {
        status: "succeeded", completedAt: new Date(), updatedCount: memoryAction === "disable" ? 0 : updatedPrimary.changed ? 1 : 0,
        disabledCount: disabled
      } });
      await pruneMemoryOperations(tx, chatId);
    }
    const updated = actions.map((item) => item.id === actionId
      ? { ...item, appliedAt: new Date().toISOString(), appliedTargetId: result.memory.id, appliedOperationId: operationId, appliedInput: candidate }
      : item);
    await tx.agentEntry.update({ where: { id: entry.id }, data: { actions: updated as Prisma.InputJsonValue } });
    return { memory: result.memory, operationId, alreadyApplied: false };
  });
  return { ...confirmed, session: await getAgentSession(chatId) };
};

export const confirmAgentLoreCandidate = async (chatId: string, actionId: string, candidate: CandidateEdit, accessPassword?: string) => {
  await requireActiveChat(chatId);
  const confirmed = await prisma.$transaction(async (tx) => {
    const entries = await tx.agentEntry.findMany({
      where: { role: "assistant", status: "succeeded", session: { chatId } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }]
    });
    const entry = entries.find((item) => actionsArray(item.actions).some((action) => action.id === actionId));
    if (!entry) throw new HttpError(404, "Agent candidate not found");
    const actions = actionsArray(entry.actions);
    const action = actions.find((item) => item.id === actionId);
    if (!action || action.kind !== "lore_candidate") throw new HttpError(404, "Agent candidate not found");
    const chat = await tx.chat.findFirst({ where: { id: chatId, deletedAt: null }, select: { characterId: true } });
    if (!chat?.characterId || chat.characterId !== action.targetCharacterId || !action.targetVersion) {
      throw new HttpError(409, "Character binding changed; review the proposal again");
    }
    const character = await tx.character.findUnique({ where: { id: chat.characterId } });
    if (!character) throw new HttpError(404, "Character not found");
    if (action.appliedTargetId) {
      const appliedInput = action.appliedInput ?? { title: action.title, content: action.content, keywords: action.keywords ?? [] };
      if (JSON.stringify(appliedInput) !== JSON.stringify(candidate)) throw new HttpError(409, "Candidate was already applied with different content");
      return { characterId: character.id, characterName: character.name, alreadyApplied: true };
    }
    if (character.updatedAt.toISOString() !== action.targetVersion) {
      throw new HttpError(409, "Character changed; review the Lore diff again");
    }
    const sourceIds = action.sourceMessageIds ?? [];
    if (sourceIds.length) {
      const available = await tx.message.count({ where: { chatId, id: { in: sourceIds }, contextIncluded: true } });
      if (available !== new Set(sourceIds).size) throw new HttpError(409, "Candidate sources changed; review the proposal again");
    }
    const sourceMemoryIds = action.sourceMemoryIds ?? [];
    if (sourceMemoryIds.length) {
      const available = await tx.chatMemory.count({ where: { chatId, id: { in: sourceMemoryIds }, enabled: true, deletedAt: null } });
      if (available !== new Set(sourceMemoryIds).size) throw new HttpError(409, "Candidate memory sources changed; review the proposal again");
    }
    const fields = resolveCharacterPromptFields(character, accessPassword);
    const loreEntries = action.loreAction === "update" ? fields.loreEntries.map((item) => item.id === action.targetLoreEntryId
      ? { ...item, keys: candidate.keywords, content: candidate.content } : item)
      : [...fields.loreEntries, {
          id: action.id, keys: candidate.keywords, content: candidate.content,
          priority: 0, scope: "prompt" as const, triggerMode: "both" as const,
          alwaysActive: false, enabled: true
        }];
    if (action.loreAction === "update" && !fields.loreEntries.some((item) => item.id === action.targetLoreEntryId)) {
      throw new HttpError(409, "Target Lore changed; review the proposal again");
    }
    const updates = buildCharacterUpdateData(character, { loreEntries: loreEntries as Prisma.InputJsonValue }, accessPassword);
    await tx.character.update({ where: { id: character.id, updatedAt: character.updatedAt }, data: updates });
    await tx.agentEntry.update({ where: { id: entry.id }, data: { actions: actions.map((item) => item.id === actionId
      ? { ...item, appliedAt: new Date().toISOString(), appliedTargetId: character.id, appliedInput: candidate }
      : item) as Prisma.InputJsonValue } });
    return { characterId: character.id, characterName: character.name, alreadyApplied: false };
  });
  const affectedChatCount = await prisma.chat.count({ where: { characterId: confirmed.characterId, deletedAt: null } });
  return { ...confirmed, affectedChatCount, session: await getAgentSession(chatId) };
};

export const appendAgentTask = async (chatId: string, input: AgentTaskRequestDTO): Promise<AgentSessionDTO> => {
  await requireActiveChat(chatId);
  const existing = await prisma.agentEntry.findUnique({ where: { id: input.mutationId }, include: { session: true } });
  if (existing) {
    if (existing.session.chatId !== chatId) throw new HttpError(409, "Task id belongs to another chat");
    if (existing.content !== input.content || existing.mode !== input.mode ||
      JSON.stringify(existing.generation ?? {}) !== JSON.stringify(input.generation ?? {})) {
      throw new HttpError(409, "Task id was already used with different content or generation settings");
    }
    return getAgentSession(chatId);
  }

  const session = await prisma.agentSession.upsert({ where: { chatId }, update: {}, create: { chatId } });
  const controller = new AbortController();
  const started = await prisma.$transaction(async (tx) => {
    const claim = await tx.agentSession.updateMany({ where: { id: session.id, activeRunId: null }, data: { activeRunId: input.mutationId } });
    if (!claim.count) throw new HttpError(409, "An Agent task is already running");
    const history = await tx.agentEntry.findMany({
      where: { sessionId: session.id, status: "succeeded" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 12,
      select: { role: true, content: true }
    });
    await tx.agentEntry.create({ data: {
      id: input.mutationId,
      sessionId: session.id,
      role: "user",
      mode: input.mode,
      content: input.content,
      generation: (input.generation ?? {}) as Prisma.InputJsonValue,
      status: "running"
    } });
    return history.reverse().map((entry) => ({ role: entry.role as "user" | "assistant", content: entry.content }));
  });
  activeRuns.set(chatId, { id: input.mutationId, controller });
  emitAgentRunEvent(chatId, input.mutationId, "started");

  try {
    const draft = await createChatAgentDraft({
      chatId, mode: input.mode, focus: input.content, history: started,
      generation: input.generation,
      signal: controller.signal, requestId: `agent_${input.mutationId}`,
      onEvent: (event) => event.type === "context_start" || event.type === "context_complete"
        ? emitAgentRunEvent(chatId, input.mutationId, event.type)
        : emitAgentToolEvent(chatId, input.mutationId, event)
    });
    if (controller.signal.aborted) throw new HttpError(409, "Agent task was cancelled");
    await prisma.$transaction(async (tx) => {
      await tx.agentEntry.update({ where: { id: input.mutationId }, data: { status: "succeeded", completedAt: new Date() } });
      await tx.agentEntry.create({ data: {
        id: randomUUID(), sessionId: session.id, role: "assistant", mode: input.mode,
        content: draft.content, status: "succeeded", completedAt: new Date(),
        sourceMessageIds: draft.sourceMessageIds as Prisma.InputJsonValue,
        sourceMemoryIds: draft.sourceMemoryIds as Prisma.InputJsonValue,
        actions: draft.actions as Prisma.InputJsonValue
      } });
      await tx.agentSession.update({ where: { id: session.id }, data: { activeRunId: null } });
    });
    emitAgentRunEvent(chatId, input.mutationId, "succeeded");
  } catch (error) {
    await prisma.$transaction(async (tx) => {
      await tx.agentEntry.updateMany({ where: { id: input.mutationId, status: "running" }, data: { status: controller.signal.aborted ? "cancelled" : "failed", completedAt: new Date() } });
      await tx.agentSession.updateMany({ where: { id: session.id, activeRunId: input.mutationId }, data: { activeRunId: null } });
    });
    emitAgentRunEvent(chatId, input.mutationId, controller.signal.aborted ? "cancelled" : "failed");
    throw error;
  } finally {
    if (activeRuns.get(chatId)?.id === input.mutationId) activeRuns.delete(chatId);
  }
  return getAgentSession(chatId);
};

export const cancelAgentTask = async (chatId: string, runId: string) => {
  await requireActiveChat(chatId);
  const current = activeRuns.get(chatId);
  if (current?.id === runId) {
    current.controller.abort();
    return { cancelled: true };
  }
  return { cancelled: false };
};

export const cancelAllAgentTasks = () => {
  for (const run of activeRuns.values()) run.controller.abort();
};

export const clearAgentSession = async (chatId: string) => {
  await requireActiveChat(chatId);
  if (activeRuns.has(chatId)) throw new HttpError(409, "Stop the running Agent task before clearing history");
  const session = await prisma.agentSession.findUnique({ where: { chatId }, select: { id: true, activeRunId: true } });
  if (session?.activeRunId) throw new HttpError(409, "Stop the running Agent task before clearing history");
  if (session) await prisma.agentSession.delete({ where: { id: session.id } });
  return { cleared: true };
};

export const recoverInterruptedAgentTasks = () => prisma.$transaction(async (tx) => {
  const sessions = await tx.agentSession.findMany({ where: { activeRunId: { not: null } }, select: { id: true, activeRunId: true } });
  for (const session of sessions) {
    await tx.agentEntry.updateMany({ where: { id: session.activeRunId!, status: "running" }, data: { status: "interrupted", completedAt: new Date() } });
    await tx.agentSession.update({ where: { id: session.id }, data: { activeRunId: null } });
  }
  return sessions.length;
});
