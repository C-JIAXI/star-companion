import { HttpError } from "../lib/http.js";

type CursorPayload = {
  version: 1;
  kind: "messages" | "chats" | "message-search" | "memories";
  scope: string;
  createdAt?: string;
  updatedAt?: string;
  id: string;
  pinned?: boolean;
};

const isIsoDate = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

export const encodeCursor = (payload: CursorPayload) =>
  Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");

export const decodeCursor = (
  value: string | undefined,
  expected: Pick<CursorPayload, "kind" | "scope">
): CursorPayload | null => {
  if (!value) return null;
  let candidate: unknown;
  try {
    if (value.length > 1_000 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid");
    candidate = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new HttpError(400, "The pagination cursor is invalid or expired.");
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new HttpError(400, "The pagination cursor is invalid or expired.");
  const record = candidate as Record<string, unknown>;
  const allowed = new Set(["version", "kind", "scope", "createdAt", "updatedAt", "id", "pinned"]);
  if (Object.keys(record).some((key) => !allowed.has(key)) || record.version !== 1 || record.kind !== expected.kind || record.scope !== expected.scope || typeof record.id !== "string" || !record.id || record.id.length > 200) {
    throw new HttpError(400, "The pagination cursor does not match this request.");
  }
  if (record.createdAt !== undefined && !isIsoDate(record.createdAt)) throw new HttpError(400, "The pagination cursor contains an invalid timestamp.");
  if (record.updatedAt !== undefined && !isIsoDate(record.updatedAt)) throw new HttpError(400, "The pagination cursor contains an invalid timestamp.");
  if (record.pinned !== undefined && typeof record.pinned !== "boolean") throw new HttpError(400, "The pagination cursor is invalid or expired.");
  return record as CursorPayload;
};
