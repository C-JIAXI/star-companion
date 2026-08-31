import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseBody } from "./lib/http.js";
import {
  backupImportSchema,
  chatAgentDraftSchema,
  chatBatchArchiveSchema,
  chatBatchFolderSchema,
  chatRenameFolderSchema,
  chatBatchPermanentDeleteSchema,
  chatBatchTrashSchema,
  chatBranchSchema,
  continueRequestSchema,
  chatMessageSearchQuerySchema,
  characterExportSchema,
  characterBatchTagsSchema,
  characterDuplicateSchema,
  characterImportSchema,
  characterPageQuerySchema,
  characterUpdateRequestSchema,
  characterUnlockSchema,
  chatUpdateSchema,
  imageGenerationSchema,
  messageUpdateSchema,
  regenerateRequestSchema,
  settingsUpdateSchema,
  storageCleanupExecuteSchema,
  storageCleanupPlanRequestSchema,
  voiceTranscriptionSchema
} from "./schemas.js";

describe("chatAgentDraftSchema", () => {
  it("accepts known agent modes and trims optional focus", () => {
    const parsed = parseBody(chatAgentDraftSchema, {
      mode: "next_steps",
      focus: "  focus on the locked door  "
    });

    assert.deepEqual(parsed, {
      mode: "next_steps",
      focus: "focus on the locked door"
    });
  });

  it("rejects unknown modes and overlong focus text", () => {
    assert.throws(() =>
      parseBody(chatAgentDraftSchema, {
        mode: "background_task"
      })
    );
    assert.throws(() =>
      parseBody(chatAgentDraftSchema, {
        mode: "scene_summary",
        focus: "x".repeat(1001)
      })
    );
  });
});

describe("storage cleanup schemas", () => {
  it("accepts allow-listed actions without accepting client paths", () => {
    assert.deepEqual(parseBody(storageCleanupPlanRequestSchema, { actions: ["orphan_media", "orphan_media"] }), { actions: ["orphan_media"] });
    assert.throws(() => parseBody(storageCleanupPlanRequestSchema, { actions: ["app_temp_cache"], path: "../../outside" }));
    assert.throws(() => parseBody(storageCleanupPlanRequestSchema, { actions: ["vacuum_database", "orphan_media"] }));
    assert.deepEqual(parseBody(storageCleanupExecuteSchema, { confirm: "EXECUTE_STORAGE_CLEANUP" }), { confirm: "EXECUTE_STORAGE_CLEANUP" });
  });
});

describe("continueRequestSchema", () => {
  it("requires a request id and assistant message id", () => {
    assert.deepEqual(
      parseBody(continueRequestSchema, {
        type: "continue",
        requestId: "continue-1",
        messageId: "assistant-1"
      }),
      { type: "continue", requestId: "continue-1", messageId: "assistant-1" }
    );
    assert.throws(() => parseBody(continueRequestSchema, { type: "continue", requestId: "" }));
  });
});

describe("regenerateRequestSchema", () => {
  it("accepts bounded optional regeneration guidance", () => {
    assert.deepEqual(
      parseBody(regenerateRequestSchema, {
        type: "regenerate",
        requestId: "request-1",
        messageId: "message-1",
        guidance: "  Keep the facts, but make the reply more restrained.  "
      }),
      {
        type: "regenerate",
        requestId: "request-1",
        messageId: "message-1",
        guidance: "Keep the facts, but make the reply more restrained."
      }
    );
    assert.throws(() =>
      parseBody(regenerateRequestSchema, {
        type: "regenerate",
        requestId: "request-1",
        messageId: "message-1",
        guidance: "x".repeat(1001)
      })
    );
  });
});

describe("chatBranchSchema", () => {
  it("requires a target message id and trims optional title", () => {
    const parsed = parseBody(chatBranchSchema, {
      messageId: "message-1",
      title: "  Branch A  "
    });

    assert.deepEqual(parsed, {
      messageId: "message-1",
      title: "Branch A",
      kind: "branch"
    });
    assert.equal(parseBody(chatBranchSchema, { messageId: "message-1", kind: "checkpoint" }).kind, "checkpoint");
    assert.throws(() => parseBody(chatBranchSchema, { messageId: "" }));
  });
});

describe("chatMessageSearchQuerySchema", () => {
  it("trims a search query and validates result limits", () => {
    const parsed = parseBody(chatMessageSearchQuerySchema, {
      q: "  blue door  ",
      limit: "50"
    });

    assert.equal(parsed.q, "blue door");
    assert.equal(parsed.limit, 50);
    assert.throws(() => parseBody(chatMessageSearchQuerySchema, { q: "" }));
    assert.throws(() => parseBody(chatMessageSearchQuerySchema, { q: "blue", limit: "100" }));
  });
});

describe("messageUpdateSchema", () => {
  it("accepts an isolated bookmark update", () => {
    assert.deepEqual(parseBody(messageUpdateSchema, { isBookmarked: true }), {
      isBookmarked: true
    });
  });
});

describe("chatUpdateSchema", () => {
  it("does not inject create-time defaults into partial chat updates", () => {
    const parsed = parseBody(chatUpdateSchema, { userPersona: "Roleplay as an engineer." });

    assert.deepEqual(parsed, {
      userPersona: "Roleplay as an engineer."
    });
    assert.equal("characterId" in parsed, false);
    assert.equal("backgroundUrl" in parsed, false);
    assert.equal("memoryTurns" in parsed, false);
    assert.equal("autoMemoryEnabled" in parsed, false);
    assert.equal("userProfileSummary" in parsed, false);
  });

  it("accepts chat background URLs for per-chat backgrounds", () => {
    const remote = parseBody(chatUpdateSchema, {
      backgroundUrl: "https://example.com/background.webp"
    });
    const uploaded = parseBody(chatUpdateSchema, {
      backgroundUrl: "data:image/png;base64,QUJDRA=="
    });

    assert.equal(remote.backgroundUrl, "https://example.com/background.webp");
    assert.equal(uploaded.backgroundUrl, "data:image/png;base64,QUJDRA==");
  });

  it("accepts organization state as history-only chat updates", () => {
    const parsed = parseBody(chatUpdateSchema, {
      isPinned: true,
      isArchived: true,
      folder: "  Main story  "
    });

    assert.deepEqual(parsed, { isPinned: true, isArchived: true, folder: "Main story" });
    assert.throws(() => parseBody(chatUpdateSchema, { folder: "x".repeat(81) }));
  });
});

describe("chatBatchArchiveSchema", () => {
  it("accepts up to 100 unique chat ids and an explicit archive state", () => {
    assert.deepEqual(
      parseBody(chatBatchArchiveSchema, {
        ids: ["chat-a", "chat-a", "chat-b"],
        isArchived: true
      }),
      { ids: ["chat-a", "chat-b"], isArchived: true }
    );
  });

  it("rejects empty or oversized chat selections", () => {
    assert.throws(() => parseBody(chatBatchArchiveSchema, { ids: [], isArchived: true }));
    assert.throws(() =>
      parseBody(chatBatchArchiveSchema, {
        ids: Array.from({ length: 101 }, (_, index) => `chat-${index}`),
        isArchived: false
      })
    );
  });
});

describe("chatBatchFolderSchema", () => {
  it("deduplicates selected chats and trims a folder name", () => {
    assert.deepEqual(
      parseBody(chatBatchFolderSchema, {
        ids: ["chat-a", "chat-a", "chat-b"],
        folder: "  Main story  "
      }),
      { ids: ["chat-a", "chat-b"], folder: "Main story" }
    );
    assert.throws(() => parseBody(chatBatchFolderSchema, { ids: [], folder: "Main story" }));
  });
});

describe("chatRenameFolderSchema", () => {
  it("trims folder names and does not allow the unfiled state as a source", () => {
    assert.deepEqual(
      parseBody(chatRenameFolderSchema, { from: "  Main story  ", to: "  New story  " }),
      { from: "Main story", to: "New story" }
    );
    assert.deepEqual(
      parseBody(chatRenameFolderSchema, { from: "Main story", to: "   " }),
      { from: "Main story", to: "" }
    );
    assert.throws(() => parseBody(chatRenameFolderSchema, { from: "", to: "New story" }));
  });
});

describe("chat trash schemas", () => {
  it("deduplicates batch trash ids and requires a known action", () => {
    assert.deepEqual(
      parseBody(chatBatchTrashSchema, {
        ids: ["chat-a", "chat-a", "chat-b"],
        action: "restore"
      }),
      { ids: ["chat-a", "chat-b"], action: "restore" }
    );
    assert.throws(() => parseBody(chatBatchTrashSchema, { ids: ["chat-a"], action: "delete" }));
  });

  it("validates permanent-delete selections", () => {
    assert.deepEqual(
      parseBody(chatBatchPermanentDeleteSchema, { ids: ["chat-a", "chat-a"] }),
      { ids: ["chat-a"] }
    );
    assert.throws(() => parseBody(chatBatchPermanentDeleteSchema, { ids: [] }));
  });
});

describe("characterUpdateRequestSchema", () => {
  it("does not inject create-time defaults into partial character updates", () => {
    const parsed = parseBody(characterUpdateRequestSchema, {
      description: "Updated smoke character description."
    });

    assert.deepEqual(parsed, {
      description: "Updated smoke character description."
    });
    assert.equal("prefix" in parsed, false);
    assert.equal("prompt" in parsed, false);
    assert.equal("suffix" in parsed, false);
    assert.equal("htmlCss" in parsed, false);
    assert.equal("openingHtml" in parsed, false);
    assert.equal("tags" in parsed, false);
    assert.equal("loreEntries" in parsed, false);
    assert.equal("quickReplies" in parsed, false);
  });

  it("accepts an isolated favorite update", () => {
    assert.deepEqual(parseBody(characterUpdateRequestSchema, { isFavorite: true }), {
      isFavorite: true
    });
  });

  it("accepts local avatar data and rejects oversized avatar payloads", () => {
    assert.deepEqual(
      parseBody(characterUpdateRequestSchema, {
        avatar: "data:image/png;base64,QUJDRA=="
      }),
      { avatar: "data:image/png;base64,QUJDRA==" }
    );
    assert.throws(() =>
      parseBody(characterUpdateRequestSchema, {
        avatar: `data:image/png;base64,${"A".repeat(3_000_000)}`
      })
    );
  });

  it("enforces the HTML and CSS limits used by the character quality checker", () => {
    assert.equal(characterUpdateRequestSchema.safeParse({ openingHtml: "x".repeat(200_001) }).success, false);
    assert.equal(characterUpdateRequestSchema.safeParse({ htmlCss: "x".repeat(100_001) }).success, false);
    assert.equal(characterUpdateRequestSchema.safeParse({ openingHtml: "<section>safe</section>", htmlCss: ".card{}" }).success, true);
  });
});

describe("characterBatchTagsSchema", () => {
  it("normalizes duplicate ids and tags for an explicit operation", () => {
    assert.deepEqual(
      parseBody(characterBatchTagsSchema, {
        ids: ["character-a", "character-a", "character-b"],
        operation: "add",
        tags: [" fantasy ", "Fantasy", "night"]
      }),
      {
        ids: ["character-a", "character-b"],
        operation: "add",
        tags: ["fantasy", "night"]
      }
    );
  });

  it("rejects empty selections, unknown operations, and oversized tag sets", () => {
    assert.throws(() =>
      parseBody(characterBatchTagsSchema, { ids: [], operation: "add", tags: ["fantasy"] })
    );
    assert.throws(() =>
      parseBody(characterBatchTagsSchema, {
        ids: ["character-a"],
        operation: "replace",
        tags: ["fantasy"]
      })
    );
    assert.throws(() =>
      parseBody(characterBatchTagsSchema, {
        ids: ["character-a"],
        operation: "remove",
        tags: Array.from({ length: 25 }, (_, index) => `tag-${index}`)
      })
    );
  });
});

describe("settingsUpdateSchema", () => {
  it("applies stable appearance defaults and validates explicit preferences", () => {
    const base = { apiBaseUrl: "https://example.com/v1", model: "model", temperature: 0.8, maxTokens: 800, topP: 1 };
    const defaults = parseBody(settingsUpdateSchema, { ...base, appearancePreferences: {} }).appearancePreferences!;
    assert.deepEqual(defaults, {
      themeMode: "system",
      fontSize: "standard",
      lineHeight: "comfortable",
      chatWidth: "standard",
      messageSpacing: "standard",
      contrast: "standard",
      motion: "system",
      backgroundOverlay: 0.55,
      backgroundBlur: "subtle",
      characterStyle: "full"
    });

    const explicit = parseBody(settingsUpdateSchema, { ...base,
      appearancePreferences: { themeMode: "dark", fontSize: "extra-large", lineHeight: "relaxed", chatWidth: "wide", messageSpacing: "compact", contrast: "high", motion: "reduced", backgroundOverlay: 0.8, backgroundBlur: "medium", characterStyle: "restricted" }
    }).appearancePreferences!;
    assert.equal(explicit.themeMode, "dark");
    assert.equal(explicit.characterStyle, "restricted");
    assert.throws(() => parseBody(settingsUpdateSchema, { ...base, appearancePreferences: { themeMode: "midnight" } }));
    assert.throws(() => parseBody(settingsUpdateSchema, { ...base, appearancePreferences: { backgroundOverlay: 1 } }));
  });

  it("accepts chat display preferences in settings payloads", () => {
    const parsed = parseBody(settingsUpdateSchema, {
      activeProvider: "openai-compatible",
      apiBaseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      temperature: 0.8,
      maxTokens: 800,
      topP: 1,
      language: "zh-CN",
      providers: [],
      activeProviderId: "",
      activeModelId: "",
      showMessageAvatars: false,
      showMessageTimestamps: true,
      ttsVoice: "nova",
      ttsPlaybackRate: 1.25,
      ttsAutoPlay: true
    });

    assert.equal(parsed.showMessageAvatars, false);
    assert.equal(parsed.showMessageTimestamps, true);
    assert.equal(parsed.ttsVoice, "nova");
    assert.equal(parsed.ttsPlaybackRate, 1.25);
    assert.equal(parsed.ttsAutoPlay, true);
    assert.equal(parsed.moduleModelPreferences, undefined);
  });

  it("rejects invalid text-to-speech preferences", () => {
    assert.throws(() =>
      parseBody(settingsUpdateSchema, {
        ttsVoice: " ",
        ttsPlaybackRate: 2.1
      })
    );
  });

  it("accepts provider profiles with nested models", () => {
    const parsed = parseBody(settingsUpdateSchema, {
      activeProvider: "openai-compatible",
      apiBaseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      temperature: 0.8,
      maxTokens: 800,
      topP: 1,
      language: "zh-CN",
      providers: [
        {
          id: "provider-1",
          label: "OpenAI",
          provider: "openai",
          apiBaseUrl: "https://api.openai.com/v1",
          models: [
            {
              id: "model-1",
              label: "GPT",
              model: "gpt-4o-mini",
              contextWindow: 128000,
              capabilities: ["text_generation"]
            }
          ]
        }
      ],
      activeProviderId: "provider-1",
      activeModelId: "model-1"
    });

    assert.equal(parsed.providers[0]?.models[0]?.model, "gpt-4o-mini");
    assert.equal(parsed.providers[0]?.models[0]?.contextWindow, 128000);
    assert.deepEqual(parsed.providers[0]?.models[0]?.capabilities, ["text_generation"]);
    assert.equal(parsed.activeProviderId, "provider-1");
  });

  it("rejects invalid model context windows", () => {
    assert.throws(() =>
      parseBody(settingsUpdateSchema, {
        activeProvider: "openai-compatible",
        apiBaseUrl: "https://api.openai.com/v1",
        model: "local-model",
        temperature: 0.8,
        maxTokens: 800,
        topP: 1,
        language: "zh-CN",
        providers: [
          {
            id: "provider-1",
            label: "Local",
            provider: "openai-compatible",
            apiBaseUrl: "https://api.openai.com/v1",
            models: [
              { id: "model-1", label: "Local", model: "local-model", contextWindow: 128 }
            ]
          }
        ],
        activeProviderId: "provider-1",
        activeModelId: "model-1"
      })
    );
  });

  it("rejects unknown model capabilities", () => {
    assert.throws(() =>
      parseBody(settingsUpdateSchema, {
        activeProvider: "openai-compatible",
        apiBaseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
        temperature: 0.8,
        maxTokens: 800,
        topP: 1,
        language: "zh-CN",
        providers: [
          {
            id: "provider-1",
            label: "OpenAI",
            provider: "openai-compatible",
            apiBaseUrl: "https://api.openai.com/v1",
            models: [{ id: "model-1", label: "Bad", model: "bad", capabilities: ["video"] }]
          }
        ],
        activeProviderId: "provider-1",
        activeModelId: "model-1"
      })
    );
  });

  it("accepts per-module model preferences", () => {
    const parsed = parseBody(settingsUpdateSchema, {
      activeProvider: "openai-compatible",
      apiBaseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      temperature: 0.8,
      maxTokens: 800,
      topP: 1,
      language: "zh-CN",
      providers: [
        {
          id: "provider-1",
          label: "OpenAI",
          provider: "openai-compatible",
          apiBaseUrl: "https://api.openai.com/v1",
          models: [{ id: "model-1", label: "Agent", model: "gpt-4o-mini" }]
        }
      ],
      activeProviderId: "provider-1",
      activeModelId: "model-1",
      moduleModelPreferences: {
        agent: { providerId: "provider-1", modelId: "model-1" },
        memory_embedding: { providerId: "provider-1", modelId: "model-1" },
        image_generation: { providerId: "provider-1", modelId: "model-1" }
      }
    });

    assert.deepEqual(parsed.moduleModelPreferences?.agent, {
      providerId: "provider-1",
      modelId: "model-1"
    });
    assert.deepEqual(parsed.moduleModelPreferences?.memory_embedding, {
      providerId: "provider-1",
      modelId: "model-1"
    });
  });

  it("accepts reusable user persona presets", () => {
    const parsed = parseBody(settingsUpdateSchema, {
      activeProvider: "openai-compatible",
      apiBaseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      temperature: 0.8,
      maxTokens: 800,
      topP: 1,
      language: "zh-CN",
      providers: [],
      activeProviderId: "",
      activeModelId: "",
      userPersonaPresets: [
        {
          id: "persona-1",
          name: "Investigator",
          avatar: "data:image/png;base64,YQ==",
          config: {
            displayName: "Rowan",
            prefix: "User boundary.",
            prompt: "User is an investigator.",
            suffix: "Keep replies concise."
          }
        }
      ]
    });

    assert.equal(parsed.userPersonaPresets?.[0]?.name, "Investigator");
    assert.equal(parsed.userPersonaPresets?.[0]?.avatar, "data:image/png;base64,YQ==");
    assert.equal(parsed.userPersonaPresets?.[0]?.config.displayName, "Rowan");
    assert.equal(parsed.userPersonaPresets?.[0]?.config.prompt, "User is an investigator.");
  });

  it("accepts a chat-scoped persona avatar", () => {
    const parsed = parseBody(chatUpdateSchema, {
      userAvatar: "data:image/png;base64,YQ=="
    });

    assert.equal(parsed.userAvatar, "data:image/png;base64,YQ==");
    assert.throws(() => parseBody(chatUpdateSchema, { userAvatar: "x".repeat(3_000_001) }));
  });

});

describe("characterDuplicateSchema", () => {
  it("requires a bounded duplicate name", () => {
    assert.deepEqual(parseBody(characterDuplicateSchema, { name: "  Character copy  " }), {
      name: "Character copy"
    });
    assert.throws(() => parseBody(characterDuplicateSchema, { name: "" }));
    assert.throws(() => parseBody(characterDuplicateSchema, { name: "x".repeat(121) }));
  });
});

describe("media schemas", () => {
  it("rejects empty voice transcription audio", () => {
    assert.throws(() =>
      parseBody(voiceTranscriptionSchema, {
        audioBase64: "",
        mimeType: "audio/webm"
      })
    );
  });

  it("accepts image generation prompts", () => {
    const parsed = parseBody(imageGenerationSchema, {
      prompt: "a cozy archive room",
      size: "1024x1024"
    });

    assert.equal(parsed.prompt, "a cozy archive room");
  });
});

describe("characterPageQuerySchema", () => {
  it("normalizes defaults and clamps page size", () => {
    assert.deepEqual(parseBody(characterPageQuerySchema, {}), {
      q: "",
      tag: "",
      favoriteOnly: false,
      sort: "favorites",
      page: 1,
      pageSize: 40
    });

    assert.deepEqual(
      parseBody(characterPageQuerySchema, {
        q: "  pilot  ",
        tag: "  cozy  ",
        favoriteOnly: "true",
        page: "2",
        pageSize: "500"
      }),
      {
        q: "pilot",
        tag: "cozy",
        favoriteOnly: true,
        sort: "favorites",
        page: 2,
        pageSize: 100
      }
    );

    assert.equal(parseBody(characterPageQuerySchema, { sort: "recently_chatted" }).sort, "recently_chatted");
    assert.equal(parseBody(characterPageQuerySchema, { sort: "unknown" }).sort, "favorites");
  });
});

describe("characterExportSchema", () => {
  it("defaults export visibility to public and accepts optional passwords", () => {
    assert.deepEqual(parseBody(characterExportSchema, {}), {
      visibility: "public"
    });

    assert.deepEqual(
      parseBody(characterExportSchema, {
        visibility: "private",
        password: "open-sesame"
      }),
      {
        visibility: "private",
        password: "open-sesame"
      }
    );
  });
});

describe("characterUnlockSchema", () => {
  it("requires a non-empty password", () => {
    assert.deepEqual(parseBody(characterUnlockSchema, { password: "open-sesame" }), {
      password: "open-sesame"
    });
  });
});

describe("characterImportSchema", () => {
  it("accepts public and private character cards with password access control", () => {
    const publicCard = parseBody(characterImportSchema, {
      schemaVersion: 1,
      format: "character-card",
      visibility: "public",
      cardId: "public-card-id",
      character: {
        name: "Public Card",
        avatar: null,
        prefix: "Prefix",
        prompt: "Prompt",
        suffix: "Suffix",
        htmlCss: "",
        loreEntries: [],
        isFavorite: true
      }
    });
    const privateCard = parseBody(characterImportSchema, {
      schemaVersion: 1,
      format: "character-card",
      visibility: "private",
      cardId: "private-card-id",
      character: {
        name: "Private Card With AC",
        avatar: null
      },
      protectedPayload: {
        version: 1,
        algorithm: "aes-256-gcm",
        salt: "salt",
        iv: "iv",
        tag: "tag",
        ciphertext: "ciphertext",
        accessControl: {
          version: 1,
          salt: "ac-salt",
          verifier: "ac-verifier"
        }
      }
    });

    assert.equal(publicCard.visibility, "public");
    assert.equal("isFavorite" in publicCard.character, false);
    assert.equal(privateCard.visibility, "private");
  });

  it("rejects legacy character import payloads, cards without cardId, and private cards without access control", () => {
    assert.throws(() =>
      parseBody(characterImportSchema, {
        name: "Legacy Card",
        prompt: "Prompt text",
        scenario: "Legacy scenario"
      })
    );

    assert.throws(() =>
      parseBody(characterImportSchema, {
        schemaVersion: 1,
        format: "character-card",
        visibility: "public",
        character: {
          name: "Missing Card ID",
          avatar: null,
          prefix: "Prefix",
          prompt: "Prompt",
          suffix: "Suffix",
          htmlCss: "",
          loreEntries: []
        }
      })
    );

    assert.throws(() =>
      parseBody(characterImportSchema, {
        schemaVersion: 1,
        format: "character-card",
        visibility: "private",
        cardId: "private-card-without-access-control",
        character: {
          name: "Private Card",
          avatar: null
        },
        protectedPayload: {
          version: 1,
          algorithm: "aes-256-gcm",
          salt: "salt",
          iv: "iv",
          tag: "tag",
          ciphertext: "ciphertext"
        }
      })
    );
  });
});

describe("backupImportSchema", () => {
  it("preserves chat trash timestamps and defaults older backups to active chats", () => {
    const deletedAt = new Date().toISOString();
    const parsed = parseBody(backupImportSchema, {
      schemaVersion: 1,
      mode: "merge",
      characters: [],
      chats: [
        { id: "trashed-chat", title: "Trashed", characterId: null, deletedAt },
        { id: "legacy-chat", title: "Legacy", characterId: null }
      ],
      messages: []
    });

    assert.equal(parsed.chats[0]?.deletedAt, deletedAt);
    assert.equal(parsed.chats[1]?.deletedAt, null);
  });

  it("accepts imported private character backups that preserve encrypted prompt storage", () => {
    const parsed = parseBody(backupImportSchema, {
      schemaVersion: 1,
      mode: "replace",
      characters: [
        {
          id: "private-character-1",
          cardId: "private-character-card-1",
          name: "Private Backup Character",
          avatar: null,
          description: "Backup keeps imported private characters locked.",
          prefix: "",
          prompt: "",
          suffix: "",
          htmlCss: "",
          openingHtml: "<section>Locked prompt</section>",
          loreEntries: {
            __privateCharacter: {
              version: 1,
              algorithm: "aes-256-gcm",
              iv: "backup-iv",
              tag: "backup-tag",
              ciphertext: "backup-ciphertext",
              accessControl: {
                version: 1,
                salt: "backup-salt",
                verifier: "backup-verifier"
              },
              exportSalt: "export-salt"
            }
          },
          quickReplies: [],
          isFavorite: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ],
      chats: [],
      messages: []
    });

    assert.deepEqual(parsed.characters[0]?.loreEntries, {
      __privateCharacter: {
        version: 1,
        algorithm: "aes-256-gcm",
        iv: "backup-iv",
        tag: "backup-tag",
        ciphertext: "backup-ciphertext",
        accessControl: {
          version: 1,
          salt: "backup-salt",
          verifier: "backup-verifier"
        },
        exportSalt: "export-salt"
      }
    });
    assert.equal(parsed.characters[0]?.isFavorite, true);
  });

  it("preserves valid prompt breakdowns and rejects unknown categories", () => {
    const base = {
      schemaVersion: 1,
      mode: "merge",
      characters: [],
      chats: [],
      messages: [
        {
          chatId: "chat-1",
          role: "assistant",
          content: "Reply",
          promptBreakdown: {
            promptTokens: 120,
            promptTokensEstimated: false,
            includedMessageCount: 2,
            sections: [
              {
                id: "character",
                tokenEstimate: 40,
                characterCount: 80,
                itemCount: 1
              },
              {
                id: "history",
                tokenEstimate: 80,
                characterCount: 160,
                itemCount: 2
              }
            ]
          }
        }
      ]
    };
    const parsed = parseBody(backupImportSchema, base);
    assert.equal(parsed.messages[0]?.promptBreakdown?.promptTokens, 120);
    assert.equal(parsed.messages[0]?.promptBreakdown?.sections[1]?.id, "history");

    assert.throws(() =>
      parseBody(backupImportSchema, {
        ...base,
        messages: [
          {
            ...base.messages[0],
            promptBreakdown: {
              ...base.messages[0].promptBreakdown,
              sections: [
                {
                  id: "hidden_tool_output",
                  tokenEstimate: 1,
                  characterCount: 1,
                  itemCount: 1
                }
              ]
            }
          }
        ]
      })
    );
  });

  it("rejects legacy backup character fields that do not use prefix/prompt/suffix", () => {
    assert.throws(() =>
      parseBody(backupImportSchema, {
        schemaVersion: 1,
        mode: "merge",
        characters: [
          {
            name: "Legacy Backup Character",
            cardId: "legacy-backup-card",
            avatar: null,
            description: "Legacy backup",
            prompt: "Main prompt",
            htmlCss: "",
            loreEntries: [],
            quickReplies: [],
            scenario: "Old suffix source",
            systemPrompt: "Old prefix source"
          }
        ],
        chats: [],
        messages: []
      })
    );
  });
});
