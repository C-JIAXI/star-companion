import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const mobileBackendDir = path.join(rootDir, "apps", "mobile-backend");
const webNodeDir = path.join(rootDir, "apps", "web", "dist", "nodejs");
const serverDistSource = path.join(rootDir, "apps", "server", "dist");
const serverDistTarget = path.join(mobileBackendDir, "server-dist");

await rm(serverDistTarget, { recursive: true, force: true });
await cp(serverDistSource, serverDistTarget, { recursive: true });

await rm(webNodeDir, { recursive: true, force: true });
await mkdir(webNodeDir, { recursive: true });
await cp(path.join(mobileBackendDir, "src"), path.join(webNodeDir, "src"), { recursive: true });
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
