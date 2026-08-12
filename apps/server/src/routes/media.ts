import { Router } from "express";
import { asyncHandler, parseBody } from "../lib/http.js";
import {
  attachmentDraftIdSchema,
  imageGenerationSchema,
  imageAttachmentReorderSchema,
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
  uploadDraftImage
} from "../services/messageAttachments.js";
import { generateImage, createSpeechAudio, transcribeAudio } from "../services/media.js";
import { resolveModuleSettings } from "../services/moduleModels.js";
import { getOrCreateSettings } from "./settings.js";

export const mediaRouter = Router();

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
  "/chat-images/:assetId",
  asyncHandler(async (request, response) => {
    const asset = await prisma.mediaAsset.findFirst({
      where: { id: requireParam(request, "assetId"), attachments: { some: {} } },
      select: { mimeType: true, data: true, contentHash: true }
    });
    if (!asset) throw new HttpError(404, "Image not found.");
    response.setHeader("Content-Type", asset.mimeType);
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("ETag", `\"sha256-${asset.contentHash}\"`);
    response.send(Buffer.from(asset.data));
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
