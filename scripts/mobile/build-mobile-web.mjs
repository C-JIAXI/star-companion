import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      stdio: "inherit",
      env: options.env ?? process.env
    });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} failed: ${code}`))
    );
  });

const npmCommand = process.platform === "win32" ? "cmd.exe" : "npm";
const npmArgs = (args) => (process.platform === "win32" ? ["/d", "/s", "/c", `npm ${args.join(" ")}`] : args);

await run(npmCommand, npmArgs(["run", "build", "--prefix", "packages/shared"]));
await run(npmCommand, npmArgs(["run", "build", "--prefix", "apps/server"]));
await run(npmCommand, npmArgs(["run", "build", "--prefix", "apps/web"]), {
  env: {
    ...process.env,
    VITE_API_BASE_URL: process.env.VITE_API_BASE_URL || "http://127.0.0.1:4110"
  }
});
await run("node", ["scripts/mobile/prepare-mobile-backend.mjs"]);
