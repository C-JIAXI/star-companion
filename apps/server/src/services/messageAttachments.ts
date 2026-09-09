import type { MediaAsset, MessageAttachment, Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { prisma } from "../db.js";
import { HttpError } from "../lib/http.js";
import { ImageValidationError, MAX_MESSAGE_IMAGE_BYTES, normalizeUploadedImage as normalizeImage, type SupportedImageMime } from "./imageNormalization.js";
import { assertStorageCapacity } from "./storageHealth.js";
import { assertUnmanagedDraftId } from "./draftOwnership.js";
import { getPrivacyEpoch, isPrivacyLocked } from "./privacyLock.js";

export { MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, MAX_MESSAGE_IMAGE_BYTES } from "./imageNormalization.js";
export const normalizeUploadedImage = (input: Parameters<typeof normalizeImage>[0]) => {
  try { return normalizeImage(input); }
  catch (error) { if (error instanceof ImageValidationError) throw new HttpError(error.status, error.message); throw error; }
};

export const MAX_MESSAGE_IMAGES = 4;
const DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

type SupportedMime = SupportedImageMime;
export type AttachmentWithAsset = MessageAttachment & { asset: MediaAsset };

const cleanFilename = (value?: string) => {
  if (!value) return null;
  const cleaned = value
    .replace(/[\\/\0-\x1f\x7f<>:"|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return cleaned || null;
};

export const serializeAttachment = (attachment: AttachmentWithAsset) => ({
  id: attachment.id,
  assetId: attachment.assetId,
  mimeType: attachment.asset.mimeType as SupportedMime,
  byteSize: attachment.asset.byteSize,
  width: attachment.asset.width,
  height: attachment.asset.height,
  contentHash: attachment.asset.contentHash,
  sortOrder: attachment.sortOrder,
  originalFilename: attachment.originalFilename,
  createdAt: attachment.createdAt.toISOString(),
  url: `/api/media/chat-images/${encodeURIComponent(attachment.assetId)}`
});

export const deleteUnreferencedAssets = async (tx: Prisma.TransactionClient) => {
  await tx.mediaAsset.deleteMany({ where: { attachments: { none: {} }, recoveryPoints: { none: {} } } });
};

export const cleanupExpiredDraftAttachments = async (tx: Prisma.TransactionClient = prisma) => {
  const cutoff = new Date(Date.now() - DRAFT_MAX_AGE_MS);
  const removed = await tx.messageAttachment.deleteMany({ where: { messageId: null, draftId: { not: null }, createdAt: { lt: cutoff } } });
  await deleteUnreferencedAssets(tx);
  return removed.count;
};

export const uploadDraftImage = async (input: {
  draftId: string;
  dataBase64: string;
  mimeType: SupportedMime;
  originalFilename?: string;
}) => {
  assertUnmanagedDraftId(input.draftId);
  const epoch = getPrivacyEpoch();
  const checkLock = () => {
    if (isPrivacyLocked() || epoch !== getPrivacyEpoch()) throw new HttpError(423, "App is locked.");
  };
  checkLock();
  await assertStorageCapacity(Math.ceil(input.dataBase64.length * 0.75));
  const normalized = normalizeUploadedImage(input);
  const contentHash = createHash("sha256").update(normalized.data).digest("hex");
  return prisma.$transaction(async (tx) => {
    checkLock();
    await cleanupExpiredDraftAttachments(tx);
    const existing = await tx.messageAttachment.findMany({ where: { draftId: input.draftId, messageId: null }, include: { asset: true }, orderBy: { sortOrder: "asc" } });
    if (existing.length >= MAX_MESSAGE_IMAGES) throw new HttpError(413, "A message can contain at most 4 images.");
    if (existing.reduce((total, item) => total + item.asset.byteSize, 0) + normalized.data.length > MAX_MESSAGE_IMAGE_BYTES) {
      throw new HttpError(413, "Images in one message can total at most 20 MB.");
    }
    const asset = await tx.mediaAsset.upsert({
      where: { contentHash },
      create: { contentHash, mimeType: normalized.mimeType, byteSize: normalized.data.length, width: normalized.width, height: normalized.height, storageKey: `sha256:${contentHash}`, data: new Uint8Array(normalized.data) },
      update: {}
    });
    const attachment = await tx.messageAttachment.create({
      data: { draftId: input.draftId, assetId: asset.id, sortOrder: existing.length, originalFilename: cleanFilename(input.originalFilename) },
      include: { asset: true }
    });
    checkLock();
    return { ...serializeAttachment(attachment), draftId: input.draftId, status: "ready" as const };
  });
};

export const listDraftAttachments = (draftId: string) => prisma.messageAttachment.findMany({ where: { draftId, messageId: null }, include: { asset: true }, orderBy: { sortOrder: "asc" } });

export const removeDraftAttachment = async (draftId: string, attachmentId: string) => prisma.$transaction(async (tx) => {
  assertUnmanagedDraftId(draftId);
  const attachment = await tx.messageAttachment.findFirst({ where: { id: attachmentId, draftId, messageId: null } });
  if (!attachment) throw new HttpError(404, "Draft image not found.");
  await tx.messageAttachment.delete({ where: { id: attachment.id } });
  const remaining = await tx.messageAttachment.findMany({ where: { draftId, messageId: null }, orderBy: { sortOrder: "asc" } });
  for (const [sortOrder, item] of remaining.entries()) await tx.messageAttachment.update({ where: { id: item.id }, data: { sortOrder: -(sortOrder + 1) } });
  for (const [sortOrder, item] of remaining.entries()) await tx.messageAttachment.update({ where: { id: item.id }, data: { sortOrder } });
  await deleteUnreferencedAssets(tx);
});

export const reorderDraftAttachments = async (draftId: string, attachmentIds: string[]) => prisma.$transaction(async (tx) => {
  assertUnmanagedDraftId(draftId);
  const current = await tx.messageAttachment.findMany({ where: { draftId, messageId: null }, include: { asset: true } });
  if (current.length !== attachmentIds.length || new Set(attachmentIds).size !== current.length || current.some((item) => !attachmentIds.includes(item.id))) {
    throw new HttpError(409, "The draft images changed. Reload them before reordering.");
  }
  for (const [index, id] of attachmentIds.entries()) await tx.messageAttachment.update({ where: { id }, data: { sortOrder: -(index + 1) } });
  for (const [index, id] of attachmentIds.entries()) await tx.messageAttachment.update({ where: { id }, data: { sortOrder: index } });
  const byId = new Map(current.map((item) => [item.id, item]));
  return attachmentIds.map((id, sortOrder) => serializeAttachment({ ...byId.get(id)!, sortOrder }));
});

export const discardDraftAttachments = async (draftId: string) => prisma.$transaction(async (tx) => {
  assertUnmanagedDraftId(draftId);
  const removed = await tx.messageAttachment.deleteMany({ where: { draftId, messageId: null } });
  await deleteUnreferencedAssets(tx);
  return removed.count;
});

export const stageMessageAttachmentsForEdit = async (messageId: string, draftId: string) => prisma.$transaction(async (tx) => {
  assertUnmanagedDraftId(draftId);
  const message = await tx.message.findFirst({ where: { id: messageId, chat: { deletedAt: null } }, include: messageIncludeAttachments });
  if (!message) throw new HttpError(404, "Message not found.");
  if (message.role !== "user") throw new HttpError(400, "Image attachments can only be edited on user messages.");
  await tx.messageAttachment.deleteMany({ where: { draftId, messageId: null } });
  if (message.attachments.length) await tx.messageAttachment.createMany({ data: message.attachments.map((attachment) => ({ draftId, assetId: attachment.assetId, sortOrder: attachment.sortOrder, originalFilename: attachment.originalFilename })) });
  return tx.messageAttachment.findMany({ where: { draftId, messageId: null }, include: { asset: true }, orderBy: { sortOrder: "asc" } });
});

export const attachDraftToMessage = async (tx: Prisma.TransactionClient, draftId: string | undefined, messageId: string) => {
  if (!draftId) return [];
  assertUnmanagedDraftId(draftId);
  const attachments = await tx.messageAttachment.findMany({ where: { draftId, messageId: null }, include: { asset: true }, orderBy: { sortOrder: "asc" } });
  if (!attachments.length) throw new HttpError(409, "The selected draft images are unavailable. Add them again before sending.");
  if (attachments.some((item) => item.createdAt.getTime() + DRAFT_MAX_AGE_MS <= Date.now())) throw new HttpError(409, "The selected draft images expired. Add them again before sending.");
  if (attachments.length > MAX_MESSAGE_IMAGES || attachments.reduce((total, item) => total + item.asset.byteSize, 0) > MAX_MESSAGE_IMAGE_BYTES) throw new HttpError(413, "The draft images exceed the message limits.");
  await tx.messageAttachment.updateMany({ where: { draftId, messageId: null }, data: { messageId, draftId: null } });
  return attachments.map((item) => ({ ...item, messageId, draftId: null }));
};

export const messageIncludeAttachments = { attachments: { include: { asset: true }, orderBy: { sortOrder: "asc" as const } } } as const;
