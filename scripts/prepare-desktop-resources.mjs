import { spawn } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const serverDir = path.join(repoRoot, "apps", "server");
const webDistDir = path.join(repoRoot, "apps", "web", "dist");
const desktopResourcesDir = path.join(repoRoot, "dist", "desktop-resources");
const desktopServerDir = path.join(desktopResourcesDir, "server");

const runCommand = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const isWindowsNpm = process.platform === "win32" && command === "npm";
    const executable = isWindowsNpm ? "cmd.exe" : command;
    const commandArgs = isWindowsNpm ? ["/d", "/s", "/c", "npm.cmd", ...args] : args;
    const child = spawn(executable, commandArgs, {
      cwd: options.cwd ?? repoRoot,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`));
    });
  });

const withoutPrismaTmpFiles = (source) => !/\.tmp\d*$/i.test(path.basename(source));

await rm(desktopResourcesDir, { recursive: true, force: true });
await mkdir(desktopServerDir, { recursive: true });

await cp(webDistDir, path.join(desktopResourcesDir, "web"), { recursive: true });
await cp(path.join(serverDir, "dist"), path.join(desktopServerDir, "dist"), { recursive: true });
await cp(path.join(serverDir, "prisma"), path.join(desktopServerDir, "prisma"), {
  recursive: true,
  filter: (source) => {
    const relative = path.relative(path.join(serverDir, "prisma"), source);
    return relative === "" || relative === "schema.prisma" || relative.startsWith("migrations");
  }
});

await cp(path.join(serverDir, "package.json"), path.join(desktopServerDir, "package.json"));
await cp(path.join(serverDir, "package-lock.json"), path.join(desktopServerDir, "package-lock.json"));

await runCommand("npm", [
  "ci",
  "--omit=dev",
  "--omit=peer",
  "--omit=optional",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
  "--prefix",
  desktopServerDir
]);

await cp(
  path.join(serverDir, "node_modules", ".prisma"),
  path.join(desktopServerDir, "node_modules", ".prisma"),
  {
    recursive: true,
    filter: withoutPrismaTmpFiles
  }
);

const metadata = {
  preparedAt: new Date().toISOString(),
  source: "scripts/prepare-desktop-resources.mjs"
};

await writeFile(
  path.join(desktopResourcesDir, "desktop-resources.json"),
  `${JSON.stringify(metadata, null, 2)}\n`,
  "utf8"
);

const serverPackageJson = JSON.parse(
  await readFile(path.join(desktopServerDir, "package.json"), "utf8")
);

delete serverPackageJson.devDependencies;
delete serverPackageJson.scripts;

await writeFile(
  path.join(desktopServerDir, "package.json"),
  `${JSON.stringify(serverPackageJson, null, 2)}\n`,
  "utf8"
);
