import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OrderedTextChunkBuffer } from "@local-roleplay/shared";

describe("ordered streaming chunk buffer", () => {
  it("preserves every byte and order across 10,000 chunks and batched drains", () => {
    const chunks = Array.from({ length: 10_000 }, (_, index) => `${index.toString(36)}:${index % 7 === 0 ? "片段" : "chunk"}|`);
    const buffer = new OrderedTextChunkBuffer();
    let received = "";
    for (let index = 0; index < chunks.length; index += 1) {
      buffer.push(chunks[index]);
      if (index % 37 === 0) received += buffer.drain();
    }
    received += buffer.drain();
    assert.equal(received, chunks.join(""));
    assert.equal(buffer.hasPending, false);
  });

  it("drops pending display-only text immediately when cancellation clears the buffer", () => {
    const buffer = new OrderedTextChunkBuffer();
    buffer.push("pending token");
    buffer.clear();
    assert.equal(buffer.drain(), "");
  });
});
