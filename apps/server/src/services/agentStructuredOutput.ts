import { randomUUID } from "node:crypto";
import { z } from "zod";

export type AgentStructuredAction = {
  id: string;
  kind: "reply_draft" | "memory_candidate" | "lore_candidate";
  title: string;
  content: string;
  keywords?: string[];
  sourceMessageIds?: string[];
  sourceMemoryIds?: string[];
  memoryAction?: "create" | "update" | "merge" | "disable";
  loreAction?: "create" | "update";
  targetLoreEntryId?: string;
  targetMemoryIds?: string[];
  targetMemoryRevisions?: number[];
  appliedAt?: string;
  appliedTargetId?: string;
  targetCharacterId?: string;
  targetVersion?: string;
  appliedInput?: { title: string; content: string; keywords: string[] };
};

const idList = z.array(z.string().min(1).max(120)).max(20).default([]);
const actionSchema = z.object({
  kind: z.enum(["reply_draft", "memory_candidate", "lore_candidate"]),
  title: z.string().trim().min(1).max(80),
  content: z.string().trim().min(1).max(1200),
  keywords: z.array(z.string().trim().min(1).max(80)).max(12).default([]),
  sourceMessageIds: idList,
  sourceMemoryIds: idList,
  memoryAction: z.enum(["create", "update", "merge", "disable"]).optional(),
  loreAction: z.enum(["create", "update"]).optional(),
  targetLoreEntryId: z.string().min(1).max(120).optional(),
  targetMemoryIds: z.array(z.string().min(1).max(120)).max(8).optional()
}).strict();
const outputSchema = z.object({
  answer: z.string().trim().max(12000),
  candidates: z.array(actionSchema).max(8)
}).strict();

const allowedKinds = (mode: string) => mode === "reply_drafts"
  ? new Set(["reply_draft"])
  : mode === "memory_lore_candidates"
    ? new Set(["memory_candidate", "lore_candidate"])
    : new Set<string>();

export const parseAgentStructuredOutput = (
  mode: string,
  raw: string,
  allowedMessageIds: readonly string[] = [],
  allowedMemoryIds: readonly string[] = [],
  allowedLoreEntryIds: readonly string[] = []
): { answer: string; actions: AgentStructuredAction[]; valid: boolean } => {
  if (!allowedKinds(mode).size) return { answer: raw, actions: [], valid: true };
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { return { answer: raw, actions: [], valid: false }; }
  const parsed = outputSchema.safeParse(value);
  if (!parsed.success) return { answer: raw, actions: [], valid: false };
  const validKinds = allowedKinds(mode);
  const messages = new Set(allowedMessageIds);
  const memories = new Set(allowedMemoryIds);
  const lore = new Set(allowedLoreEntryIds);
  const actions = parsed.data.candidates
    .filter((candidate) => validKinds.has(candidate.kind))
    .filter((candidate) => candidate.kind !== "memory_candidate" ||
      (!candidate.memoryAction || candidate.memoryAction === "create" ? !candidate.targetMemoryIds?.length :
        candidate.memoryAction === "merge" ? new Set(candidate.targetMemoryIds ?? []).size >= 2 : candidate.targetMemoryIds?.length === 1))
    .filter((candidate) => candidate.kind !== "memory_candidate" ||
      (candidate.targetMemoryIds ?? []).every((id) => memories.has(id)))
    .filter((candidate) => candidate.kind !== "lore_candidate" ||
      (candidate.loreAction === "update" ? Boolean(candidate.targetLoreEntryId && lore.has(candidate.targetLoreEntryId)) : !candidate.targetLoreEntryId))
    .slice(0, mode === "reply_drafts" ? 3 : 8)
    .map((candidate): AgentStructuredAction => ({
      id: randomUUID(), kind: candidate.kind, title: candidate.title, content: candidate.content,
      keywords: [...new Set(candidate.keywords)],
      sourceMessageIds: [...new Set(candidate.sourceMessageIds.filter((id) => messages.has(id)))],
      sourceMemoryIds: [...new Set(candidate.sourceMemoryIds.filter((id) => memories.has(id)))],
      ...(candidate.kind === "memory_candidate" ? {
        memoryAction: candidate.memoryAction ?? "create",
        targetMemoryIds: [...new Set(candidate.targetMemoryIds ?? [])]
      } : candidate.kind === "lore_candidate" ? {
        loreAction: candidate.loreAction ?? "create", targetLoreEntryId: candidate.targetLoreEntryId
      } : {})
    }));
  return { answer: parsed.data.answer, actions, valid: true };
};
