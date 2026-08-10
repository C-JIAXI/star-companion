import { spawn } from "node:child_process";
import path from "node:path";

const tasks = process.argv.slice(2);
if (tasks.length === 0) throw new Error("Provide at least one Gradle task.");
const executable = process.platform === "win32" ? "gradlew.bat" : "./gradlew";
const child = spawn(executable, ["--no-daemon", ...tasks], { cwd: path.join(process.cwd(), "android"), stdio: "inherit", shell: process.platform === "win32" });
child.on("error", (error) => {
  console.error(`Unable to start Gradle: ${error.code || error.name}`);
  process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 1));
