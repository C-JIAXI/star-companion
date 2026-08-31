import type { StorageCleanupAction, StorageCleanupPlanDTO, StorageCleanupResultDTO, StorageDeepScanDTO, StorageHealthSnapshotDTO } from "../types";
import { request } from "./api";

export const storageHealthApi = {
  summary: () => request<StorageHealthSnapshotDTO>("/api/storage-health/summary"),
  startDeepScan: () => request<StorageDeepScanDTO>("/api/storage-health/deep-scans", { method: "POST" }),
  deepScan: (id: string) => request<StorageDeepScanDTO>(`/api/storage-health/deep-scans/${encodeURIComponent(id)}`),
  cancelDeepScan: (id: string) => request<StorageDeepScanDTO>(`/api/storage-health/deep-scans/${encodeURIComponent(id)}`, { method: "DELETE" }),
  createCleanupPlan: (actions: StorageCleanupAction[]) => request<StorageCleanupPlanDTO>("/api/storage-health/cleanup-plans", { method: "POST", body: { actions } }),
  executeCleanupPlan: (id: string) => request<StorageCleanupResultDTO>(`/api/storage-health/cleanup-plans/${encodeURIComponent(id)}/execute`, { method: "POST", body: { confirm: "EXECUTE_STORAGE_CLEANUP" } })
};
