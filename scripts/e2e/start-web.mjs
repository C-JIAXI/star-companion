import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const child = spawn(process.execPath, [path.join(root, "apps", "web", "node_modules", "vite", "bin", "vite.js"), "--host", "127.0.0.1", "--port", "5174", "--strictPort"], {
  cwd: path.join(root, "apps", "web"),
  env: {
    ...process.env,
    VITE_API_BASE_URL: "http://127.0.0.1:4010",
    VITE_API_TARGET: "http://127.0.0.1:4010"
  },
  stdio: "inherit"
});
const stop = () => { if (child.exitCode === null) child.kill(); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("error", () => process.exit(1));
child.on("exit", (code) => process.exit(code ?? 1));
