import type { NextFunction, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { ZodError, type ZodType } from "zod";
import { ModelCallError } from "../services/modelErrors.js";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
  }
}

export const asyncHandler =
  (handler: (request: Request, response: Response, next: NextFunction) => Promise<void>) =>
  (request: Request, response: Response, next: NextFunction) => {
    void handler(request, response, next).catch(next);
  };

export const parseBody = <T>(schema: ZodType<T>, body: unknown): T => {
  const result = schema.safeParse(body);

  if (!result.success) {
    throw new HttpError(400, "Request body validation failed", formatZodError(result.error));
  }

  return result.data;
};

export const parseQuery = <T>(schema: ZodType<T>, query: unknown): T => {
  const result = schema.safeParse(query);

  if (!result.success) {
    throw new HttpError(400, "Query validation failed", formatZodError(result.error));
  }

  return result.data;
};

export const requireParam = (request: Request, name: string): string => {
  const value = request.params[name];

  if (!value || Array.isArray(value)) {
    throw new HttpError(400, `Missing route parameter: ${name}`);
  }

  return value;
};

const formatZodError = (error: ZodError) =>
  error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message
  }));

export const errorMiddleware = (
  error: unknown,
  _request: Request,
  response: Response,
  _next: NextFunction
) => {
  if (error instanceof HttpError) {
    response.status(error.status).json({
      ok: false,
      error: error.message,
      details: error.details
    });
    return;
  }

  if (error instanceof ZodError) {
    response.status(400).json({
      ok: false,
      error: "Validation failed",
      details: formatZodError(error)
    });
    return;
  }

  if (error instanceof ModelCallError) {
    const status = error.safe.code === "authentication" ? 401
      : error.safe.code === "permission_denied" ? 403
      : error.safe.code === "model_not_found" ? 404
        : error.safe.code === "rate_limited" ? 429
          : error.safe.code === "budget_blocked" ? 409
            : error.safe.code === "invalid_request" || error.safe.code === "invalid_url" || error.safe.code === "configuration_incomplete" || error.safe.code === "context_overflow" || error.safe.code === "unsupported_capability" ? 400
              : 502;
    response.status(status).json({ ok: false, error: error.safe.summary, modelError: error.safe });
    return;
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
    response.status(404).json({ ok: false, error: "Record not found" });
    return;
  }

  if (error instanceof SyntaxError && "body" in error) {
    response.status(400).json({ ok: false, error: "Malformed JSON request body" });
    return;
  }

  // Unexpected errors are intentionally opaque: the original value may hold
  // provider bodies, prompts, encrypted configuration details, or local paths.
  response.status(500).json({ ok: false, error: "Internal server error" });
};
