import { spawn } from "node:child_process";

const npmExecutable = process.platform === "win32" ? "cmd.exe" : "npm";
const npmArgs = (args) => process.platform === "win32"
  ? ["/d", "/s", "/c", `npm ${args.join(" ")}`]
  : args;
const run = (command, args, env = process.env) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: process.cwd(), stdio: "inherit", env });
  child.on("error", reject);
  child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`)));
});

try {
  await run(process.execPath, ["scripts/release/preflight-android-signing.mjs"]);
  await run(npmExecutable, npmArgs(["run", "mobile:sync"]), { ...process.env, STAR_COMPANION_BUILD_TYPE: "release" });
  await run(process.execPath, ["scripts/mobile/run-gradle.mjs", "assembleRelease", "bundleRelease"]);
  await run(process.execPath, ["scripts/release/collect-android-artifacts.mjs"]);
} catch (error) {
  console.error(`[android-release] ${error instanceof Error ? error.message : "Release build failed."}`);
  process.exitCode = 1;
}
