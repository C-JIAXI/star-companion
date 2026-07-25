import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { serverConfig } from "../config.js";

const ENCRYPTED_PREFIX = "enc:v1:";

export const isEncryptedApiKey = (value: string | null | undefined) =>
  Boolean(value?.startsWith(ENCRYPTED_PREFIX));

const encryptionKey = () =>
  createHash("sha256").update(serverConfig.apiKeyEncryptionSecret).digest();

export const encryptApiKey = (apiKey: string | null | undefined) => {
  const normalized = apiKey?.trim() ?? "";
  if (!normalized) {
    return null;
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(normalized, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${ENCRYPTED_PREFIX}${iv.toString("base64url")}:${tag.toString(
    "base64url"
  )}:${encrypted.toString("base64url")}`;
};

export const decryptApiKey = (storedApiKey: string | null | undefined) => {
  if (!storedApiKey) {
    return "";
  }

  if (!storedApiKey.startsWith(ENCRYPTED_PREFIX)) {
    return storedApiKey;
  }

  const [, version, ivText, tagText, encryptedText] = storedApiKey.split(":");
  if (version !== "v1" || !ivText || !tagText || !encryptedText) {
    throw new Error("Stored API key is not in a supported encrypted format");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(ivText, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, "base64url")),
    decipher.final()
  ]).toString("utf8");
};

export const hasStoredApiKey = (storedApiKey: string | null | undefined) =>
  Boolean(storedApiKey?.trim());
