import { randomUUID } from "node:crypto";
import type { UserSettings } from "@prisma/client";
import { refreshChatMemoryEmbeddings, type MemoryEmbeddingProgress } from "./chatMemories.js";

type MemoryEmbeddingJobStatus = {
  id: string;
  chatId: string;
  state: "queued" | "running" | "completed" | "failed" | "cancelled";
  total: number;
  completed: number;
  failed: number;
  createdAt: string;
  updatedAt: string;
  errorCode: "embedding_rebuild_failed" | null;
};

type MemoryEmbeddingRunner = (input: {
  chatId: string;
  settings: UserSettings;
  force: true;
  signal: AbortSignal;
  onProgress: (progress: MemoryEmbeddingProgress) => void;
}) => Promise<unknown | null>;

type RuntimeJob = {
  status: MemoryEmbeddingJobStatus;
  controller: AbortController;
};

const MAX_RETAINED_JOBS = 20;
const jobs = new Map<string, RuntimeJob>();
const activeJobsByChat = new Map<string, string>();

const snapshot = (job: RuntimeJob): MemoryEmbeddingJobStatus => ({ ...job.status });
const timestamp = () => new Date().toISOString();

const pruneJobs = () => {
  const finished = [...jobs.values()]
    .filter((job) => !["queued", "running"].includes(job.status.state))
    .sort((left, right) => left.status.updatedAt.localeCompare(right.status.updatedAt));
  while (jobs.size > MAX_RETAINED_JOBS && finished.length) {
    jobs.delete(finished.shift()!.status.id);
  }
};

export const startMemoryEmbeddingJob = ({
  chatId,
  settings,
  total,
  runner = refreshChatMemoryEmbeddings
}: {
  chatId: string;
  settings: UserSettings;
  total: number;
  runner?: MemoryEmbeddingRunner;
}) => {
  const activeId = activeJobsByChat.get(chatId);
  const active = activeId ? jobs.get(activeId) : undefined;
  if (active && ["queued", "running"].includes(active.status.state)) return snapshot(active);

  const createdAt = timestamp();
  const job: RuntimeJob = {
    controller: new AbortController(),
    status: {
      id: randomUUID(),
      chatId,
      state: "queued",
      total,
      completed: 0,
      failed: 0,
      createdAt,
      updatedAt: createdAt,
      errorCode: null
    }
  };
  jobs.set(job.status.id, job);
  if (total === 0) {
    job.status.state = "completed";
    pruneJobs();
    return snapshot(job);
  }
  activeJobsByChat.set(chatId, job.status.id);
  pruneJobs();

  queueMicrotask(() => {
    void (async () => {
      if (job.controller.signal.aborted) {
        job.status.state = "cancelled";
        job.status.updatedAt = timestamp();
        activeJobsByChat.delete(chatId);
        return;
      }
      job.status.state = "running";
      job.status.updatedAt = timestamp();
      const result = await runner({
        chatId,
        settings,
        force: true,
        signal: job.controller.signal,
        onProgress: ({ completed, total: currentTotal }) => {
          job.status.completed = Math.min(completed, currentTotal);
          job.status.total = currentTotal;
          job.status.updatedAt = timestamp();
        }
      });
      if (job.controller.signal.aborted) {
        job.status.state = "cancelled";
        job.status.failed = 0;
      } else if (result) {
        job.status.state = "completed";
        job.status.completed = job.status.total;
      } else {
        job.status.state = "failed";
        job.status.failed = Math.max(0, job.status.total - job.status.completed);
        job.status.errorCode = "embedding_rebuild_failed";
      }
      job.status.updatedAt = timestamp();
      activeJobsByChat.delete(chatId);
      pruneJobs();
    })().catch(() => {
      job.status.state = job.controller.signal.aborted ? "cancelled" : "failed";
      job.status.failed = job.controller.signal.aborted
        ? 0
        : Math.max(0, job.status.total - job.status.completed);
      job.status.errorCode = job.controller.signal.aborted ? null : "embedding_rebuild_failed";
      job.status.updatedAt = timestamp();
      activeJobsByChat.delete(chatId);
      pruneJobs();
    });
  });

  return snapshot(job);
};

export const getMemoryEmbeddingJob = (chatId: string, jobId: string) => {
  const job = jobs.get(jobId);
  return job?.status.chatId === chatId ? snapshot(job) : null;
};

export const cancelMemoryEmbeddingJob = (chatId: string, jobId: string) => {
  const job = jobs.get(jobId);
  if (!job || job.status.chatId !== chatId) return null;
  if (["queued", "running"].includes(job.status.state)) {
    job.controller.abort();
    job.status.state = "cancelled";
    job.status.failed = 0;
    job.status.updatedAt = timestamp();
    activeJobsByChat.delete(chatId);
  }
  return snapshot(job);
};

export const cancelAllMemoryEmbeddingJobs = () => {
  for (const job of jobs.values()) {
    if (["queued", "running"].includes(job.status.state)) {
      job.controller.abort();
      job.status.state = "cancelled";
      job.status.failed = 0;
      job.status.updatedAt = timestamp();
    }
  }
  activeJobsByChat.clear();
};

/** Test-only reset for the in-process, non-persistent job registry. */
export const resetMemoryEmbeddingJobsForTests = () => {
  cancelAllMemoryEmbeddingJobs();
  jobs.clear();
};
