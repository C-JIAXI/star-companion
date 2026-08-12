import { randomUUID } from "node:crypto";
import type { ChatCompletionMessage } from "./completions.js";

export type CharacterDraftTask = "generate_core_prompt" | "refine_prompt" | "consistency_questions" | "suggest_lore" | "suggest_quick_replies" | "find_contradictions";
export type CharacterDraftRequest = {
  requestId: string; task: CharacterDraftTask; brief?: string; characterId?: string; accessPassword?: string;
  draft: { name: string; description: string; prefix: string; prompt: string; suffix: string; loreEntries: Array<{ id?: string; keys: string[]; content: string; priority: number; scope: "prefix" | "prompt" | "suffix"; triggerMode: "user" | "assistant" | "both"; alwaysActive: boolean; enabled: boolean }>; quickReplies: Array<{ id?: string; label: string; content: string }> };
};
export type CharacterDraftItem = { id: string; field: "prompt" | "loreEntries" | "quickReplies" | "questions" | "analysis"; title: string; suggestion: string; loreEntry?: { keys: string[]; content: string; priority: number; scope: "prefix" | "prompt" | "suffix"; triggerMode: "user" | "assistant" | "both"; alwaysActive: boolean; enabled: boolean }; quickReply?: { label: string; content: string } };

const taskConfig: Record<CharacterDraftTask, { title: string; fields: string[]; instruction: string }> = {
  generate_core_prompt: { title: "Core prompt draft", fields: ["name", "description", "brief"], instruction: "Draft one original core character prompt from the user's points. Cover identity, behaviour, voice, and boundaries without adding system-message wrappers." },
  refine_prompt: { title: "Refined core prompt", fields: ["prompt", "brief"], instruction: "Tighten and reorganize the supplied core prompt while preserving its meaning. Return one replacement prompt." },
  consistency_questions: { title: "Consistency questions", fields: ["name", "prompt"], instruction: "Return concise questions the creator should answer to make the character internally consistent. Do not invent answers." },
  suggest_lore: { title: "Lore drafts", fields: ["prompt", "loreEntries.keys", "brief"], instruction: "Suggest up to five embedded character lore entries. Use only the existing keys/content/priority/scope/triggerMode/alwaysActive/enabled structure." },
  suggest_quick_replies: { title: "Quick reply drafts", fields: ["prompt", "quickReplies.label", "brief"], instruction: "Suggest up to five short user quick replies suitable for starting or steering a single-character conversation." },
  find_contradictions: { title: "Potential contradictions", fields: ["prefix", "prompt", "suffix", "loreEntries"], instruction: "Identify concrete potential contradictions. Treat them as questions or risks, not facts, and do not rewrite data." }
};

export const getCharacterDraftMeta = (task: CharacterDraftTask) => ({ title: taskConfig[task].title, sentFieldCategories: [...taskConfig[task].fields] });

const minimalPayload = (input: CharacterDraftRequest) => {
  const { draft, brief } = input;
  switch (input.task) {
    case "generate_core_prompt": return { name: draft.name, description: draft.description, brief: brief ?? "" };
    case "refine_prompt": return { prompt: draft.prompt, brief: brief ?? "" };
    case "consistency_questions": return { name: draft.name, prompt: draft.prompt };
    case "suggest_lore": return { prompt: draft.prompt, existingKeywords: draft.loreEntries.flatMap((entry) => entry.keys).slice(0, 80), brief: brief ?? "" };
    case "suggest_quick_replies": return { prompt: draft.prompt, existingLabels: draft.quickReplies.map((reply) => reply.label).slice(0, 40), brief: brief ?? "" };
    case "find_contradictions": return { prefix: draft.prefix, prompt: draft.prompt, suffix: draft.suffix, loreEntries: draft.loreEntries.map(({ keys, content, scope, triggerMode, alwaysActive, enabled }) => ({ keys, content, scope, triggerMode, alwaysActive, enabled })).slice(0, 100) };
  }
};

export const buildCharacterDraftMessages = (input: CharacterDraftRequest): ChatCompletionMessage[] => [{ role: "system", content: ["/no_think", "You are a read-only drafting assistant for an original single-user, single-character roleplay application.", "Never claim a draft is true, saved, or applied. Never introduce group chat, standalone lorebooks, or new character fields.", taskConfig[input.task].instruction, "Return JSON only with this shape: {\"items\":[{\"field\":\"prompt|loreEntries|quickReplies|questions|analysis\",\"title\":\"short label\",\"suggestion\":\"reviewable draft\",\"loreEntry\":{\"keys\":[\"key\"],\"content\":\"text\",\"priority\":0,\"scope\":\"prompt\",\"triggerMode\":\"both\",\"alwaysActive\":false,\"enabled\":true},\"quickReply\":{\"label\":\"label\",\"content\":\"text\"}}]}. Omit unrelated optional objects. Maximum 8 items."].join("\n\n") }, { role: "user", content: JSON.stringify(minimalPayload(input)) }];

const text = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";
const stringList = (value: unknown) => Array.isArray(value) ? value.map((item) => text(item, 120)).filter(Boolean).slice(0, 12) : [];
export const parseCharacterDraftItems = (raw: string): CharacterDraftItem[] => {
  const fenced = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  let parsed: unknown;
  try { parsed = JSON.parse(fenced); } catch { throw new Error("Character drafting assistant returned invalid structured data."); }
  const candidates = typeof parsed === "object" && parsed && Array.isArray((parsed as { items?: unknown }).items) ? (parsed as { items: unknown[] }).items : [];
  const items: CharacterDraftItem[] = [];
  for (const candidate of candidates.slice(0, 8)) {
    if (!candidate || typeof candidate !== "object") continue;
    const row = candidate as Record<string, unknown>; const field = text(row.field, 40);
    if (!["prompt", "loreEntries", "quickReplies", "questions", "analysis"].includes(field)) continue;
    const suggestion = text(row.suggestion, 100_000); if (!suggestion) continue;
    const item: CharacterDraftItem = { id: randomUUID(), field: field as CharacterDraftItem["field"], title: text(row.title, 160) || "Draft", suggestion };
    if (field === "loreEntries" && row.loreEntry && typeof row.loreEntry === "object") { const lore = row.loreEntry as Record<string, unknown>; item.loreEntry = { keys: stringList(lore.keys), content: text(lore.content, 100_000) || suggestion, priority: Number.isInteger(lore.priority) ? Number(lore.priority) : 0, scope: ["prefix", "prompt", "suffix"].includes(text(lore.scope, 20)) ? text(lore.scope, 20) as "prefix" | "prompt" | "suffix" : "prompt", triggerMode: ["user", "assistant", "both"].includes(text(lore.triggerMode, 20)) ? text(lore.triggerMode, 20) as "user" | "assistant" | "both" : "both", alwaysActive: lore.alwaysActive === true, enabled: lore.enabled !== false }; }
    if (field === "quickReplies" && row.quickReply && typeof row.quickReply === "object") { const reply = row.quickReply as Record<string, unknown>; const label = text(reply.label, 120); const content = text(reply.content, 10_000) || suggestion; if (label && content) item.quickReply = { label, content }; }
    items.push(item);
  }
  if (!items.length) throw new Error("Character drafting assistant returned no usable draft items.");
  return items;
};
