import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const output = path.join(root, "dist", "android");
await mkdir(output, { recursive: true });
const sources = [
  [path.join(root, "android", "app", "build", "outputs", "apk", "release", `Star-Companion-${packageJson.version}-android-release.apk`), `Star-Companion-${packageJson.version}-android-release.apk`],
  [path.join(root, "android", "app", "build", "outputs", "bundle", "release", "app-release.aab"), `Star-Companion-${packageJson.version}-android-release.aab`]
];
for (const [source, name] of sources) await copyFile(source, path.join(output, name));
console.log(`Collected versioned Android release artifacts for ${packageJson.version}.`);
