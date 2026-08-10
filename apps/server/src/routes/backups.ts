import { Router } from "express";
import { asyncHandler, parseBody, requireParam } from "../lib/http.js";
import { backupExecuteSchema, backupPreviewRequestSchema } from "../schemas.js";
import {
  exportBackup,
  importBackup,
  listRecoveryPoints,
  previewBackup,
  restoreRecoveryPoint
} from "../services/backups.js";

export const backupsRouter = Router();

backupsRouter.get(
  "/export",
  asyncHandler(async (_request, response) => {
    response.json({ ok: true, data: await exportBackup() });
  })
);

backupsRouter.post(
  "/preview",
  asyncHandler(async (request, response) => {
    const backup = parseBody(backupPreviewRequestSchema, request.body);
    response.json({ ok: true, data: await previewBackup(backup) });
  })
);

backupsRouter.post(
  "/import",
  asyncHandler(async (request, response) => {
    const backup = parseBody(backupExecuteSchema, request.body);
    response.json({ ok: true, data: await importBackup(backup) });
  })
);

backupsRouter.get(
  "/recovery-points",
  asyncHandler(async (_request, response) => {
    response.json({ ok: true, data: await listRecoveryPoints() });
  })
);

backupsRouter.post(
  "/recovery-points/:id/restore",
  asyncHandler(async (request, response) => {
    response.json({
      ok: true,
      data: await restoreRecoveryPoint(requireParam(request, "id"))
    });
  })
);
