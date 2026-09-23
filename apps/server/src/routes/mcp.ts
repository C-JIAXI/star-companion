import { Router } from "express";
import { asyncHandler, parseBody } from "../lib/http.js";
import { mcpConnectionCheckSchema, mcpConnectionCreateSchema, mcpConnectionDeleteSchema, mcpConnectionUpdateSchema, mcpToolEnableSchema } from "../schemas.js";
import { checkMcpConnection, createMcpConnection, deleteMcpConnection, listMcpConnections, setMcpToolEnabled, updateMcpConnection } from "../services/mcpRegistry.js";

export const mcpRouter = Router();
mcpRouter.get("/", asyncHandler(async (_request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.json({ ok: true, data: await listMcpConnections() });
}));
mcpRouter.post("/", asyncHandler(async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.status(201).json({ ok: true, data: await createMcpConnection(parseBody(mcpConnectionCreateSchema, request.body)) });
}));
mcpRouter.put("/:id", asyncHandler(async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.json({ ok: true, data: await updateMcpConnection(String(request.params.id), parseBody(mcpConnectionUpdateSchema, request.body)) });
}));
mcpRouter.post("/:id/check", asyncHandler(async (request, response) => {
  const input = parseBody(mcpConnectionCheckSchema, request.body);
  response.setHeader("Cache-Control", "no-store");
  response.json({ ok: true, data: await checkMcpConnection(String(request.params.id), input.expectedVersion) });
}));
mcpRouter.put("/:id/tools", asyncHandler(async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.json({ ok: true, data: await setMcpToolEnabled(String(request.params.id), parseBody(mcpToolEnableSchema, request.body)) });
}));
mcpRouter.delete("/:id", asyncHandler(async (request, response) => {
  const input = parseBody(mcpConnectionDeleteSchema, request.body);
  response.setHeader("Cache-Control", "no-store");
  response.json({ ok: true, data: await deleteMcpConnection(String(request.params.id), input.expectedVersion) });
}));
