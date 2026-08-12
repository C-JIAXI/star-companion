import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkCharacterQuality, estimateCharacterPromptBudget, type CharacterQualityCode } from "@local-roleplay/shared";

const base = () => ({ name: "Original", avatar: "", description: "Short library description", prefix: "", prompt: "A clear original character prompt.", suffix: "", htmlCss: "", openingHtml: "", loreEntries: [], quickReplies: [] });

describe("character quality checker", () => {
  const expectedSeverity: Record<CharacterQualityCode, "error" | "warning" | "suggestion"> = {
    name_required: "error",
    prompt_empty: "warning",
    prompt_budget_large: "warning",
    prompt_duplicate_segment: "warning",
    description_matches_prompt: "warning",
    description_empty: "suggestion",
    lore_content_empty: "error",
    lore_trigger_invalid: "error",
    lore_keywords_missing: "warning",
    lore_keywords_overlap: "warning",
    quick_reply_label_empty: "error",
    quick_reply_label_duplicate: "warning",
    quick_reply_content_empty: "error",
    opening_html_meaningless: "warning",
    opening_html_too_large: "error",
    html_css_too_large: "error",
    avatar_insecure_url: "warning",
    avatar_invalid_url: "error",
    avatar_data_type_invalid: "error",
    avatar_data_too_large: "error"
  };
  const cases: Array<[CharacterQualityCode, ReturnType<typeof base>]> = [
    ["name_required", { ...base(), name: "  " }],
    ["prompt_empty", { ...base(), prompt: "" }],
    ["prompt_budget_large", { ...base(), prompt: "汉".repeat(8001) }],
    ["prompt_duplicate_segment", { ...base(), prefix: "Repeated original paragraph ".repeat(6), suffix: "Repeated original paragraph ".repeat(6) }],
    ["description_matches_prompt", { ...base(), description: "same text", prompt: " same  text " }],
    ["description_empty", { ...base(), description: "" }],
    ["lore_content_empty", { ...base(), loreEntries: [{ keys: ["a"], content: "", priority: 0, scope: "prompt", triggerMode: "both", alwaysActive: false, enabled: true }] }],
    ["lore_trigger_invalid", { ...base(), loreEntries: [{ keys: ["a"], content: "content", priority: 0, scope: "invalid", triggerMode: "both", alwaysActive: false, enabled: true }] }],
    ["lore_keywords_missing", { ...base(), loreEntries: [{ keys: [], content: "content", priority: 0, scope: "prompt", triggerMode: "both", alwaysActive: false, enabled: true }] }],
    ["lore_keywords_overlap", { ...base(), loreEntries: [{ keys: ["alpha", "beta"], content: "one", priority: 0, scope: "prompt", triggerMode: "both", alwaysActive: false, enabled: true }, { keys: ["alpha", "beta"], content: "two", priority: 0, scope: "prompt", triggerMode: "both", alwaysActive: false, enabled: true }] }],
    ["quick_reply_label_empty", { ...base(), quickReplies: [{ label: "", content: "hello" }] }],
    ["quick_reply_label_duplicate", { ...base(), quickReplies: [{ label: "Hello", content: "a" }, { label: " hello ", content: "b" }] }],
    ["quick_reply_content_empty", { ...base(), quickReplies: [{ label: "Hello", content: "" }] }],
    ["opening_html_meaningless", { ...base(), openingHtml: "<div><br><span>&nbsp;</span></div>" }],
    ["opening_html_too_large", { ...base(), openingHtml: "x".repeat(200_001) }],
    ["html_css_too_large", { ...base(), htmlCss: "x".repeat(100_001) }],
    ["avatar_insecure_url", { ...base(), avatar: "http://example.test/a.png" }],
    ["avatar_invalid_url", { ...base(), avatar: "ftp://example.test/a.png" }],
    ["avatar_data_type_invalid", { ...base(), avatar: "data:text/html;base64,SGk=" }],
    ["avatar_data_too_large", { ...base(), avatar: `data:image/png;base64,${"A".repeat(2_796_208)}` }]
  ];
  for (const [code, draft] of cases) it(`emits stable code and severity ${code}`, () => {
    const emitted = checkCharacterQuality(draft).issues.find((item) => item.code === code);
    assert.ok(emitted);
    assert.equal(emitted.severity, expectedSeverity[code]);
  });

  it("classifies errors, warnings and suggestions without blocking on warnings", () => {
    const issues = checkCharacterQuality({ ...base(), name: "", prompt: "", description: "" }).issues;
    assert.equal(issues.find((item) => item.code === "name_required")?.severity, "error");
    assert.equal(issues.find((item) => item.code === "prompt_empty")?.severity, "warning");
    assert.equal(issues.find((item) => item.code === "description_empty")?.severity, "suggestion");
  });

  it("counts three prompt segments and enabled always-active lore without a model call", () => {
    const budget = estimateCharacterPromptBudget({ ...base(), prefix: "abcd", prompt: "abcdefgh", suffix: "abcdefghijkl", loreEntries: [{ keys: [], content: "abcdefghijklmnop", priority: 0, scope: "prompt", triggerMode: "both", alwaysActive: true, enabled: true }] });
    assert.deepEqual(budget, { prefixTokens: 1, promptTokens: 2, suffixTokens: 3, alwaysActiveLoreTokens: 4, totalTokens: 10, estimated: true });
  });

  it("does not inspect protected fields when private content is unavailable", () => {
    const result = checkCharacterQuality({ ...base(), prompt: "", loreEntries: [{ keys: [], content: "", scope: "bad" }] }, { protectedContentAvailable: false });
    assert.equal(result.protectedContentAvailable, false);
    assert.equal(result.issues.some((item) => ["prompt", "loreEntries", "htmlCss"].includes(item.field)), false);
    assert.equal(result.budget.totalTokens, 0);
  });
});
