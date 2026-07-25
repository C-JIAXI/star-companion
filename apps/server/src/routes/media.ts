import { Router } from "express";
import { asyncHandler, parseBody } from "../lib/http.js";
import {
  imageGenerationSchema,
  voiceSpeechSchema,
  voiceTranscriptionSchema
} from "../schemas.js";
import { generateImage, createSpeechAudio, transcribeAudio } from "../services/media.js";
import { resolveModuleSettings } from "../services/moduleModels.js";
import { getOrCreateSettings } from "./settings.js";

export const mediaRouter = Router();

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
