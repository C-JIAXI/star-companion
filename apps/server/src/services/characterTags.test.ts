import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyCharacterTagOperation } from "./characterTags.js";

describe("applyCharacterTagOperation", () => {
  it("adds tags without duplicating existing values by case", () => {
    assert.deepEqual(
      applyCharacterTagOperation(["Fantasy", "night"], "add", ["fantasy", "Mystery"]),
      ["Fantasy", "night", "Mystery"]
    );
  });

  it("removes matching tags without changing unrelated values", () => {
    assert.deepEqual(
      applyCharacterTagOperation(["Fantasy", "night", "Mystery"], "remove", ["NIGHT"]),
      ["Fantasy", "Mystery"]
    );
  });

  it("rejects additions that would exceed the character tag limit", () => {
    assert.throws(
      () =>
        applyCharacterTagOperation(
          Array.from({ length: 24 }, (_, index) => `tag-${index}`),
          "add",
          ["overflow"]
        ),
      (error: unknown) =>
        error instanceof RangeError &&
        error.message === "A character cannot have more than 24 tags"
    );
  });
});
