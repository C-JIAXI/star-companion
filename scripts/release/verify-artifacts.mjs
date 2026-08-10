import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const platform = process.argv.find((argument) => argument.startsWith("--platform="))?.split("=")[1];
if (!platform || !["windows", "android"].includes(platform)) throw new Error("Use --platform=windows or --platform=android.");
const directory = platform === "windows" ? path.join(root, "dist", "desktop") : path.join(root, "dist", "android");
const names = (await readdir(directory, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name);
if (platform === "windows") {
  if (!names.some((name) => name.endsWith(".exe") && name.includes(packageJson.version))) throw new Error("No versioned Windows installer was found.");
  if (!names.includes("latest.yml")) throw new Error("Windows update metadata latest.yml was not generated.");
} else {
  if (!names.some((name) => name.endsWith(".apk") && name.includes(packageJson.version))) throw new Error("No versioned Android APK was found.");
  if (!names.some((name) => name.endsWith(".aab") && name.includes(packageJson.version))) throw new Error("No versioned Android App Bundle was found.");
}
console.log(`${platform} artifacts match application version ${packageJson.version}.`);
