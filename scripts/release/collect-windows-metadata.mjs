import { copyFile, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const source = path.join(root, "dist", "desktop", "latest.yml");
const target = path.join(root, "dist", "desktop", `Star-Companion-${packageJson.version}-windows-update.yml`);
await copyFile(source, target);
console.log(`Collected versioned Windows update metadata for ${packageJson.version}.`);
