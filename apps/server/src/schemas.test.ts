import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseBody } from "./lib/http.js";
import {
  backupImportSchema,
  characterExportSchema,
  characterImportSchema,
  characterPageQuerySchema,
  characterUpdateRequestSchema,
  characterUnlockSchema,
  chatUpdateSchema,
  settingsUpdateSchema
} from "./schemas.js";

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
    assert.equal("loreEntries" in parsed, false);
    assert.equal("quickReplies" in parsed, false);
  });
});

describe("settingsUpdateSchema", () => {
  it("accepts showMessageAvatars in settings payloads", () => {
    const parsed = parseBody(settingsUpdateSchema, {
      activeProvider: "openai-compatible",
      apiBaseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      temperature: 0.8,
      maxTokens: 800,
      topP: 1,
      language: "zh-CN",
      models: [],
      showMessageAvatars: false
    });

    assert.equal(parsed.showMessageAvatars, false);
  });

  it("accepts model presets without runtime-only fields", () => {
    const parsed = parseBody(settingsUpdateSchema, {
      activeProvider: "openai-compatible",
      apiBaseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      temperature: 0.8,
      maxTokens: 800,
      topP: 1,
      language: "zh-CN",
      models: [
        {
          id: "preset-1",
          label: "GPT",
          provider: "openai",
          apiBaseUrl: "https://api.openai.com/v1",
          model: "gpt-4o-mini"
        }
      ]
    });

    assert.equal(parsed.models[0]?.model, "gpt-4o-mini");
  });
});

describe("characterPageQuerySchema", () => {
  it("normalizes defaults and clamps page size", () => {
    assert.deepEqual(parseBody(characterPageQuerySchema, {}), {
      q: "",
      page: 1,
      pageSize: 40
    });

    assert.deepEqual(
      parseBody(characterPageQuerySchema, { q: "  pilot  ", page: "2", pageSize: "500" }),
      {
        q: "pilot",
        page: 2,
        pageSize: 100
      }
    );
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
      character: {
        name: "Public Card",
        avatar: null,
        prefix: "Prefix",
        prompt: "Prompt",
        suffix: "Suffix",
        htmlCss: "",
        loreEntries: []
      }
    });
    const privateCard = parseBody(characterImportSchema, {
      schemaVersion: 1,
      format: "character-card",
      visibility: "private",
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
    assert.equal(privateCard.visibility, "private");
  });

  it("rejects legacy character import payloads and private cards without access control", () => {
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
        visibility: "private",
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
  it("accepts imported private character backups that preserve encrypted prompt storage", () => {
    const parsed = parseBody(backupImportSchema, {
      schemaVersion: 1,
      mode: "replace",
      characters: [
        {
          id: "private-character-1",
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
  });

  it("rejects legacy backup character fields that do not use prefix/prompt/suffix", () => {
    assert.throws(() =>
      parseBody(backupImportSchema, {
        schemaVersion: 1,
        mode: "merge",
        characters: [
          {
            name: "Legacy Backup Character",
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
