import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { characterRegexPreviewSchema } from "../schemas.js";
import { runCharacterRegexScripts } from "./characterRegex.js";
import type { CharacterRegexScriptRecord } from "./characterCards.js";

const rule = (overrides: Partial<CharacterRegexScriptRecord> = {}): CharacterRegexScriptRecord => ({
  id: "rule-1",
  title: "Test",
  pattern: "(hello)",
  replacement: "[$1]",
  enabled: true,
  scope: "both",
  renderOnly: false,
  ...overrides
});

describe("character regex scripts", () => {
  it("applies capture groups, empty replacement, and rule order", async () => {
    const scripts = [rule(), rule({ id: "rule-2", pattern: "\\[hello\\]", replacement: "" })];
    assert.deepEqual(await runCharacterRegexScripts([{ content: "hello hello", role: "user" }], scripts, "stored"), [" "]);
    assert.deepEqual(await runCharacterRegexScripts([{ content: "hello", role: "user" }], scripts.slice().reverse(), "stored"), ["[hello]"]);
  });

  it("separates roles and stored versus render-only rules", async () => {
    const scripts = [
      rule({ scope: "assistant", replacement: "saved" }),
      rule({ id: "rule-2", scope: "both", renderOnly: true, replacement: "shown" })
    ];
    assert.deepEqual(await runCharacterRegexScripts([
      { content: "hello", role: "assistant" }, { content: "hello", role: "user" }
    ], scripts, "stored"), ["saved", "hello"]);
    assert.deepEqual(await runCharacterRegexScripts([
      { content: "hello", role: "assistant" }, { content: "hello", role: "user" }
    ], scripts, "render"), ["shown", "shown"]);
  });

  it("rejects invalid patterns and oversized input", async () => {
    const invalid = characterRegexPreviewSchema.safeParse({ scripts: [rule({ pattern: "(" })], content: "hello", role: "user", stage: "stored" });
    assert.equal(invalid.success, false);
    if (!invalid.success) assert.deepEqual(invalid.error.issues[0]?.path, ["scripts", 0, "pattern"]);
    await assert.rejects(() => runCharacterRegexScripts([{ content: "a".repeat(20_001), role: "user" }], [rule()], "stored"), /exceeds 20,000 characters/);
  });

  it("terminates a pathological expression within the execution bound", async () => {
    await assert.rejects(
      () => runCharacterRegexScripts([{ content: `${"a".repeat(10_000)}!`, role: "user" }], [rule({ pattern: "(a+)+$" })], "stored"),
      /1-second execution limit/
    );
  });
});
