import type { NextFunction, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { ZodError, type ZodType } from "zod";

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

  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
    response.status(404).json({ ok: false, error: "Record not found" });
    return;
  }

  if (error instanceof SyntaxError && "body" in error) {
    response.status(400).json({ ok: false, error: "Malformed JSON request body" });
    return;
  }

  const message = error instanceof Error ? error.message : "Unknown server error";
  response.status(500).json({ ok: false, error: message });
};
