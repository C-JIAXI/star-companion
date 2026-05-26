import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HttpError } from "../lib/http.js";
import {
  assertCharacterUnlockPassword,
  canExportCharacterPublicly,
  createCharacterExportCard,
  importCharacterCard,
  resolveCharacterPromptFields,
  resolveCharacterRecord
} from "./characterCards.js";

const baseCharacter = {
  name: "Private Card Test Character",
  avatar: null,
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

  it("hides imported private prompt content until the password is provided", () => {
    const exported = createCharacterExportCard(baseCharacter, "private", "open-sesame");
    const imported = importCharacterCard(exported);
    const hidden = resolveCharacterRecord({
      ...baseCharacter,
      ...imported
    });
    const unlocked = resolveCharacterRecord(
      {
        ...baseCharacter,
        ...imported
      },
      "open-sesame"
    );
    const promptFields = resolveCharacterPromptFields({
      ...baseCharacter,
      ...imported
    });

    assert.equal(hidden.visibility, "private");
    assert.equal(hidden.canViewPrompt, false);
    assert.equal(hidden.prefix, "");
    assert.equal(hidden.prompt, "");
    assert.equal(hidden.suffix, "");
    assert.equal(hidden.htmlCss, "");
    assert.deepEqual(hidden.loreEntries, []);

    assert.equal(unlocked.canViewPrompt, true);
    assert.equal(unlocked.prompt, baseCharacter.prompt);
    assert.deepEqual(unlocked.loreEntries, baseCharacter.loreEntries);

    assert.equal(promptFields.prompt, baseCharacter.prompt);
    assert.equal(promptFields.suffix, baseCharacter.suffix);
    assert.deepEqual(promptFields.loreEntries, baseCharacter.loreEntries);
  });

  it("validates the password before unlocking or publicly exporting private cards", () => {
    const exported = createCharacterExportCard(baseCharacter, "private", "open-sesame");
    const imported = importCharacterCard(exported);
    const character = {
      ...baseCharacter,
      ...imported
    };

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
    assert.equal(resolveCharacterRecord(character, "wrong-password").canViewPrompt, false);
  });
});
