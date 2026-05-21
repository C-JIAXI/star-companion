import "dotenv/config";

const toNumber = (value: string | undefined, fallback: number) => {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const serverConfig = {
  port: toNumber(process.env.SERVER_PORT, 4000),
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
  apiKeyEncryptionSecret:
    process.env.API_KEY_ENCRYPTION_SECRET ?? "local-roleplay-development-secret"
};
