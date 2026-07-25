import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HttpError } from "../lib/http.js";
import {
  assertCharacterUnlockPassword,
  buildCharacterDuplicateData,
  buildCharacterUpdateData,
  canExportCharacterPublicly,
  createCharacterExportCard,
  importCharacterCard,
  resolveCharacterPromptFields,
  resolveCharacterRecord
} from "./characterCards.js";

const baseCharacter = {
  cardId: "private-card-test-character",
  name: "Private Card Test Character",
  avatar: null,
  description: "Private card test.",
  prefix: "Stay in character.",
  prompt: "This private prompt must remain hidden until the password is provided.",
  suffix: "Keep replies concise.",
  htmlCss: ".card { color: #fff; }",
  loreEntries: [
    {
      id: "entry-1",
      keys: ["signal"],
      content: "Hidden lore entry.",
      priority: 1,
      scope: "prompt" as const,
      triggerMode: "both" as const,
      alwaysActive: false,
      enabled: true
    }
  ]
};

describe("character private cards", () => {
  it("requires a password to export a private character card", () => {
    assert.throws(
      () => createCharacterExportCard(baseCharacter, "private"),
      (error: unknown) =>
        error instanceof HttpError &&
        error.status === 400 &&
        error.message === "Private export password is required"
    );
  });

  it("imports private card without password and hides content until password is provided", () => {
    const exported = createCharacterExportCard(baseCharacter, "private", "open-sesame");
    const imported = importCharacterCard(exported);

    const hidden = resolveCharacterRecord({
      ...baseCharacter,
      ...imported
    });
    assert.equal(hidden.visibility, "private");
    assert.equal(hidden.canViewPrompt, false);
    assert.equal(hidden.prefix, "");
    assert.equal(hidden.prompt, "");
    assert.equal(hidden.suffix, "");
    assert.deepEqual(hidden.loreEntries, []);

    const wrongPassword = resolveCharacterRecord(
      { ...baseCharacter, ...imported },
      "wrong-password"
    );
    assert.equal(wrongPassword.canViewPrompt, false);

    const unlocked = resolveCharacterRecord(
      { ...baseCharacter, ...imported },
      "open-sesame"
    );
    assert.equal(unlocked.canViewPrompt, true);
    assert.equal(unlocked.prompt, baseCharacter.prompt);
    assert.deepEqual(unlocked.loreEntries, baseCharacter.loreEntries);

    const promptFields = resolveCharacterPromptFields(
      { ...baseCharacter, ...imported },
      "open-sesame"
    );
    assert.equal(promptFields.prompt, baseCharacter.prompt);
    assert.equal(promptFields.suffix, baseCharacter.suffix);
    assert.deepEqual(promptFields.loreEntries, baseCharacter.loreEntries);
  });

  it("validates the password before unlocking or publicly exporting private cards", () => {
    const exported = createCharacterExportCard(baseCharacter, "private", "open-sesame");
    const imported = importCharacterCard(exported);

    assert.equal(canExportCharacterPublicly({ loreEntries: imported.loreEntries }), false);
    assert.equal(
      canExportCharacterPublicly({ loreEntries: imported.loreEntries }, "open-sesame"),
      true
    );

    assert.throws(
      () => assertCharacterUnlockPassword({ loreEntries: imported.loreEntries }, "wrong-password"),
      (error: unknown) =>
        error instanceof HttpError &&
        error.status === 403 &&
        error.message === "Private character password is invalid"
    );

    assert.doesNotThrow(() =>
      assertCharacterUnlockPassword({ loreEntries: imported.loreEntries }, "open-sesame")
    );
  });

  it("updates local favorite metadata without decrypting private prompts", () => {
    const exported = createCharacterExportCard(baseCharacter, "private", "open-sesame");
    const imported = importCharacterCard(exported);
    const update = buildCharacterUpdateData(
      { ...baseCharacter, loreEntries: imported.loreEntries },
      { isFavorite: true }
    );

    assert.equal(update.isFavorite, true);
    assert.equal("loreEntries" in update, false);
  });

  it("duplicates private character storage without exposing its prompt", () => {
    const exported = createCharacterExportCard(baseCharacter, "private", "open-sesame");
    const imported = importCharacterCard(exported);
    const duplicate = buildCharacterDuplicateData(
      {
        id: "source-id",
        ...baseCharacter,
        openingHtml: "",
        tags: [],
        loreEntries: imported.loreEntries,
        quickReplies: [],
        isFavorite: true,
        createdAt: new Date(),
        updatedAt: new Date()
      },
      "Private Card Test Character copy"
    );

    assert.equal(duplicate.name, "Private Card Test Character copy");
    assert.equal(duplicate.isFavorite, false);
    assert.deepEqual(duplicate.loreEntries, imported.loreEntries);
    assert.equal("cardId" in duplicate, false);
  });
});
