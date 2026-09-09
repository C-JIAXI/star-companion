import { Router } from "express";
import { createHash } from "node:crypto";
import { asyncHandler, parseBody } from "../lib/http.js";
import {
  attachmentDraftIdSchema,
  imageGenerationSchema,
  imageAttachmentReorderSchema,
  imageAttachmentEditDraftSchema,
  imageAttachmentUploadSchema,
  voiceSpeechSchema,
  voiceTranscriptionSchema
} from "../schemas.js";
import { prisma } from "../db.js";
import { HttpError, requireParam } from "../lib/http.js";
import {
  discardDraftAttachments,
  listDraftAttachments,
  removeDraftAttachment,
  reorderDraftAttachments,
  serializeAttachment,
  stageMessageAttachmentsForEdit,
  uploadDraftImage
} from "../services/messageAttachments.js";
import { generateImage, createSpeechAudio, transcribeAudio } from "../services/media.js";
import { resolveModuleSettings } from "../services/moduleModels.js";
import { getOrCreateSettings } from "./settings.js";
import { createImageThumbnail, validateStoredImage } from "../services/imageNormalization.js";

export const mediaRouter = Router();
const thumbnailCache = new Map<string, { data: Buffer; mimeType: string; etag: string }>();
export const clearMediaThumbnailCache = () => thumbnailCache.clear();
const cacheThumbnail = (key: string, value: { data: Buffer; mimeType: string; etag: string }) => {
  thumbnailCache.delete(key);
  thumbnailCache.set(key, value);
  while (thumbnailCache.size > 64) thumbnailCache.delete(thumbnailCache.keys().next().value!);
};

mediaRouter.post(
  "/chat-images/messages/:messageId/edit-draft",
  asyncHandler(async (request, response) => {
    const { draftId } = parseBody(imageAttachmentEditDraftSchema, request.body);
    const attachments = await stageMessageAttachmentsForEdit(requireParam(request, "messageId"), draftId);
    response.status(201).json({ ok: true, data: attachments.map((item) => ({ ...serializeAttachment(item), draftId, status: "ready" })) });
  })
);

mediaRouter.post(
  "/chat-images/drafts",
  asyncHandler(async (request, response) => {
    const body = parseBody(imageAttachmentUploadSchema, request.body);
    const attachment = await uploadDraftImage(body);
    response.status(201).json({ ok: true, data: attachment });
  })
);

mediaRouter.get(
  "/chat-images/drafts/:draftId",
  asyncHandler(async (request, response) => {
    const draftId = attachmentDraftIdSchema.parse(requireParam(request, "draftId"));
    const attachments = await listDraftAttachments(draftId);
    response.json({ ok: true, data: attachments.map((item) => ({ ...serializeAttachment(item), draftId, status: "ready" })) });
  })
);

mediaRouter.put(
  "/chat-images/drafts/:draftId/order",
  asyncHandler(async (request, response) => {
    const draftId = attachmentDraftIdSchema.parse(requireParam(request, "draftId"));
    const body = parseBody(imageAttachmentReorderSchema, request.body);
    response.json({ ok: true, data: await reorderDraftAttachments(draftId, body.attachmentIds) });
  })
);

mediaRouter.delete(
  "/chat-images/drafts/:draftId/:attachmentId",
  asyncHandler(async (request, response) => {
    const draftId = attachmentDraftIdSchema.parse(requireParam(request, "draftId"));
    await removeDraftAttachment(draftId, requireParam(request, "attachmentId"));
    response.status(204).send();
  })
);

mediaRouter.delete(
  "/chat-images/drafts/:draftId",
  asyncHandler(async (request, response) => {
    const draftId = attachmentDraftIdSchema.parse(requireParam(request, "draftId"));
    await discardDraftAttachments(draftId);
    response.status(204).send();
  })
);

mediaRouter.get(
  "/chat-images/:assetId/thumbnail",
  asyncHandler(async (request, response) => {
    const assetId = requireParam(request, "assetId");
    // Recheck references even on a cache hit: expiry/removal must revoke access.
    const liveReference = await prisma.messageAttachment.findFirst({ where: { assetId, OR: [
      { messageId: { not: null } },
      { draftId: { not: null }, createdAt: { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) } }
    ] }, select: { id: true } });
    if (!liveReference) throw new HttpError(404, "Image not found.");
    let thumbnail = thumbnailCache.get(assetId);
    if (!thumbnail) {
      const asset = await prisma.mediaAsset.findFirst({
        where: { id: assetId, attachments: { some: {} } },
        select: { mimeType: true, data: true, contentHash: true, byteSize: true, width: true, height: true }
      });
      if (!asset) throw new HttpError(404, "Image not found.");
      const data = Buffer.from(asset.data);
      if (data.length !== asset.byteSize || createHash("sha256").update(data).digest("hex") !== asset.contentHash) throw new HttpError(410, "Image unavailable.");
      try {
        const generated = createImageThumbnail({ data, mimeType: asset.mimeType as "image/png" | "image/jpeg", width: asset.width, height: asset.height });
        thumbnail = { ...generated, etag: `"thumb-${asset.contentHash}"` };
        cacheThumbnail(assetId, thumbnail);
      } catch { throw new HttpError(410, "Image unavailable."); }
    }
    response.setHeader("Content-Type", thumbnail.mimeType);
    response.setHeader("Cache-Control", "private, max-age=300, must-revalidate");
    response.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("ETag", thumbnail.etag);
    response.send(thumbnail.data);
  })
);

mediaRouter.get(
  "/chat-images/:assetId",
  asyncHandler(async (request, response) => {
    const asset = await prisma.mediaAsset.findFirst({
      where: { id: requireParam(request, "assetId"), attachments: { some: { OR: [
        { messageId: { not: null } },
        { draftId: { not: null }, createdAt: { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) } }
      ] } } },
      select: { mimeType: true, data: true, contentHash: true, byteSize: true, width: true, height: true }
    });
    if (!asset) throw new HttpError(404, "Image not found.");
    const data = Buffer.from(asset.data);
    try {
      if (data.length !== asset.byteSize || createHash("sha256").update(data).digest("hex") !== asset.contentHash) throw new Error("mismatch");
      validateStoredImage({ data, mimeType: asset.mimeType as "image/png" | "image/jpeg", width: asset.width, height: asset.height });
    } catch { throw new HttpError(410, "Image unavailable."); }
    response.setHeader("Content-Type", asset.mimeType);
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("ETag", `\"sha256-${asset.contentHash}\"`);
    response.send(data);
  })
);

mediaRouter.post(
  "/voice/transcriptions",
  asyncHandler(async (request, response) => {
    const body = parseBody(voiceTranscriptionSchema, request.body);
    const settings = resolveModuleSettings(await getOrCreateSettings(), "voice_transcription");
    const result = await transcribeAudio({ settings, ...body });
    response.json({ ok: true, data: result });
  })
);

mediaRouter.post(
  "/voice/speech",
  asyncHandler(async (request, response) => {
    const body = parseBody(voiceSpeechSchema, request.body);
    const settings = resolveModuleSettings(await getOrCreateSettings(), "voice_speech");
    const result = await createSpeechAudio({ settings, ...body });
    response.json({ ok: true, data: result });
  })
);

mediaRouter.post(
  "/images/generations",
  asyncHandler(async (request, response) => {
    const body = parseBody(imageGenerationSchema, request.body);
    const settings = resolveModuleSettings(await getOrCreateSettings(), "image_generation");
    const result = await generateImage({ settings, ...body });
    response.json({ ok: true, data: result });
  })
);
