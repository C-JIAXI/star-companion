import type { MediaAsset, MessageAttachment, Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { prisma } from "../db.js";
import { HttpError } from "../lib/http.js";

export const MAX_MESSAGE_IMAGES = 4;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_MESSAGE_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 25_000_000;
const MAX_IMAGE_DIMENSION = 16_384;
const MAX_ASPECT_RATIO = 100;
const DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

type SupportedMime = "image/png" | "image/jpeg";
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

const readPngSize = (bytes: Buffer) => {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return null;
  if (bytes.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), mimeType: "image/png" as const };
};

const readJpegSize = (bytes: Buffer) => {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 7) return null;
      return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3), mimeType: "image/jpeg" as const };
    }
    offset += length;
  }
  return null;
};

const assertDimensions = (width: number, height: number) => {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new HttpError(400, "The image dimensions are invalid.");
  }
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION || width * height > MAX_IMAGE_PIXELS) {
    throw new HttpError(413, "The decoded image is too large. Use an image no larger than 25 megapixels.");
  }
  if (Math.max(width / height, height / width) > MAX_ASPECT_RATIO) {
    throw new HttpError(400, "The image aspect ratio is too extreme to process safely.");
  }
};

export const normalizeUploadedImage = (input: {
  dataBase64: string;
  mimeType: SupportedMime;
}) => {
  const bytes = Buffer.from(input.dataBase64, "base64");
  if (!bytes.length || bytes.toString("base64").replace(/=+$/, "") !== input.dataBase64.replace(/\s+/g, "").replace(/=+$/, "")) {
    throw new HttpError(400, "The image data is not valid base64.");
  }
  if (bytes.length > MAX_IMAGE_BYTES) throw new HttpError(413, "Each image must be 10 MB or smaller.");
  const header = readPngSize(bytes) ?? readJpegSize(bytes);
  if (!header) throw new HttpError(400, "Only valid PNG or JPEG image data is accepted.");
  if (header.mimeType !== input.mimeType) throw new HttpError(400, "The declared image type does not match the file signature.");
  assertDimensions(header.width, header.height);

  try {
    if (header.mimeType === "image/png") {
      const decoded = PNG.sync.read(bytes, { checkCRC: true, skipRescale: false });
      assertDimensions(decoded.width, decoded.height);
      const data = PNG.sync.write(decoded, { colorType: 6, inputColorType: 6 });
      if (data.length > MAX_MESSAGE_IMAGE_BYTES) throw new HttpError(413, "The normalized image is too large.");
      return { data, mimeType: "image/png" as const, width: decoded.width, height: decoded.height };
    }
    const decoded = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 160 });
    assertDimensions(decoded.width, decoded.height);
    const encoded = jpeg.encode({ data: decoded.data, width: decoded.width, height: decoded.height }, 90).data;
    if (encoded.length > MAX_MESSAGE_IMAGE_BYTES) throw new HttpError(413, "The normalized image is too large.");
    return { data: Buffer.from(encoded), mimeType: "image/jpeg" as const, width: decoded.width, height: decoded.height };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "The image is damaged or cannot be decoded safely.");
  }
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

const deleteUnreferencedAssets = async (tx: Prisma.TransactionClient) => {
  await tx.mediaAsset.deleteMany({ where: { attachments: { none: {} } } });
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
  const normalized = normalizeUploadedImage(input);
  const contentHash = createHash("sha256").update(normalized.data).digest("hex");
  return prisma.$transaction(async (tx) => {
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
    return { ...serializeAttachment(attachment), draftId: input.draftId, status: "ready" as const };
  });
};

export const listDraftAttachments = (draftId: string) => prisma.messageAttachment.findMany({ where: { draftId, messageId: null }, include: { asset: true }, orderBy: { sortOrder: "asc" } });

export const removeDraftAttachment = async (draftId: string, attachmentId: string) => prisma.$transaction(async (tx) => {
  const attachment = await tx.messageAttachment.findFirst({ where: { id: attachmentId, draftId, messageId: null } });
  if (!attachment) throw new HttpError(404, "Draft image not found.");
  await tx.messageAttachment.delete({ where: { id: attachment.id } });
  const remaining = await tx.messageAttachment.findMany({ where: { draftId, messageId: null }, orderBy: { sortOrder: "asc" } });
  for (const [sortOrder, item] of remaining.entries()) await tx.messageAttachment.update({ where: { id: item.id }, data: { sortOrder: -(sortOrder + 1) } });
  for (const [sortOrder, item] of remaining.entries()) await tx.messageAttachment.update({ where: { id: item.id }, data: { sortOrder } });
  await deleteUnreferencedAssets(tx);
});

export const reorderDraftAttachments = async (draftId: string, attachmentIds: string[]) => prisma.$transaction(async (tx) => {
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
  const removed = await tx.messageAttachment.deleteMany({ where: { draftId, messageId: null } });
  await deleteUnreferencedAssets(tx);
  return removed.count;
});

export const attachDraftToMessage = async (tx: Prisma.TransactionClient, draftId: string | undefined, messageId: string) => {
  if (!draftId) return [];
  const attachments = await tx.messageAttachment.findMany({ where: { draftId, messageId: null }, include: { asset: true }, orderBy: { sortOrder: "asc" } });
  if (!attachments.length) throw new HttpError(409, "The selected draft images are unavailable. Add them again before sending.");
  if (attachments.length > MAX_MESSAGE_IMAGES || attachments.reduce((total, item) => total + item.asset.byteSize, 0) > MAX_MESSAGE_IMAGE_BYTES) throw new HttpError(413, "The draft images exceed the message limits.");
  await tx.messageAttachment.updateMany({ where: { draftId, messageId: null }, data: { messageId, draftId: null } });
  return attachments.map((item) => ({ ...item, messageId, draftId: null }));
};

export const messageIncludeAttachments = { attachments: { include: { asset: true }, orderBy: { sortOrder: "asc" as const } } } as const;
