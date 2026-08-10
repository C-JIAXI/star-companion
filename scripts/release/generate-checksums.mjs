import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const requestedPlatform = process.argv.find((argument) => argument.startsWith("--platform="))?.split("=")[1] || "all";
const roots = requestedPlatform === "windows"
  ? [path.join(root, "dist", "desktop")]
  : requestedPlatform === "android"
    ? [path.join(root, "dist", "android"), path.join(root, "android", "app", "build", "outputs", "apk", "debug")]
    : [path.join(root, "dist", "desktop"), path.join(root, "dist", "android"), path.join(root, "android", "app", "build", "outputs", "apk", "debug")];
const allowed = new Set([".exe", ".yml", ".blockmap", ".apk", ".aab"]);
const files = [];
for (const directory of roots) {
  try {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !allowed.has(path.extname(entry.name).toLowerCase())) continue;
      if (!entry.name.includes(packageJson.version) && entry.name !== "latest.yml") continue;
      files.push(path.join(directory, entry.name));
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
if (files.length === 0) {
  throw new Error(`No ${requestedPlatform} release artifacts were found. Build the requested platform first.`);
}
files.sort((left, right) => left.localeCompare(right));
const lines = [];
for (const file of files) {
  const hash = createHash("sha256").update(await readFile(file)).digest("hex");
  lines.push(`${hash}  ${path.relative(root, file).replace(/\\/g, "/")}`);
}
const outputDirectory = path.join(root, "dist", "release");
await mkdir(outputDirectory, { recursive: true });
const output = path.join(outputDirectory, `Star-Companion-${packageJson.version}-${requestedPlatform}-SHA256SUMS.txt`);
await writeFile(output, `${lines.join("\n")}\n`, "utf8");
console.log(`Wrote ${lines.length} checksums to ${path.relative(root, output)}.`);
