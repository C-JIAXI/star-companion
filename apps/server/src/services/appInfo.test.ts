import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSafeDiagnostics, getAppInfo } from "./appInfo.js";

describe("application diagnostics", () => {
  it("reports build and migration metadata without copying sensitive environment values", () => {
    const secret = "super-secret-api-key";
    const persona = "private persona content";
    const info = getAppInfo({
      STAR_COMPANION_PLATFORM: "windows",
      STAR_COMPANION_BUILD_TYPE: "release",
      STAR_COMPANION_BUILD_COMMIT: "0123456789abcdef",
      STAR_COMPANION_MIGRATION_REPORT: JSON.stringify({ status: "upgraded", appliedMigrations: ["one"], recoveryCreated: true }),
      API_KEY_ENCRYPTION_SECRET: secret,
      USER_PERSONA: persona
    });
    const diagnostic = createSafeDiagnostics(info);
    assert.equal(info.update.capability, "desktop");
    assert.doesNotMatch(diagnostic, new RegExp(secret));
    assert.doesNotMatch(diagnostic, new RegExp(persona));
    assert.ok(!diagnostic.includes(process.cwd()));
  });

  it("rejects unsafe external update URLs and malformed migration reports", () => {
    const info = getAppInfo({
      STAR_COMPANION_PLATFORM: "android",
      STAR_COMPANION_ANDROID_STORE_URL: "http://unsafe.example/app.apk",
      STAR_COMPANION_MIGRATION_REPORT: "not-json"
    });
    assert.deepEqual(info.update, { capability: "disabled", externalUrl: null });
    assert.equal(info.migration.status, "unknown");
  });
});
