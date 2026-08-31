import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { UserSettings } from "@prisma/client";
import {
  cancelMemoryEmbeddingJob,
  getMemoryEmbeddingJob,
  resetMemoryEmbeddingJobsForTests,
  startMemoryEmbeddingJob
} from "./memoryEmbeddingJobs.js";

const settings = {} as UserSettings;
const waitFor = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for memory embedding job state");
};

describe("memory embedding jobs", () => {
  afterEach(() => resetMemoryEmbeddingJobsForTests());

  it("reports bounded progress without exposing memory content", async () => {
    const started = startMemoryEmbeddingJob({
      chatId: "chat-progress",
      settings,
      total: 10_000,
      runner: async ({ onProgress }) => {
        onProgress({ completed: 64, total: 10_000 });
        onProgress({ completed: 10_000, total: 10_000 });
        return {};
      }
    });
    await waitFor(() => getMemoryEmbeddingJob("chat-progress", started.id)?.state === "completed");
    const completed = getMemoryEmbeddingJob("chat-progress", started.id);
    assert.equal(completed?.completed, 10_000);
    assert.equal(completed?.failed, 0);
    assert.equal(JSON.stringify(completed).includes("content"), false);
  });

  it("cancels an active rebuild without marking untouched memories failed", async () => {
    const started = startMemoryEmbeddingJob({
      chatId: "chat-cancel",
      settings,
      total: 128,
      runner: ({ signal, onProgress }) => new Promise((resolve) => {
        onProgress({ completed: 64, total: 128 });
        signal.addEventListener("abort", () => resolve(null), { once: true });
      })
    });
    await waitFor(() => getMemoryEmbeddingJob("chat-cancel", started.id)?.state === "running");
    const cancelled = cancelMemoryEmbeddingJob("chat-cancel", started.id);
    assert.equal(cancelled?.state, "cancelled");
    assert.equal(cancelled?.completed, 64);
    assert.equal(cancelled?.failed, 0);
  });
});
