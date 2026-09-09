import type { DraftHandoff, Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { HttpError } from "../lib/http.js";
import { draftHandoffCreateSchema, draftHandoffRestoreSchema } from "../schemas.js";
import { checkDraftLock, composerDraftId, ensureDraftChat, manifestOf, MAX_AGE_MS, serializeDraft } from "./chatDrafts.js";
import { deleteUnreferencedAssets, messageIncludeAttachments } from "./messageAttachments.js";
import { getPrivacyEpoch } from "./privacyLock.js";

const handoffDraftId = (id: string) => `draft_handoff_${id}`;
const conflict = () => new HttpError(409, "The draft or pending send changed. Reload before continuing.", { code: "draft_conflict" });
const find = async (tx: Prisma.TransactionClient, chatId: string, id: string) => {
  const row = await tx.draftHandoff.findFirst({ where: { id, chatId } });
  if (!row) throw new HttpError(404, "Pending draft not found.");
  return row;
};
const serialize = async (tx: Prisma.TransactionClient, row: DraftHandoff) => {
  const references = await tx.messageAttachment.findMany({ where: { handoffId: row.id }, select: { id: true, assetId: true } });
  const live = new Map(references.map((ref) => [ref.id, ref.assetId]));
  const draftId = handoffDraftId(row.id);
  const attachments = manifestOf(row).map((item, sortOrder) => {
    const expiresAt = new Date(Date.parse(item.createdAt) + MAX_AGE_MS).toISOString();
    const status: "expired" | "ready" | "missing" = Date.parse(expiresAt) <= Date.now() ? "expired" : live.get(item.id) === item.assetId ? "ready" : "missing";
    return { ...item, sortOrder, draftId, expiresAt, status, url: status === "ready" ? `/api/media/chat-images/${encodeURIComponent(item.assetId)}` : "" };
  });
  return { id: row.id, chatId: row.chatId, draftId, content: row.content, attachments, purpose: row.purpose as "send" | "queue",
    messageId: row.messageId, createdAt: row.createdAt.toISOString(), committedAt: row.committedAt?.toISOString() ?? null,
    disposedAt: row.disposedAt?.toISOString() ?? null };
};
export const getDraftHandoff = async (chatId: string, id: string) => {
  const epoch = getPrivacyEpoch(); checkDraftLock(epoch);
  const result = await prisma.$transaction(async (tx) => serialize(tx, await find(tx, chatId, id)));
  checkDraftLock(epoch); return result;
};
export const listDraftHandoffs = async (chatId: string) => {
  const epoch = getPrivacyEpoch(); checkDraftLock(epoch);
  const result = await prisma.$transaction(async (tx) => {
    await ensureDraftChat(tx, chatId);
    const rows = await tx.draftHandoff.findMany({ where: { chatId, committedAt: null, disposedAt: null }, orderBy: { createdAt: "asc" } });
    return Promise.all(rows.map((row) => serialize(tx, row)));
  });
  checkDraftLock(epoch); return result;
};
export const createDraftHandoff = async (chatId: string, input: unknown) => {
  const body = draftHandoffCreateSchema.parse(input);
  const epoch = getPrivacyEpoch(); checkDraftLock(epoch);
  return prisma.$transaction(async (tx) => {
    checkDraftLock(epoch); await ensureDraftChat(tx, chatId, true);
    const existing = await tx.draftHandoff.findUnique({ where: { id: body.id } });
    if (existing) {
      if (existing.chatId !== chatId || existing.originVersion !== body.expectedVersion || existing.purpose !== body.purpose) throw conflict();
      const result = { draft: await serializeDraft(tx, chatId, await tx.chatDraft.findUnique({ where: { chatId } })), handoff: await serialize(tx, existing) };
      checkDraftLock(epoch); return result;
    }
    const current = await tx.chatDraft.findUnique({ where: { chatId } });
    if (!current || current.version !== body.expectedVersion) throw conflict();
    if (!current.content.trim() && manifestOf(current).length === 0) throw new HttpError(400, "The draft is empty.");
    const pending = await tx.draftHandoff.count({ where: { chatId, committedAt: null, disposedAt: null } });
    if (pending >= 100) throw new HttpError(409, "Review pending drafts before creating more.");
    const preview = await serializeDraft(tx, chatId, current);
    if (preview.attachments.some((item) => item.status !== "ready")) throw new HttpError(409, "Remove or replace unavailable images before sending.", { code: "draft_attachment_unavailable" });
    const handoff = await tx.draftHandoff.create({ data: { id: body.id, chatId, originVersion: body.expectedVersion, purpose: body.purpose,
      content: current.content, attachments: current.attachments as Prisma.InputJsonValue } });
    await tx.messageAttachment.updateMany({ where: { composerChatId: chatId }, data: { composerChatId: null, handoffId: body.id, draftId: handoffDraftId(body.id) } });
    await tx.chatDraft.update({ where: { chatId }, data: { content: "", attachments: [], version: { increment: 1 }, lastMutationId: `handoff-${body.id}`, lastMutationHash: "" } });
    const result = { draft: await serializeDraft(tx, chatId, await tx.chatDraft.findUnique({ where: { chatId } })), handoff: await serialize(tx, handoff) };
    checkDraftLock(epoch); return result;
  });
};
export const restoreDraftHandoff = async (chatId: string, id: string, input: unknown) => {
  const body = draftHandoffRestoreSchema.parse(input);
  const epoch = getPrivacyEpoch(); checkDraftLock(epoch);
  return prisma.$transaction(async (tx) => {
    checkDraftLock(epoch); await ensureDraftChat(tx, chatId, true);
    const handoff = await find(tx, chatId, id);
    const current = await tx.chatDraft.findUnique({ where: { chatId } });
    if (handoff.disposition === "restored" && handoff.restoreMutationId === body.mutationId) {
      const result = await serializeDraft(tx, chatId, current); checkDraftLock(epoch); return result;
    }
    if (handoff.committedAt || handoff.disposedAt || !current || current.version !== body.expectedVersion) throw conflict();
    await tx.messageAttachment.deleteMany({ where: { composerChatId: chatId } });
    await tx.chatDraft.update({ where: { chatId }, data: { content: handoff.content, attachments: handoff.attachments as Prisma.InputJsonValue,
      version: { increment: 1 }, lastMutationId: body.mutationId, lastMutationHash: "restored" } });
    await tx.messageAttachment.updateMany({ where: { handoffId: id }, data: { handoffId: null, composerChatId: chatId, draftId: composerDraftId(chatId) } });
    await tx.draftHandoff.update({ where: { id }, data: { content: "", attachments: [], disposedAt: new Date(), disposition: "restored", restoreMutationId: body.mutationId } });
    await deleteUnreferencedAssets(tx);
    const result = await serializeDraft(tx, chatId, await tx.chatDraft.findUnique({ where: { chatId } })); checkDraftLock(epoch); return result;
  });
};
export const discardDraftHandoff = async (chatId: string, id: string) => {
  const epoch = getPrivacyEpoch(); checkDraftLock(epoch);
  await prisma.$transaction(async (tx) => {
    checkDraftLock(epoch); const row = await find(tx, chatId, id);
    if (row.committedAt || row.disposedAt) return;
    await tx.messageAttachment.deleteMany({ where: { handoffId: id } });
    await tx.draftHandoff.update({ where: { id }, data: { content: "", attachments: [], disposedAt: new Date(), disposition: "discarded" } });
    await deleteUnreferencedAssets(tx); checkDraftLock(epoch);
  });
};

/** A receipt survives ledger pruning and message deletion. Replays never create another message. */
export const consumeDraftHandoff = async (chatId: string, id: string) => {
  const epoch = getPrivacyEpoch(); checkDraftLock(epoch);
  return prisma.$transaction(async (tx) => {
    checkDraftLock(epoch); await ensureDraftChat(tx, chatId, true);
    const row = await find(tx, chatId, id);
    if (row.committedAt) {
      const message = row.messageId ? await tx.message.findUnique({ where: { id: row.messageId }, include: messageIncludeAttachments }) : null;
      if (!message) throw new HttpError(409, "This draft was already sent; its message is no longer available.", { code: "draft_already_sent" });
      checkDraftLock(epoch); return { message, replayed: true };
    }
    if (row.disposedAt) throw conflict();
    const snapshot = await serialize(tx, row);
    if (snapshot.attachments.some((item) => item.status !== "ready")) throw new HttpError(409, "Remove or replace unavailable images before sending.", { code: "draft_attachment_unavailable" });
    const message = await tx.message.create({ data: { chatId, role: "user", content: row.content } });
    await tx.messageAttachment.updateMany({ where: { handoffId: id }, data: { handoffId: null, draftId: null, messageId: message.id } });
    await tx.draftHandoff.update({ where: { id }, data: { messageId: message.id, committedAt: new Date(), content: "", attachments: [] } });
    await tx.chat.update({ where: { id: chatId }, data: { updatedAt: new Date() } });
    const result = await tx.message.findUniqueOrThrow({ where: { id: message.id }, include: messageIncludeAttachments });
    checkDraftLock(epoch); return { message: result, replayed: false };
  });
};
