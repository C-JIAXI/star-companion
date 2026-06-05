import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const subprojects = ["packages/shared", "apps/server", "apps/web", "apps/mobile-backend"];

const fallbackNpmCliPath = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const npmExecPath = process.env.npm_execpath || (existsSync(fallbackNpmCliPath) ? fallbackNpmCliPath : "");

const runNpmInstall = (prefix) => {
  const fallbackToShell = !npmExecPath && process.platform === "win32";
  const command = npmExecPath ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
  const args = npmExecPath ? [npmExecPath, "install", "--ignore-scripts"] : ["install", "--ignore-scripts"];

  console.log(`[postinstall] Installing dependencies for ${prefix}`);
  const result = spawnSync(command, args, {
    cwd: prefix,
    stdio: "inherit",
    shell: fallbackToShell
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

for (const subproject of subprojects) {
  runNpmInstall(subproject);
}
