import { createHash } from "node:crypto";
import type { ChatDraft, Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { HttpError } from "../lib/http.js";
import { chatDraftSaveSchema } from "../schemas.js";
import { deleteUnreferencedAssets, MAX_MESSAGE_IMAGE_BYTES } from "./messageAttachments.js";
import { getPrivacyEpoch, isPrivacyLocked } from "./privacyLock.js";

export const MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Reserve this namespace so legacy media mutations cannot bypass composer CAS.
export const composerDraftId = (chatId: string) => `draft_composer_${createHash("sha256").update(chatId).digest("hex")}`;
export const checkDraftLock = (epoch: number) => {
  if (isPrivacyLocked() || getPrivacyEpoch() !== epoch) throw new HttpError(423, "App is locked.");
};
const checkLock = checkDraftLock;
const conflict = () => new HttpError(409, "This draft changed in another window. Reload it or explicitly keep your edits.", { code: "draft_conflict" });
const attachmentSelect = {
  id: true, assetId: true, draftId: true, composerChatId: true, handoffId: true, messageId: true,
  sortOrder: true, originalFilename: true, createdAt: true,
  asset: { select: { mimeType: true, byteSize: true, width: true, height: true, contentHash: true } }
} satisfies Prisma.MessageAttachmentSelect;
export type ManifestEntry = {
  id: string; assetId: string; mimeType: "image/png" | "image/jpeg";
  byteSize: number; width: number; height: number; contentHash: string;
  sortOrder: number; originalFilename: string | null; createdAt: string;
};
export const manifestOf = (row: { attachments: Prisma.JsonValue } | null): ManifestEntry[] => (row?.attachments ?? []) as ManifestEntry[];
export const ensureDraftChat = async (tx: Prisma.TransactionClient, chatId: string, writing = false) => {
  const chat = await tx.chat.findUnique({ where: { id: chatId }, select: { deletedAt: true } });
  if (!chat) throw new HttpError(404, "Chat not found.");
  if (writing && chat.deletedAt) throw new HttpError(409, "Restore this chat before editing its draft.", { code: "chat_in_trash" });
};
const ensureChat = ensureDraftChat;
export const serializeDraft = async (tx: Prisma.TransactionClient, chatId: string, row: ChatDraft | null) => {
  const draftId = composerDraftId(chatId);
  const live = await tx.messageAttachment.findMany({ where: { composerChatId: chatId, messageId: null }, select: { id: true, assetId: true } });
  const liveById = new Map(live.map((item) => [item.id, item.assetId]));
  const attachments = manifestOf(row).map((item, sortOrder) => {
    const expiresAt = new Date(new Date(item.createdAt).getTime() + MAX_AGE_MS).toISOString();
    const status: "ready" | "expired" | "missing" = Date.parse(expiresAt) <= Date.now() ? "expired"
      : liveById.get(item.id) === item.assetId ? "ready" : "missing";
    return { ...item, sortOrder, draftId, expiresAt, status,
      url: status === "ready" ? `/api/media/chat-images/${encodeURIComponent(item.assetId)}` : "" };
  });
  return { chatId, draftId, version: row?.version ?? 0, content: row?.content ?? "", attachments, updatedAt: row?.updatedAt.toISOString() ?? null };
};

/** Read-only: never creates a row or refreshes an attachment's expiry. */
export const getChatDraft = async (chatId: string) => {
  const epoch = getPrivacyEpoch();
  checkLock(epoch);
  return prisma.$transaction(async (tx) => {
    await ensureChat(tx, chatId);
    const result = await serializeDraft(tx, chatId, await tx.chatDraft.findUnique({ where: { chatId } }));
    checkLock(epoch);
    return result;
  });
};

/** Compare-and-swap metadata only. Retried acknowledgements reuse one mutation identity. */
export const saveChatDraft = async (chatId: string, input: unknown) => {
  const body = chatDraftSaveSchema.parse(input);
  const epoch = getPrivacyEpoch();
  checkLock(epoch);
  const mutationHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return prisma.$transaction(async (tx) => {
    checkLock(epoch);
    await ensureChat(tx, chatId, true);
    const current = await tx.chatDraft.findUnique({ where: { chatId } });
    if (current?.lastMutationId === body.mutationId) {
      if (current.lastMutationHash !== mutationHash) throw conflict();
      const result = await serializeDraft(tx, chatId, current);
      checkLock(epoch);
      return result;
    }
    if ((current?.version ?? 0) !== body.expectedVersion) throw conflict();
    const draftId = composerDraftId(chatId);
    const oldManifest = new Map(manifestOf(current).map((item) => [item.id, item]));
    const refs = await tx.messageAttachment.findMany({ where: { id: { in: body.attachmentIds } }, select: attachmentSelect });
    const byId = new Map(refs.map((item) => [item.id, item]));
    const manifest = body.attachmentIds.map((id, sortOrder): ManifestEntry => {
      const reference = byId.get(id);
      const old = oldManifest.get(id);
      // Missing/expired items already owned by this composer remain removable placeholders.
      if (old) {
        if (reference && (reference.composerChatId !== chatId || reference.messageId)) throw conflict();
        return { ...old, sortOrder };
      }
      if (!reference || reference.messageId || !reference.draftId || reference.composerChatId || reference.handoffId || reference.draftId.startsWith("draft_composer_") || reference.draftId.startsWith("draft_handoff_") || reference.createdAt.getTime() + MAX_AGE_MS <= Date.now()) {
        throw new HttpError(409, "A selected image is no longer available. Choose it again.", { code: "draft_attachment_unavailable" });
      }
      return { id, assetId: reference.assetId, sortOrder, createdAt: reference.createdAt.toISOString(), originalFilename: reference.originalFilename,
        ...reference.asset, mimeType: reference.asset.mimeType as "image/png" | "image/jpeg" };
    });
    if (manifest.reduce((sum, item) => sum + item.byteSize, 0) > MAX_MESSAGE_IMAGE_BYTES) throw new HttpError(413, "Images in one message can total at most 20 MB.");
    const data = { draftId, version: body.expectedVersion + 1, content: body.content, attachments: manifest,
      lastMutationId: body.mutationId, lastMutationHash: mutationHash };
    if (!current) await tx.chatDraft.create({ data: { chatId, ...data } });
    else {
      const changed = await tx.chatDraft.updateMany({ where: { chatId, version: body.expectedVersion }, data });
      if (changed.count !== 1) throw conflict();
    }
    const sameOrder = body.attachmentIds.length === oldManifest.size && body.attachmentIds.every((id, index) => manifestOf(current)[index]?.id === id);
    if (!sameOrder) {
      await tx.messageAttachment.deleteMany({ where: { composerChatId: chatId, id: { notIn: body.attachmentIds } } });
      // Vacate unique positions before moving references, never copy asset bytes.
      for (const [index, id] of body.attachmentIds.entries()) {
        if (byId.has(id)) await tx.messageAttachment.update({ where: { id }, data: { sortOrder: -index - 1 } });
      }
      for (const [index, id] of body.attachmentIds.entries()) {
        if (byId.has(id)) await tx.messageAttachment.update({ where: { id }, data: { draftId, composerChatId: chatId, sortOrder: index } });
      }
      await deleteUnreferencedAssets(tx);
    }
    const result = await serializeDraft(tx, chatId, await tx.chatDraft.findUnique({ where: { chatId } }));
    checkLock(epoch);
    return result;
  });
};
