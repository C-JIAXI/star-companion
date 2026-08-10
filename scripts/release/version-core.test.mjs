import assert from "node:assert/strict";
import test from "node:test";
import { androidVersionCode, compareAppVersions, parseAppVersion } from "./version-core.mjs";

test("parses semantic application versions", () => {
  assert.deepEqual(parseAppVersion("1.2.3"), {
    raw: "1.2.3", major: 1, minor: 2, patch: 3, prerelease: null, build: null
  });
  assert.equal(parseAppVersion("2.0.0-beta.1+build.4").prerelease, "beta.1");
  assert.throws(() => parseAppVersion("1.2"));
});

test("compares application versions and derives monotonic Android codes", () => {
  assert.equal(compareAppVersions("1.0.2", "1.1.0"), -1);
  assert.equal(compareAppVersions("1.0.2", "1.0.2"), 0);
  assert.equal(compareAppVersions("2.0.0", "1.999.999"), 1);
  assert.equal(androidVersionCode("1.0.2"), 1_000_002);
  assert.equal(androidVersionCode("1.1.0"), 1_001_000);
});
