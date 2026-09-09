import { createHash } from "node:crypto";
import { chatDraftSaveSchema } from "../server-dist/schemas.js";

const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const fail = (status, message, code) => Object.assign(new Error(message), { status, details: code ? { code } : undefined });
const conflict = () => fail(409, "This draft changed in another window. Reload it or explicitly keep your edits.", "draft_conflict");
const draftIdFor = (chatId) => `draft_composer_${createHash("sha256").update(chatId).digest("hex")}`;
const checkChat = (store, chatId, writing = false) => {
  const chat = store.readRecord("chat", chatId);
  if (!chat) throw fail(404, "Chat not found.");
  if (writing && chat.deletedAt) throw fail(409, "Restore this chat before editing its draft.", "chat_in_trash");
};
export const captureDraftPrivacyGuard = (store) => {
  const epoch = store.draftPrivacyState?.().epoch ?? 0;
  const guard = () => {
    const state = store.draftPrivacyState?.();
    if (state?.locked || (state?.epoch ?? 0) !== epoch) throw fail(423, "App is locked.");
  };
  guard();
  return guard;
};
export const getChatDraft = (store, chatId) => {
  const guard = captureDraftPrivacyGuard(store);
  checkChat(store, chatId);
  const row = store.readRecord("chatDraft", chatId);
  const draftId = draftIdFor(chatId);
  const live = new Map(store.listDraftAttachments(draftId).map((item) => [item.id, item.assetId]));
  const attachments = (row?.attachments ?? []).map((item, sortOrder) => {
    const expiresAt = new Date(Date.parse(item.createdAt) + MAX_AGE_MS).toISOString();
    const status = Date.parse(expiresAt) <= Date.now() ? "expired" : live.get(item.id) === item.assetId ? "ready" : "missing";
    return { ...item, sortOrder, draftId, status, expiresAt, url: status === "ready" ? `/api/media/chat-images/${encodeURIComponent(item.assetId)}` : "" };
  });
  guard();
  return { chatId, draftId, version: row?.version ?? 0, content: row?.content ?? "", attachments, updatedAt: row?.updatedAt ?? null };
};

export const saveChatDraft = async (store, chatId, input) => {
  const parsed = chatDraftSaveSchema.safeParse(input);
  if (!parsed.success) throw fail(400, "Request body validation failed");
  const body = parsed.data;
  const guard = captureDraftPrivacyGuard(store);
  const mutationHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return store.atomicWrite(async () => {
    guard();
    checkChat(store, chatId, true);
    const current = store.readRecord("chatDraft", chatId);
    if (current?.lastMutationId === body.mutationId) {
      if (current.lastMutationHash !== mutationHash) throw conflict();
      return getChatDraft(store, chatId);
    }
    if ((current?.version ?? 0) !== body.expectedVersion) throw conflict();
    const draftId = draftIdFor(chatId);
    const oldManifest = new Map((current?.attachments ?? []).map((item) => [item.id, item]));
    const references = new Map(body.attachmentIds.map((id) => [id, store.readRecord("messageAttachment", id)]));
    const attachments = body.attachmentIds.map((id, sortOrder) => {
      const reference = references.get(id);
      const old = oldManifest.get(id);
      if (old) {
        if (reference && (reference.composerChatId !== chatId || reference.messageId)) throw conflict();
        return { ...old, sortOrder };
      }
      if (!reference || reference.messageId || !reference.draftId || reference.composerChatId || reference.handoffId || reference.draftId.startsWith("draft_composer_") || reference.draftId.startsWith("draft_handoff_") || Date.parse(reference.createdAt) + MAX_AGE_MS <= Date.now()) {
        throw fail(409, "A selected image is no longer available. Choose it again.", "draft_attachment_unavailable");
      }
      // Extract metadata in SQL, so autosave never reads/decodes the image's Base64.
      const asset = store.select(`SELECT json_extract(data, '$.mimeType') AS mimeType,
        json_extract(data, '$.byteSize') AS byteSize, json_extract(data, '$.width') AS width,
        json_extract(data, '$.height') AS height, json_extract(data, '$.contentHash') AS contentHash
        FROM records WHERE type = 'mediaAsset' AND id = ?`, [reference.assetId])[0];
      if (!asset) throw fail(409, "A selected image is no longer available. Choose it again.", "draft_attachment_unavailable");
      return { id, assetId: reference.assetId, ...asset, sortOrder, originalFilename: reference.originalFilename, createdAt: reference.createdAt };
    });
    if (attachments.reduce((sum, item) => sum + item.byteSize, 0) > 20 * 1024 * 1024) throw fail(413, "Images in one message can total at most 20 MB.");
    await store.writeRecord("chatDraft", { id: chatId, chatId, draftId, version: body.expectedVersion + 1,
      content: body.content, attachments, lastMutationId: body.mutationId, lastMutationHash: mutationHash, updatedAt: new Date().toISOString() });
    const sameOrder = body.attachmentIds.length === oldManifest.size && body.attachmentIds.every((id, index) => current.attachments[index]?.id === id);
    if (!sameOrder) {
      for (const ref of store.listDraftAttachments(draftId)) if (!body.attachmentIds.includes(ref.id)) await store.deleteRecord("messageAttachment", ref.id);
      for (const [sortOrder, id] of body.attachmentIds.entries()) {
        const ref = references.get(id);
        if (ref) await store.writeRecord("messageAttachment", { ...ref, draftId, composerChatId: chatId, sortOrder });
      }
      await store.cleanupOrphanAssets();
    }
    guard();
    return getChatDraft(store, chatId);
  }, guard);
};
