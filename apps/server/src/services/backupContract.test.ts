import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { backupImportSchema } from "../schemas.js";
import { analyzeBackupCandidate } from "./backupContract.js";

const emptyCurrent = () =>
  backupImportSchema.parse({
    schemaVersion: 1,
    exportedAt: "2026-08-10T00:00:00.000Z",
    settings: null,
    characters: [],
    chats: [],
    messages: [],
    memories: [],
    mode: "merge"
  });

const character = (name = "Test Character") => ({
  id: "character-1",
  cardId: "card-1",
  name,
  avatar: null,
  description: "",
  tags: [],
  prefix: "",
  prompt: "Original prompt",
  suffix: "",
  htmlCss: "",
  openingHtml: "",
  loreEntries: [],
  quickReplies: [],
  isFavorite: false,
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z"
});

describe("backup preflight contract", () => {
  it("is read-only and reports a conflict-free merge", () => {
    const current = emptyCurrent();
    const candidate = {
      schemaVersion: 1,
      exportedAt: "2026-08-10T01:00:00.000Z",
      mode: "merge" as const,
      characters: [character()],
      chats: [],
      messages: [],
      memories: []
    };
    const beforeCurrent = structuredClone(current);
    const beforeCandidate = structuredClone(candidate);

    const analysis = analyzeBackupCandidate(candidate, current);

    assert.equal(analysis.preview.canExecute, true);
    assert.equal(analysis.preview.counts.added, 1);
    assert.equal(analysis.preview.counts.conflicts, 0);
    assert.deepEqual(current, beforeCurrent);
    assert.deepEqual(candidate, beforeCandidate);
  });

  it("marks different records with the same ID as explicit conflicts", () => {
    const current = backupImportSchema.parse({
      ...emptyCurrent(),
      characters: [character("Local Character")]
    });
    const analysis = analyzeBackupCandidate(
      {
        schemaVersion: 1,
        mode: "merge",
        characters: [character("Peer Character")],
        chats: [],
        messages: [],
        memories: []
      },
      current
    );

    assert.equal(analysis.preview.counts.updated, 1);
    assert.equal(analysis.preview.counts.conflicts, 1);
    assert.deepEqual(analysis.preview.conflicts, [
      { key: "characters:character-1", entity: "characters", id: "character-1" }
    ]);
  });

  it("reports records that replace mode would delete", () => {
    const current = backupImportSchema.parse({
      ...emptyCurrent(),
      characters: [character()]
    });
    const analysis = analyzeBackupCandidate(
      {
        schemaVersion: 1,
        mode: "replace",
        characters: [],
        chats: [],
        messages: [],
        memories: []
      },
      current
    );

    assert.equal(analysis.preview.counts.deleted, 1);
    assert.equal(analysis.preview.requiresRecoveryPoint, true);
  });

  it("rejects damaged versions, invalid dates, and malformed records without exposing values", () => {
    const analysis = analyzeBackupCandidate(
      {
        schemaVersion: 2,
        exportedAt: "not-a-date",
        mode: "merge",
        characters: [{ ...character(), updatedAt: "bad-date" }],
        chats: [],
        messages: [],
        memories: []
      },
      emptyCurrent()
    );

    assert.equal(analysis.preview.canExecute, false);
    assert.ok(analysis.preview.counts.invalid >= 1);
    assert.ok(analysis.preview.issues.some((issue) => issue.code === "schema_version"));
    assert.equal(JSON.stringify(analysis.preview).includes("Original prompt"), false);
  });

  it("rejects missing character, chat, message, and memory references", () => {
    const analysis = analyzeBackupCandidate(
      {
        schemaVersion: 1,
        mode: "merge",
        characters: [],
        chats: [{ id: "chat-1", title: "Chat", characterId: "missing-character" }],
        messages: [{ id: "message-1", chatId: "missing-chat", role: "user", content: "private" }],
        memories: [{
          id: "memory-1",
          chatId: "missing-chat",
          title: "Memory",
          content: "private",
          sourceMessageIds: ["missing-message"]
        }]
      },
      emptyCurrent()
    );

    assert.equal(analysis.preview.canExecute, false);
    assert.ok(analysis.preview.issues.filter((issue) => issue.code === "missing_reference").length >= 3);
    assert.equal(JSON.stringify(analysis.preview).includes("private"), false);
  });

  it("strips top-level and provider API keys from every accepted payload", () => {
    const analysis = analyzeBackupCandidate(
      {
        schemaVersion: 1,
        mode: "merge",
        settings: {
          apiKey: "must-not-survive",
          providers: [{
            id: "provider-1",
            label: "Provider",
            provider: "openai-compatible",
            apiBaseUrl: "https://example.com/v1",
            key: "provider-key-must-not-survive",
            models: []
          }]
        },
        characters: [],
        chats: [],
        messages: [],
        memories: []
      },
      emptyCurrent()
    );

    assert.equal("apiKey" in (analysis.backup.settings ?? {}), false);
    assert.equal("key" in (analysis.backup.settings?.providers?.[0] ?? {}), false);
    assert.equal(JSON.stringify(analysis).includes("must-not-survive"), false);
  });
});
