import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { androidVersionCode, publicBuildInfo, readMigrationCatalog } from "./version-core.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const migrations = await readMigrationCatalog(path.join(root, "apps/server/prisma/migrations"));
const info = publicBuildInfo({ version: packageJson.version, migrations });
const generatedDirectory = path.join(root, "apps/server/src/generated");
await mkdir(generatedDirectory, { recursive: true });
const output = `// Generated from the root package.json and Prisma migration catalog. Do not edit.\nexport const generatedBuildInfo = ${JSON.stringify({
  appVersion: info.appVersion,
  schemaVersion: info.schemaVersion,
  schemaChecksum: info.schemaChecksum,
  androidVersionCode: androidVersionCode(info.appVersion)
}, null, 2)} as const;\n`;
await writeFile(path.join(generatedDirectory, "buildInfo.ts"), output, "utf8");
console.log(`Generated build info for ${info.appVersion} (${info.schemaVersion}).`);
