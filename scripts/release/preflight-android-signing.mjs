import { access, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const propertyPath = path.join(root, "android", "signing.properties");
let properties = {};
try {
  const content = await readFile(propertyPath, "utf8");
  properties = Object.fromEntries(content.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#")).map((line) => {
    const separator = line.indexOf("=");
    return separator < 0 ? [line, ""] : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
  }));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const values = {
  storeFile: process.env.STAR_COMPANION_ANDROID_KEYSTORE_PATH || properties.storeFile,
  storePassword: process.env.STAR_COMPANION_ANDROID_STORE_PASSWORD || properties.storePassword,
  keyAlias: process.env.STAR_COMPANION_ANDROID_KEY_ALIAS || properties.keyAlias,
  keyPassword: process.env.STAR_COMPANION_ANDROID_KEY_PASSWORD || properties.keyPassword
};
const missing = Object.entries(values).filter(([, value]) => !value).map(([key]) => key);
if (missing.length) {
  console.error(`Android release signing is not configured. Missing: ${missing.join(", ")}. Use STAR_COMPANION_ANDROID_* variables or untracked android/signing.properties.`);
  process.exit(1);
}
try {
  await access(path.isAbsolute(values.storeFile) ? values.storeFile : path.resolve(root, "android", values.storeFile));
} catch {
  console.error("Android release signing is not configured: the keystore file cannot be read.");
  process.exit(1);
}
console.log("Android release signing inputs are present. Secret values were not printed.");
