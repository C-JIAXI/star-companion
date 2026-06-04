import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pngToIco from "png-to-ico";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const sourcePng = path.join(repoRoot, "apps", "web", "public", "app-logo-v2.png");
const desktopAssetsDir = path.join(repoRoot, "apps", "desktop", "assets");
const desktopPng = path.join(desktopAssetsDir, "app-icon.png");
const desktopIco = path.join(desktopAssetsDir, "app-icon.ico");

await mkdir(desktopAssetsDir, { recursive: true });
await cp(sourcePng, desktopPng);

const iconBuffer = await pngToIco(sourcePng);
await writeFile(desktopIco, iconBuffer);
