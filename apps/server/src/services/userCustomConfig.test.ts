import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getUserCustomConfigSegments,
  parseUserCustomConfig,
  serializeUserCustomConfig
} from "./userCustomConfig.js";

describe("user custom config", () => {
  it("keeps legacy v1 configs readable", () => {
    const parsed = parseUserCustomConfig(
      JSON.stringify({
        type: "user-custom-config",
        version: 1,
        prefix: "Before",
        prompt: "Core",
        suffix: "After"
      })
    );

    assert.deepEqual(parsed, {
      displayName: "",
      prefix: "Before",
      prompt: "Core",
      suffix: "After"
    });
  });

  it("stores a v2 display name without injecting it into prompt segments", () => {
    const serialized = serializeUserCustomConfig({
      displayName: "Rowan",
      prefix: "Before",
      prompt: "Core",
      suffix: "After"
    });

    assert.equal(JSON.parse(serialized).version, 2);
    assert.equal(parseUserCustomConfig(serialized).displayName, "Rowan");
    assert.deepEqual(getUserCustomConfigSegments(serialized), ["Before", "Core", "After"]);
  });

  it("retains an identity-only config", () => {
    const serialized = serializeUserCustomConfig({ displayName: "Rowan" });

    assert.notEqual(serialized, "");
    assert.equal(parseUserCustomConfig(serialized).displayName, "Rowan");
    assert.deepEqual(getUserCustomConfigSegments(serialized), []);
  });
});
