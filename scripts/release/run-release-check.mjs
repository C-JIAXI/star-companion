import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const npmCommand = process.platform === "win32" ? "cmd.exe" : "npm";
const npmArgs = (args) => process.platform === "win32" ? ["/d", "/s", "/c", `npm ${args.join(" ")}`] : args;
const run = (label, command, args, { expectedFailure = false } = {}) => new Promise((resolve, reject) => {
  console.log(`\n[release-check] ${label}`);
  const child = spawn(command, args, { cwd: process.cwd(), env: process.env, stdio: "inherit" });
  child.on("error", reject);
  child.on("exit", (code) => {
    if (code === 0 || expectedFailure) resolve(code ?? 1);
    else reject(new Error(`${label} failed with exit code ${code}`));
  });
});
const npm = (label, script, options) => run(label, npmCommand, npmArgs(["run", script]), options);

await npm("Version consistency", "version:check");
await npm("Lint", "lint");
await npm("Build", "build");
await npm("Server tests", "test:server");
await npm("API smoke", "test:api");
await npm("Mobile backend smoke", "mobile-backend:smoke");
await npm("Browser E2E", "test:e2e");
await npm("Version, updater, and migration safety tests", "test:release-tools");
await npm("Windows unpacked package", "desktop:pack");
await npm("Windows NSIS installer", "desktop:build");
await npm("Packaged Windows startup smoke", "desktop:smoke:packaged");
await npm("Android debug APK", "mobile:build:android");

const windowsCredentials = Boolean((process.env.WIN_CSC_LINK || process.env.CSC_LINK) && (process.env.WIN_CSC_KEY_PASSWORD || process.env.CSC_KEY_PASSWORD));
const androidCredentials = existsSync(path.join(process.cwd(), "android", "signing.properties")) || Boolean(
  process.env.STAR_COMPANION_ANDROID_KEYSTORE_PATH &&
  process.env.STAR_COMPANION_ANDROID_STORE_PASSWORD &&
  process.env.STAR_COMPANION_ANDROID_KEY_ALIAS &&
  process.env.STAR_COMPANION_ANDROID_KEY_PASSWORD
);
const windowsGate = await npm("Windows release signing preflight", "desktop:release:preflight", { expectedFailure: !windowsCredentials });
const androidGate = await npm("Android release signing preflight", "mobile:release:preflight", { expectedFailure: !androidCredentials });
if (!windowsCredentials && windowsGate === 0) throw new Error("Windows release preflight unexpectedly passed without credentials.");
if (!androidCredentials && androidGate === 0) throw new Error("Android release preflight unexpectedly passed without credentials.");

await npm("Verify Windows artifacts", "release:verify:windows");
await run("Windows checksums", process.execPath, ["scripts/release/generate-checksums.mjs", "--platform=windows"]);
await run("Android debug checksums", process.execPath, ["scripts/release/generate-checksums.mjs", "--platform=android"]);
console.log("\n[release-check] All credential-independent release checks passed. Signed release builds remain gated on real credentials.");
