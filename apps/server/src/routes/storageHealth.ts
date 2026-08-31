import { Router } from "express";
import { asyncHandler, parseBody, requireParam } from "../lib/http.js";
import { storageCleanupExecuteSchema, storageCleanupPlanRequestSchema } from "../schemas.js";
import {
  cancelStorageDeepScan,
  createStorageCleanupPlan,
  executeStorageCleanupPlan,
  getStorageDeepScan,
  getStorageHealthSnapshot,
  startStorageDeepScan
} from "../services/storageHealth.js";

export const storageHealthRouter = Router();

storageHealthRouter.get("/summary", asyncHandler(async (_request, response) => {
  response.json({ ok: true, data: await getStorageHealthSnapshot() });
}));

storageHealthRouter.post("/deep-scans", asyncHandler(async (_request, response) => {
  response.status(202).json({ ok: true, data: startStorageDeepScan() });
}));

storageHealthRouter.get("/deep-scans/:id", asyncHandler(async (request, response) => {
  response.json({ ok: true, data: getStorageDeepScan(requireParam(request, "id")) });
}));

storageHealthRouter.delete("/deep-scans/:id", asyncHandler(async (request, response) => {
  response.json({ ok: true, data: cancelStorageDeepScan(requireParam(request, "id")) });
}));

storageHealthRouter.post("/cleanup-plans", asyncHandler(async (request, response) => {
  const body = parseBody(storageCleanupPlanRequestSchema, request.body);
  response.status(201).json({ ok: true, data: await createStorageCleanupPlan(body.actions) });
}));

storageHealthRouter.post("/cleanup-plans/:id/execute", asyncHandler(async (request, response) => {
  parseBody(storageCleanupExecuteSchema, request.body);
  response.json({ ok: true, data: await executeStorageCleanupPlan(requireParam(request, "id")) });
}));
