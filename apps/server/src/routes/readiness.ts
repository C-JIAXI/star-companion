import { Router } from "express";
import { asyncHandler, HttpError } from "../lib/http.js";
import { getOrCreateSettings } from "./settings.js";
import { loadReadiness } from "../services/readiness.js";
import {
  cancelConnectionTest,
  ConnectionTestAlreadyRunningError,
  runConnectionTest
} from "../services/connectionDiagnostics.js";

export const readinessRouter = Router();

readinessRouter.get(
  "/",
  asyncHandler(async (_request, response) => {
    const settings = await getOrCreateSettings();
    response.json({ ok: true, data: await loadReadiness(settings) });
  })
);

readinessRouter.post(
  "/connection-tests",
  asyncHandler(async (request, response) => {
    const mode = request.body?.mode === "inference" ? "inference" : "metadata";
    try {
      const settings = await getOrCreateSettings();
      response.json({
        ok: true,
        data: await runConnectionTest({
          settings,
          mode,
          confirmCost: request.body?.confirmCost === true
        })
      });
    } catch (error) {
      if (error instanceof ConnectionTestAlreadyRunningError) {
        throw new HttpError(409, error.message, { testId: error.testId });
      }
      throw error;
    }
  })
);

readinessRouter.delete(
  "/connection-tests/:testId",
  asyncHandler(async (request, response) => {
    const testId = request.params.testId;
    if (!testId || Array.isArray(testId)) throw new HttpError(400, "Missing connection test id.");
    if (!cancelConnectionTest(testId)) throw new HttpError(404, "Connection test is no longer running.");
    response.json({ ok: true, data: { cancelled: true, testId } });
  })
);
