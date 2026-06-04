import { Router } from "express";
import { asyncHandler, parseBody } from "../lib/http.js";
import { backupImportSchema } from "../schemas.js";
import { exportBackup, importBackup } from "../services/backups.js";

export const backupsRouter = Router();

backupsRouter.get(
  "/export",
  asyncHandler(async (_request, response) => {
    response.json({ ok: true, data: await exportBackup() });
  })
);

backupsRouter.post(
  "/import",
  asyncHandler(async (request, response) => {
    const backup = parseBody(backupImportSchema, request.body);
    response.json({ ok: true, data: await importBackup(backup) });
  })
);
