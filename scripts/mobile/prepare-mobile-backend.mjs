import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const mobileBackendDir = path.join(rootDir, "apps", "mobile-backend");
const webNodeDir = path.join(rootDir, "apps", "web", "dist", "nodejs");
const serverDistSource = path.join(rootDir, "apps", "server", "dist");
const serverDistTarget = path.join(mobileBackendDir, "server-dist");
const skipWebNodeCopy = process.env.MOBILE_BACKEND_SKIP_WEB_NODE_COPY === "1";

await rm(serverDistTarget, { recursive: true, force: true });
await cp(serverDistSource, serverDistTarget, { recursive: true });

if (skipWebNodeCopy) {
  await writeFile(
    path.join(serverDistTarget, ".prepared"),
    `preparedAt=${new Date().toISOString()}\nmode=server-dist-only\n`,
    "utf8"
  );
  process.exit(0);
}

await rm(webNodeDir, { recursive: true, force: true });
await mkdir(webNodeDir, { recursive: true });
await cp(path.join(mobileBackendDir, "src"), path.join(webNodeDir, "src"), { recursive: true });
const requestedBuildType = ["development", "preview", "release"].includes(process.env.STAR_COMPANION_BUILD_TYPE)
  ? process.env.STAR_COMPANION_BUILD_TYPE
  : "development";
let externalUpdateUrl = null;
if (process.env.STAR_COMPANION_ANDROID_STORE_URL) {
  const candidate = new URL(process.env.STAR_COMPANION_ANDROID_STORE_URL);
  if (candidate.protocol !== "https:") throw new Error("STAR_COMPANION_ANDROID_STORE_URL must use HTTPS.");
  externalUpdateUrl = candidate.toString();
}
await writeFile(
  path.join(webNodeDir, "src", "build-info.mjs"),
  `// Generated while preparing the Android embedded backend.\nexport const mobileBuildType = ${JSON.stringify(requestedBuildType)};\nexport const mobileExternalUpdateUrl = ${JSON.stringify(externalUpdateUrl)};\n`,
  "utf8"
);
await cp(serverDistTarget, path.join(webNodeDir, "server-dist"), { recursive: true });
await cp(path.join(mobileBackendDir, "node_modules"), path.join(webNodeDir, "node_modules"), {
  recursive: true
});
await cp(path.join(mobileBackendDir, "package.json"), path.join(webNodeDir, "package.json"));

await writeFile(
  path.join(webNodeDir, ".prepared"),
  `preparedAt=${new Date().toISOString()}\n`,
  "utf8"
);
