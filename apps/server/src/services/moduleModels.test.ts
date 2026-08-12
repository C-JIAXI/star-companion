import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UserSettings } from "@prisma/client";
import {
  resolveModuleSettings,
  inferModelCapabilities,
  settingsSupportVisionInput,
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
    { id: "embedding", label: "Embedding", model: "text-embedding-3-small", capabilities: ["text_embedding"] },
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
    assert.deepEqual(inferModelCapabilities("text-embedding-3-small"), ["text_embedding"]);
    assert.deepEqual(inferModelCapabilities("nomic-embed-text"), ["text_embedding"]);
    assert.deepEqual(inferModelCapabilities("local-roleplay-model"), ["text_generation"]);
    assert.deepEqual(inferModelCapabilities("gpt-4o-mini"), ["text_generation", "vision_input"]);
  });

  it("only permits each module to select a compatible model", () => {
    assert.equal(supportsModule(openAiProvider, openAiProvider.models[0]!, "agent"), true);
    assert.equal(supportsModule(openAiProvider, openAiProvider.models[0]!, "image_generation"), false);
    assert.equal(supportsModule(openAiProvider, openAiProvider.models[4]!, "image_generation"), true);
    assert.equal(supportsModule(openAiProvider, openAiProvider.models[1]!, "memory_embedding"), true);
    assert.equal(
      supportsModule(
        { ...openAiProvider, provider: "anthropic" },
        openAiProvider.models[1]!,
        "memory_embedding"
      ),
      false
    );
  });

  it("requires an explicit vision capability for image input", () => {
    const value = {
      providers: [openAiProvider], activeProviderId: "openai", activeModelId: "chat"
    } as unknown as UserSettings;
    assert.equal(settingsSupportVisionInput(value), false);
    const vision = { ...openAiProvider, models: [{ ...openAiProvider.models[0]!, capabilities: ["text_generation", "vision_input"] }] };
    assert.equal(settingsSupportVisionInput({ ...value, providers: [vision] } as unknown as UserSettings), true);
  });

  it("rejects module preferences that point to incompatible models", () => {
    assert.equal(
      validateModuleModelPreferences([openAiProvider], {
        image_generation: { providerId: "openai", modelId: "image" },
        voice_speech: { providerId: "openai", modelId: "tts" },
        memory_embedding: { providerId: "openai", modelId: "embedding" }
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
