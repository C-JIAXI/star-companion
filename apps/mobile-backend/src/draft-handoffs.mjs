import { draftHandoffCreateSchema, draftHandoffRestoreSchema } from "../server-dist/schemas.js";
import { captureDraftPrivacyGuard, getChatDraft } from "./chat-drafts.mjs";

const fail = (status, message, code) => Object.assign(new Error(message), { status, details: code ? { code } : undefined });
const conflict = () => fail(409, "The draft or pending send changed. Reload before continuing.", "draft_conflict");
const parse = (schema, input) => { const parsed = schema.safeParse(input); if (!parsed.success) throw fail(400, "Request body validation failed"); return parsed.data; };
const active = (store, chatId) => {
  const chat = store.readRecord("chat", chatId);
  if (!chat) throw fail(404, "Chat not found.");
  if (chat.deletedAt) throw fail(409, "Restore this chat before editing its draft.", "chat_in_trash");
};
const find = (store, chatId, id) => { const row = store.readRecord("draftHandoff", id); if (!row || row.chatId !== chatId) throw fail(404, "Pending draft not found."); return row; };
const serialize = (store, row) => {
  const draftId = `draft_handoff_${row.id}`;
  const live = new Map(store.listDraftAttachments(draftId).map((item) => [item.id, item.assetId]));
  const attachments = row.attachments.map((item, sortOrder) => {
    const expiresAt = new Date(Date.parse(item.createdAt) + 24 * 60 * 60 * 1000).toISOString();
    const status = Date.parse(expiresAt) <= Date.now() ? "expired" : live.get(item.id) === item.assetId ? "ready" : "missing";
    return { ...item, draftId, sortOrder, expiresAt, status, url: status === "ready" ? `/api/media/chat-images/${encodeURIComponent(item.assetId)}` : "" };
  });
  return { id: row.id, chatId: row.chatId, draftId, content: row.content, attachments, purpose: row.purpose,
    messageId: row.messageId ?? null, createdAt: row.createdAt, committedAt: row.committedAt ?? null, disposedAt: row.disposedAt ?? null };
};
export const getDraftHandoff = (store, chatId, id) => { captureDraftPrivacyGuard(store); return serialize(store, find(store, chatId, id)); };
export const listDraftHandoffs = (store, chatId) => {
  captureDraftPrivacyGuard(store);
  if (!store.readRecord("chat", chatId)) throw fail(404, "Chat not found.");
  return store.readRecords("draftHandoff", "AND chatId = ?", [chatId], "ORDER BY createdAt ASC").filter((row) => !row.committedAt && !row.disposedAt).map((row) => serialize(store, row));
};
export const createDraftHandoff = async (store, chatId, input) => {
  const body = parse(draftHandoffCreateSchema, input), guard = captureDraftPrivacyGuard(store);
  return store.atomicWrite(async () => {
    guard(); active(store, chatId);
    const existing = store.readRecord("draftHandoff", body.id);
    if (existing) {
      if (existing.chatId !== chatId || existing.originVersion !== body.expectedVersion || existing.purpose !== body.purpose) throw conflict();
      return { draft: getChatDraft(store, chatId), handoff: serialize(store, existing) };
    }
    const current = store.readRecord("chatDraft", chatId);
    if (!current || current.version !== body.expectedVersion) throw conflict();
    if (!current.content.trim() && !current.attachments.length) throw fail(400, "The draft is empty.");
    if (listDraftHandoffs(store, chatId).length >= 100) throw fail(409, "Review pending drafts before creating more.");
    if (getChatDraft(store, chatId).attachments.some((item) => item.status !== "ready")) throw fail(409, "Remove or replace unavailable images before sending.", "draft_attachment_unavailable");
    const handoff = { id: body.id, chatId, originVersion: body.expectedVersion, purpose: body.purpose, content: current.content,
      attachments: current.attachments, createdAt: new Date().toISOString(), committedAt: null, disposedAt: null, messageId: null };
    await store.writeRecord("draftHandoff", handoff);
    for (const ref of store.listDraftAttachments(current.draftId)) await store.writeRecord("messageAttachment", { ...ref, composerChatId: null, handoffId: body.id, draftId: `draft_handoff_${body.id}` });
    await store.writeRecord("chatDraft", { ...current, version: current.version + 1, content: "", attachments: [], lastMutationId: `handoff-${body.id}`, lastMutationHash: "", updatedAt: new Date().toISOString() });
    return { draft: getChatDraft(store, chatId), handoff: serialize(store, handoff) };
  }, guard);
};
export const restoreDraftHandoff = async (store, chatId, id, input) => {
  const body = parse(draftHandoffRestoreSchema, input), guard = captureDraftPrivacyGuard(store);
  return store.atomicWrite(async () => {
    guard(); active(store, chatId);
    const row = find(store, chatId, id), current = store.readRecord("chatDraft", chatId);
    if (row.disposition === "restored" && row.restoreMutationId === body.mutationId) return getChatDraft(store, chatId);
    if (row.committedAt || row.disposedAt || !current || current.version !== body.expectedVersion) throw conflict();
    for (const ref of store.listDraftAttachments(current.draftId)) await store.deleteRecord("messageAttachment", ref.id);
    await store.writeRecord("chatDraft", { ...current, content: row.content, attachments: row.attachments, version: current.version + 1, lastMutationId: body.mutationId, lastMutationHash: "restored", updatedAt: new Date().toISOString() });
    for (const ref of store.listDraftAttachments(`draft_handoff_${id}`)) await store.writeRecord("messageAttachment", { ...ref, handoffId: null, composerChatId: chatId, draftId: current.draftId });
    await store.writeRecord("draftHandoff", { ...row, content: "", attachments: [], disposedAt: new Date().toISOString(), disposition: "restored", restoreMutationId: body.mutationId });
    await store.cleanupOrphanAssets();
    return getChatDraft(store, chatId);
  }, guard);
};
export const discardDraftHandoff = async (store, chatId, id) => {
  const guard = captureDraftPrivacyGuard(store);
  return store.atomicWrite(async () => {
    const row = find(store, chatId, id);
    if (row.committedAt || row.disposedAt) return;
    for (const ref of store.listDraftAttachments(`draft_handoff_${id}`)) await store.deleteRecord("messageAttachment", ref.id);
    await store.writeRecord("draftHandoff", { ...row, content: "", attachments: [], disposedAt: new Date().toISOString(), disposition: "discarded" });
    await store.cleanupOrphanAssets();
  }, guard);
};
export const consumeDraftHandoff = async (store, chatId, id) => {
  const guard = captureDraftPrivacyGuard(store);
  return store.atomicWrite(async () => {
    active(store, chatId); const row = find(store, chatId, id);
    if (row.committedAt) {
      const message = store.getMessage(row.messageId);
      if (!message) throw fail(409, "This draft was already sent; its message is no longer available.", "draft_already_sent");
      return { message, replayed: true };
    }
    if (row.disposedAt) throw conflict();
    if (serialize(store, row).attachments.some((item) => item.status !== "ready")) throw fail(409, "Remove or replace unavailable images before sending.", "draft_attachment_unavailable");
    const message = await store.createMessage({ chatId, role: "user", content: row.content }, false);
    for (const ref of store.listDraftAttachments(`draft_handoff_${id}`)) await store.writeRecord("messageAttachment", { ...ref, handoffId: null, draftId: null, messageId: message.id });
    await store.writeRecord("draftHandoff", { ...row, messageId: message.id, committedAt: new Date().toISOString(), content: "", attachments: [] });
    return { message, replayed: false };
  }, guard);
};
