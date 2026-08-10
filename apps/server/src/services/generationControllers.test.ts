import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GenerationControllerRegistry } from "./generationControllers.js";

describe("GenerationControllerRegistry", () => {
  it("only aborts requests owned by the disconnected socket", () => {
    const registry = new GenerationControllerRegistry<object>();
    const socketA = {};
    const socketB = {};
    const controllerA = new AbortController();
    const controllerB = new AbortController();

    registry.register("request-a", socketA, controllerA);
    registry.register("request-b", socketB, controllerB);

    assert.equal(registry.abortSocket(socketA), 1);
    assert.equal(controllerA.signal.aborted, true);
    assert.equal(controllerB.signal.aborted, false);
    assert.equal(registry.abortRequest("request-a"), false);
    assert.equal(registry.abortRequest("request-b"), true);
  });

  it("aborts an older controller when a request id is reused", () => {
    const registry = new GenerationControllerRegistry<object>();
    const first = new AbortController();
    const replacement = new AbortController();
    const socket = {};

    registry.register("same-request", socket, first);
    registry.register("same-request", socket, replacement);

    assert.equal(first.signal.aborted, true);
    assert.equal(replacement.signal.aborted, false);
    assert.equal(registry.release("same-request", first), false);
    assert.equal(registry.abortRequest("same-request"), true);
    assert.equal(replacement.signal.aborted, true);
  });
});
