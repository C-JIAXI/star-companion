import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { performAutomaticPull } from "./lanAutoSync.js";
import type { pullLanSync } from "./lanSync.js";

const result = (canExecute: boolean, conflicts: Array<{ key: string; entity: "messages"; id: string }> = []) => ({
  direction: "pull" as const,
  phase: "preview" as const,
  mode: "merge" as const,
  peerBaseUrl: "http://peer.test",
  peerExportedAt: null,
  completedAt: null,
  preview: {
    previewId: "stable-preview",
    canExecute,
    conflicts
  },
  summary: null
});

describe("automatic LAN sync policy", () => {
  it("stops after the read-only preview when conflicts need a user choice", async () => {
    const calls: Array<{ phase: string; mode: string; previewId?: string }> = [];
    const pull = (async (input: { phase: string; mode: string; previewId?: string }) => {
      calls.push(input);
      return result(true, [{ key: "messages:message-1", entity: "messages", id: "message-1" }]);
    }) as unknown as typeof pullLanSync;

    const outcome = await performAutomaticPull("http://peer.test", pull);

    assert.equal(outcome.state, "conflicts");
    assert.equal(outcome.conflictCount, 1);
    assert.deepEqual(calls.map(({ phase, mode }) => ({ phase, mode })), [{ phase: "preview", mode: "merge" }]);
  });

  it("does not execute invalid peer data", async () => {
    let calls = 0;
    const pull = (async () => {
      calls += 1;
      return result(false);
    }) as unknown as typeof pullLanSync;

    const outcome = await performAutomaticPull("http://peer.test", pull);

    assert.equal(outcome.state, "failed");
    assert.equal(outcome.errorCode, "preview_blocked");
    assert.equal(calls, 1);
  });

  it("executes merge with the exact preview only when it is conflict-free", async () => {
    const calls: Array<{ phase: string; mode: string; previewId?: string; conflictResolutions?: unknown[] }> = [];
    const pull = (async (input: { phase: string; mode: string; previewId?: string; conflictResolutions?: unknown[] }) => {
      calls.push(input);
      if (input.phase === "preview") return result(true);
      return { ...result(true), phase: "execute", completedAt: "2026-08-31T10:00:00.000Z", summary: {} };
    }) as unknown as typeof pullLanSync;

    const outcome = await performAutomaticPull("http://peer.test", pull);

    assert.equal(outcome.state, "succeeded");
    assert.equal(outcome.completedAt, "2026-08-31T10:00:00.000Z");
    assert.deepEqual(calls.map(({ phase, mode, previewId, conflictResolutions }) => ({ phase, mode, previewId, conflictResolutions })), [
      { phase: "preview", mode: "merge", previewId: undefined, conflictResolutions: [] },
      { phase: "execute", mode: "merge", previewId: "stable-preview", conflictResolutions: [] }
    ]);
  });
});
