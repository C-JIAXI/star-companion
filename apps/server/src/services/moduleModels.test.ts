import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UserSettings } from "@prisma/client";
import {
  resolveModuleSettings,
  inferModelCapabilities,
  supportsModule,
  validateModuleModelPreferences
} from "./moduleModels.js";

const openAiProvider = {
  id: "openai",
  label: "OpenAI",
  provider: "openai-compatible",
  apiBaseUrl: "https://example.com/v1",
  models: [
    { id: "chat", label: "Chat", model: "gpt-4o-mini", capabilities: ["text_generation"] },
    { id: "stt", label: "STT", model: "gpt-4o-mini-transcribe", capabilities: ["audio_transcription"] },
    { id: "tts", label: "TTS", model: "gpt-4o-mini-tts", capabilities: ["text_to_speech"] },
    { id: "image", label: "Image", model: "gpt-image-1", capabilities: ["image_generation"] }
  ]
};

describe("moduleModels", () => {
  it("classifies known media models without explicit capability metadata", () => {
    assert.deepEqual(inferModelCapabilities("whisper-1"), ["audio_transcription"]);
    assert.deepEqual(inferModelCapabilities("tts-1"), ["text_to_speech"]);
    assert.deepEqual(inferModelCapabilities("gpt-image-1"), ["image_generation"]);
    assert.deepEqual(inferModelCapabilities("local-roleplay-model"), ["text_generation"]);
  });

  it("only permits each module to select a compatible model", () => {
    assert.equal(supportsModule(openAiProvider, openAiProvider.models[0]!, "agent"), true);
    assert.equal(supportsModule(openAiProvider, openAiProvider.models[0]!, "image_generation"), false);
    assert.equal(supportsModule(openAiProvider, openAiProvider.models[3]!, "image_generation"), true);
  });

  it("rejects module preferences that point to incompatible models", () => {
    assert.equal(
      validateModuleModelPreferences([openAiProvider], {
        image_generation: { providerId: "openai", modelId: "image" },
        voice_speech: { providerId: "openai", modelId: "tts" }
      }),
      null
    );
    assert.match(
      validateModuleModelPreferences([openAiProvider], {
        image_generation: { providerId: "openai", modelId: "chat" }
      }) ?? "",
      /does not support image_generation/
    );
  });

  it("rejects a media-only model as the current chat model", () => {
    assert.match(
      validateModuleModelPreferences([openAiProvider], {}, "openai", "image") ?? "",
      /does not support chat/
    );
  });

  it("does not silently fall back to a text chat model for media modules", () => {
    const settings = {
      providers: [openAiProvider],
      activeProvider: "openai-compatible",
      activeProviderId: "openai",
      activeModelId: "chat",
      model: "gpt-4o-mini",
      moduleModelPreferences: {}
    } as UserSettings;

    assert.throws(
      () => resolveModuleSettings(settings, "image_generation"),
      /No compatible model is configured for image_generation/
    );
  });
});
