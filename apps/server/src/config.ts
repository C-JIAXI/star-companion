import "dotenv/config";

const toNumber = (value: string | undefined, fallback: number) => {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseCorsOrigin = (value: string | undefined) => {
  const fallback = "http://localhost:5173";
  const origins = (value ?? fallback)
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  return origins.length === 1 ? origins[0] : origins;
};

export const serverConfig = {
  port: toNumber(process.env.SERVER_PORT, 4000),
  corsOrigin: parseCorsOrigin(process.env.CORS_ORIGIN),
  webDistDir: process.env.WEB_DIST_DIR?.trim() || undefined,
  apiKeyEncryptionSecret:
    process.env.API_KEY_ENCRYPTION_SECRET ?? "local-roleplay-development-secret"
};
