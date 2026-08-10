import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

const rootDirectory = fileURLToPath(new URL("../../", import.meta.url));
const rootPackage = JSON.parse(readFileSync(path.join(rootDirectory, "package.json"), "utf8")) as { version: string };
const migrationDirectory = path.join(rootDirectory, "apps/server/prisma/migrations");
const schemaVersion = readdirSync(migrationDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()
  .at(-1);
if (!schemaVersion) throw new Error("No schema migration is available for the web build.");
const schemaChecksum = createHash("sha256")
  .update(readFileSync(path.join(migrationDirectory, schemaVersion, "migration.sql"), "utf8"))
  .digest("hex");

export default defineConfig({
  plugins: [react()],
  define: {
    __STAR_COMPANION_APP_VERSION__: JSON.stringify(rootPackage.version),
    __STAR_COMPANION_SCHEMA_VERSION__: JSON.stringify(schemaVersion),
    __STAR_COMPANION_SCHEMA_CHECKSUM__: JSON.stringify(schemaChecksum),
    __STAR_COMPANION_BUILD_COMMIT__: JSON.stringify((process.env.STAR_COMPANION_BUILD_COMMIT || process.env.GITHUB_SHA || "").slice(0, 12) || null)
  },
  resolve: {
    alias: {
      "@local-roleplay/shared": fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url))
    }
  },
  build: {
    manifest: true,
    rollupOptions: {
      output: {
        manualChunks: {
          "react-vendor": ["react", "react-dom"],
          "ui-vendor": ["lucide-react"],
          "markdown-vendor": ["marked", "dompurify"]
        }
      }
    }
  },
  server: {
    port: 5173,
    proxy: {
      "/api": process.env.VITE_API_TARGET || "http://localhost:4000"
    }
  }
});
