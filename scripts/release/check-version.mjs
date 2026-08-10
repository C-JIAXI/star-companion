import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { androidVersionCode, readMigrationCatalog } from "./version-core.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const migrations = await readMigrationCatalog(path.join(root, "apps/server/prisma/migrations"));
const expected = {
  appVersion: packageJson.version,
  schemaVersion: migrations.at(-1).name,
  schemaChecksum: migrations.at(-1).checksum,
  androidVersionCode: androidVersionCode(packageJson.version)
};
const generated = await readFile(path.join(root, "apps/server/src/generated/buildInfo.ts"), "utf8");
for (const value of Object.values(expected)) {
  if (!generated.includes(String(value))) {
    throw new Error("Generated version metadata is stale. Run npm run version:generate.");
  }
}
const gradle = await readFile(path.join(root, "android/app/build.gradle"), "utf8");
if (/starCompanionVersionName\s*=\s*["']/.test(gradle) || /versionCode\s+\d+/.test(gradle)) {
  throw new Error("Android version values must be derived from the root package.json.");
}
console.log(`Version metadata is consistent: ${expected.appVersion}, Android ${expected.androidVersionCode}, schema ${expected.schemaVersion}.`);
