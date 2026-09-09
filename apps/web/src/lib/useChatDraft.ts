import { useEffect, useSyncExternalStore } from "react";
import { api, ApiRequestError } from "./api";
import { generateId } from "./uuid";
import { useAppStore } from "../store/useAppStore";
import type { ChatDraftAttachmentDTO, ChatDraftDTO, ChatDraftSaveInput, DraftHandoffDTO } from "../types";

type DraftState = "loading" | "saving" | "saved" | "error" | "conflict" | "legacy";
type Entry = {
  id: string; content: string; attachments: ChatDraftAttachmentDTO[]; server: ChatDraftDTO | null;
  revision: number; savedRevision: number; state: DraftState; legacy: string | null; error: string | null;
  timer?: ReturnType<typeof setTimeout>; work?: Promise<void>; abort?: AbortController;
  pending?: { input: ChatDraftSaveInput; revision: number };
  handoffs: DraftHandoffDTO[]; transition: boolean;
  handoffInput?: { id: string; expectedVersion: number; purpose: "send" | "queue" };
  restoreInput?: { id: string; expectedVersion: number; mutationId: string };
};
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let tick = 0;
const emit = () => { tick += 1; listeners.forEach((listener) => listener()); };
const key = (id: string) => `star-companion:chat-draft:${id}`;
const readLegacy = (id: string) => { try { return localStorage.getItem(key(id)); } catch { return null; } };
const forgetLegacy = (entry: Entry) => {
  if (entry.legacy === null) return;
  try { if (localStorage.getItem(key(entry.id)) === entry.legacy) localStorage.removeItem(key(entry.id)); } catch { return; }
  entry.legacy = null;
};
const alive = (entry: Entry) => entries.get(entry.id) === entry && !useAppStore.getState().isPrivacyLocked;
export const clearChatDraftMemory = () => {
  for (const entry of entries.values()) { clearTimeout(entry.timer); entry.abort?.abort(); entry.content = ""; entry.attachments = []; entry.server = null; entry.legacy = null; entry.handoffs = []; entry.pending = undefined; entry.handoffInput = undefined; entry.restoreInput = undefined; }
  entries.clear(); emit();
};
useAppStore.subscribe((state, previous) => { if (state.isPrivacyLocked && !previous.isPrivacyLocked) clearChatDraftMemory(); });
if (typeof window !== "undefined") window.addEventListener("star-companion:privacy-locked", clearChatDraftMemory);
const entryFor = (id: string) => {
  let entry = entries.get(id);
  if (!entry) { entry = { id, content: "", attachments: [], server: null, revision: 0, savedRevision: 0, state: "loading", legacy: null, error: null, handoffs: [], transition: false }; entries.set(id, entry); }
  return entry;
};
const markError = (entry: Entry, error: unknown) => {
  if (!alive(entry)) return;
  if (error instanceof ApiRequestError && error.status === 423) { clearChatDraftMemory(); window.dispatchEvent(new CustomEvent("star-companion:privacy-locked")); return; }
  entry.state = error instanceof ApiRequestError && error.status === 409 ? "conflict" : "error";
  entry.error = error instanceof Error ? error.message : "Draft save failed."; emit();
};
const apply = (entry: Entry, value: ChatDraftDTO) => {
  entry.server = value; entry.content = value.content; entry.attachments = value.attachments;
  entry.revision += 1; entry.savedRevision = entry.revision; entry.pending = undefined; entry.state = "saved"; entry.error = null;
};
const load = async (entry: Entry) => {
  if (entry.work || !alive(entry)) return;
  entry.state = "loading"; const abort = new AbortController(); entry.abort = abort; emit();
  entry.work = (async () => {
    try {
      const [value, handoffs] = await Promise.all([api.chats.getDraft(entry.id, abort.signal), api.chats.listDraftHandoffs(entry.id, abort.signal)]);
      if (!alive(entry)) return;
      apply(entry, value); entry.handoffs = handoffs;
      entry.legacy = readLegacy(entry.id);
      if (entry.legacy !== null && entry.legacy !== "") {
        if (value.content && value.content !== entry.legacy || value.attachments.length > 0) entry.state = "legacy";
        else { entry.content = entry.legacy; entry.revision += 1; entry.state = "saving"; }
      }
      emit();
    } catch (error) { markError(entry, error); }
  })().finally(() => { entry.work = undefined; });
  await entry.work;
  if (alive(entry) && entry.server && entry.revision !== entry.savedRevision && entry.legacy === entry.content) await flush(entry);
};
const flush = async (entry: Entry): Promise<void> => {
  clearTimeout(entry.timer);
  if (entry.work) await entry.work;
  if (!alive(entry)) throw new Error("App is locked.");
  if (!entry.server) { await load(entry); if (!entry.server) throw new Error("Draft unavailable."); }
  if (["conflict", "legacy"].includes(entry.state)) throw new Error("Resolve the draft conflict before continuing.");
  if (entry.transition) throw new Error("Finish the pending draft operation first.");
  if (entry.revision === entry.savedRevision) return;
  const abort = new AbortController(); entry.abort = abort; entry.state = "saving"; entry.error = null; emit();
  entry.work = (async () => {
    while (alive(entry) && entry.savedRevision !== entry.revision) {
      const pending = entry.pending ?? { revision: entry.revision, input: { expectedVersion: entry.server!.version, mutationId: generateId(), content: entry.content, attachmentIds: entry.attachments.map((item) => item.id) } };
      entry.pending = pending;
      const saved = await api.chats.saveDraft(entry.id, pending.input, abort.signal);
      if (!alive(entry)) return;
      entry.server = saved; entry.savedRevision = pending.revision; entry.pending = undefined;
      const metadata = new Map(saved.attachments.map((item) => [item.id, item]));
      entry.attachments = entry.attachments.map((item, sortOrder) => ({ ...(metadata.get(item.id) ?? item), sortOrder }));
      if (pending.input.content === entry.legacy) forgetLegacy(entry);
    }
    if (alive(entry)) { entry.state = "saved"; entry.error = null; emit(); }
  })().catch((error) => { markError(entry, error); throw error; }).finally(() => { entry.work = undefined; });
  await entry.work;
};
const edit = (entry: Entry, change: Partial<Pick<Entry, "content" | "attachments">>) => {
  if (!alive(entry) || !entry.server || entry.transition || entry.handoffInput || entry.restoreInput) return;
  Object.assign(entry, change); entry.revision += 1;
  clearTimeout(entry.timer);
  if (!["legacy", "conflict"].includes(entry.state)) {
    entry.state = "saving";
    entry.timer = setTimeout(() => void flush(entry).catch(() => {}), 350);
  }
  emit();
};
const refreshHandoffs = async (entry: Entry) => {
  try { const rows = await api.chats.listDraftHandoffs(entry.id); if (alive(entry)) { entry.handoffs = rows; emit(); } } catch (error) { markError(entry, error); }
};

const finishHandoff = async (entry: Entry) => {
  if (!entry.handoffInput) throw new Error("No pending draft operation.");
  entry.transition = true; emit(); const abort = new AbortController(); entry.abort = abort;
  try {
    const result = await api.chats.createDraftHandoff(entry.id, entry.handoffInput, abort.signal);
    if (!alive(entry)) throw new Error("App is locked.");
    apply(entry, result.draft); entry.handoffInput = undefined;
    entry.handoffs = [...entry.handoffs.filter((item) => item.id !== result.handoff.id), result.handoff];
    return result.handoff;
  } catch (error) {
    if (error instanceof ApiRequestError && error.status >= 400 && error.status < 500) entry.handoffInput = undefined;
    markError(entry, error); throw error;
  } finally { if (alive(entry)) { entry.transition = false; emit(); } }
};

const finishRestore = async (entry: Entry) => {
  const input = entry.restoreInput;
  if (!input) throw new Error("No pending restore operation.");
  entry.transition = true; emit(); const abort = new AbortController(); entry.abort = abort;
  try {
    const result = await api.chats.restoreDraftHandoff(entry.id, input.id, { expectedVersion: input.expectedVersion, mutationId: input.mutationId }, abort.signal);
    if (!alive(entry)) return;
    entry.restoreInput = undefined; apply(entry, result); await refreshHandoffs(entry);
  } catch (error) {
    if (error instanceof ApiRequestError && error.status >= 400 && error.status < 500) entry.restoreInput = undefined;
    markError(entry, error); throw error;
  } finally { if (alive(entry)) { entry.transition = false; emit(); } }
};

export const useChatDraft = (chatId: string | null) => {
  useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => tick);
  const entry = chatId ? entryFor(chatId) : null;
  useEffect(() => {
    if (!entry) return;
    if (!entry.server) void load(entry).catch(() => {});
    else void refreshHandoffs(entry);
    return () => { if (alive(entry) && entry.server && !entry.transition) void flush(entry).catch(() => {}); };
  }, [entry]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!entry || !alive(entry)) return;
      let changed = false;
      entry.attachments = entry.attachments.map((item) => {
        if (item.status === "ready" && Date.parse(item.expiresAt) <= Date.now()) { changed = true; return { ...item, status: "expired", url: "" }; }
        return item;
      });
      if (changed) emit();
    }, 15_000);
    const beforeLeave = (event: BeforeUnloadEvent) => {
      if ([...entries.values()].some((item) => alive(item) && (item.revision !== item.savedRevision || item.transition))) {
        event.preventDefault(); event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeLeave);
    return () => { clearInterval(timer); window.removeEventListener("beforeunload", beforeLeave); };
  }, [entry]);
  return {
    content: entry?.content ?? "", attachments: entry?.attachments ?? [], state: entry?.state ?? "loading",
    error: entry?.error ?? null, savedAt: entry?.server?.updatedAt ?? null,
    disabled: !entry?.server || !!entry?.transition || !!entry?.handoffInput || !!entry?.restoreInput, handoffs: entry?.handoffs ?? [], legacy: entry?.legacy ?? null,
    setText: (value: string | ((previous: string) => string)) => { if (entry) edit(entry, { content: typeof value === "function" ? value(entry.content) : value }); },
    setImages: (images: ChatDraftAttachmentDTO[]) => { if (entry) edit(entry, { attachments: images }); },
    addImage: (image: ChatDraftAttachmentDTO) => { if (entry) edit(entry, { attachments: [...entry.attachments, image] }); },
    markImageUnavailable: (id: string) => {
      if (!entry || !alive(entry)) return;
      entry.attachments = entry.attachments.map((image) => image.id === id && image.status === "ready" ? { ...image, status: "missing", url: "" } : image);
      emit();
    },
    flush: async () => { if (entry) await flush(entry); },
    retry: async () => { if (entry) { if (entry.restoreInput) await finishRestore(entry); else if (entry.handoffInput) await finishHandoff(entry); else if (!entry.server) await load(entry); else await flush(entry); } },
    resolve: async (choice: "reload" | "keep" | "legacy") => {
      if (!entry) return;
      const remote = await api.chats.getDraft(entry.id);
      if (!alive(entry)) return;
      if (choice === "reload") { forgetLegacy(entry); apply(entry, remote); emit(); return; }
      entry.server = remote; entry.pending = undefined;
      if (choice === "legacy") entry.content = entry.legacy ?? entry.content;
      entry.revision += 1; entry.state = "saving"; emit(); await flush(entry);
      if (choice === "keep") forgetLegacy(entry);
    },
    clear: async () => { if (entry) { edit(entry, { content: "", attachments: [] }); await flush(entry); } },
    refreshHandoffs: () => entry ? refreshHandoffs(entry) : Promise.resolve(),
    createHandoff: async (purpose: "send" | "queue") => {
      if (!entry) throw new Error("Select a chat.");
      if (!entry.handoffInput) {
        await flush(entry);
        entry.handoffInput = { id: generateId(), expectedVersion: entry.server!.version, purpose };
      }
      return finishHandoff(entry);
    },
    restore: async (id: string) => {
      if (!entry) return;
      if (!entry.restoreInput) {
        await flush(entry);
        entry.restoreInput = { id, expectedVersion: entry.server!.version, mutationId: generateId() };
      }
      await finishRestore(entry);
    },
    discard: async (id: string) => { if (entry) { await api.chats.discardDraftHandoff(entry.id, id); await refreshHandoffs(entry); } }
  };
};
