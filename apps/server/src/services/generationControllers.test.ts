import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GenerationControllerRegistry } from "./generationControllers.js";

describe("GenerationControllerRegistry", () => {
  it("keeps paid requests alive when their socket disconnects", () => {
    const registry = new GenerationControllerRegistry<object>();
    const socketA = {};
    const socketB = {};
    const controllerA = new AbortController();
    const controllerB = new AbortController();

    registry.register("request-a", socketA, controllerA);
    registry.register("request-b", socketB, controllerB);

    assert.equal(registry.abortSocket(socketA), 1);
    assert.equal(controllerA.signal.aborted, false);
    assert.equal(controllerB.signal.aborted, false);
    assert.equal(registry.abortRequest("request-a"), true);
    assert.equal(registry.abortRequest("request-b"), true);
  });

  it("rejects a duplicate request id without replacing the running controller", () => {
    const registry = new GenerationControllerRegistry<object>();
    const first = new AbortController();
    const replacement = new AbortController();
    const socket = {};

    registry.register("same-request", socket, first);
    assert.equal(registry.register("same-request", socket, replacement), false);

    assert.equal(first.signal.aborted, false);
    assert.equal(replacement.signal.aborted, false);
    assert.equal(registry.abortRequest("same-request"), true);
    assert.equal(first.signal.aborted, true);
    assert.equal(replacement.signal.aborted, false);
    assert.equal(registry.release("same-request", first), true);
  });
});
