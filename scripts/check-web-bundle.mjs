import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webDistDir = path.join(rootDir, "apps", "web", "dist");
const manifestPath = path.join(webDistDir, ".vite", "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

const entryKey = Object.keys(manifest).find((key) => manifest[key]?.isEntry);
if (!entryKey) {
  throw new Error("Web bundle check failed: Vite entry was not found in the manifest.");
}

const staticEntries = new Set();
const visitStaticEntry = (key) => {
  if (staticEntries.has(key)) {
    return;
  }

  const entry = manifest[key];
  if (!entry) {
    throw new Error(`Web bundle check failed: missing manifest entry ${key}.`);
  }

  staticEntries.add(key);
  for (const importedKey of entry.imports ?? []) {
    visitStaticEntry(importedKey);
  }
};
visitStaticEntry(entryKey);

const initialJavaScriptFiles = Array.from(staticEntries, (key) => manifest[key]?.file)
  .filter((file) => typeof file === "string" && file.endsWith(".js"));
const initialJavaScriptBytes = (
  await Promise.all(initialJavaScriptFiles.map((file) => stat(path.join(webDistDir, file))))
).reduce((total, file) => total + file.size, 0);

const maxInitialJavaScriptBytes = 400_000;
if (initialJavaScriptBytes > maxInitialJavaScriptBytes) {
  throw new Error(
    `Web bundle check failed: initial JavaScript is ${initialJavaScriptBytes} bytes, above ${maxInitialJavaScriptBytes}.`
  );
}

const requiredPageChunks = [
  "src/pages/ChatPage.tsx",
  "src/pages/CharactersPage.tsx",
  "src/pages/DocsPage.tsx",
  "src/pages/SettingsPage.tsx"
];
const entryDynamicImports = new Set(manifest[entryKey].dynamicImports ?? []);
const missingPageChunks = requiredPageChunks.filter((key) => !entryDynamicImports.has(key));
if (missingPageChunks.length > 0) {
  throw new Error(
    `Web bundle check failed: page chunks are not lazy-loaded: ${missingPageChunks.join(", ")}.`
  );
}

const editorEntryKey = "src/components/MarkdownEditorInner.tsx";
if (staticEntries.has(editorEntryKey)) {
  throw new Error("Web bundle check failed: the heavy Markdown editor is part of the initial load.");
}

const initialKilobytes = (initialJavaScriptBytes / 1000).toFixed(1);
console.log(
  `Web bundle check passed: ${initialKilobytes} kB initial JavaScript; pages and Markdown editor remain lazy-loaded.`
);
