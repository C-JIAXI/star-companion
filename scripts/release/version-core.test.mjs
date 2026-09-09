import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

test("version metadata survives a Windows-style clean Git checkout", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "star-companion-version-checkout-"));
  const repository = path.join(temporary, "repo");
  const checkout = path.join(temporary, "checkout");
  const git = (args) => {
    const result = spawnSync("git", args, { cwd: repository, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    await mkdir(repository);
    await mkdir(checkout);
    git(["init", "--quiet"]);
    git(["config", "core.autocrlf", "false"]);
    const files = [
      "package.json", "android/app/build.gradle", "apps/server/src/generated/buildInfo.ts",
      "scripts/release/check-version.mjs", "scripts/release/version-core.mjs"
    ];
    const migrationPath = "apps/server/prisma/migrations";
    for (const entry of await readdir(path.join(root, migrationPath), { withFileTypes: true })) {
      if (entry.isDirectory()) files.push(`${migrationPath}/${entry.name}/migration.sql`);
    }
    // Include the real checkout policy, not a policy invented inside this fixture.
    try { await copyFile(path.join(root, ".gitattributes"), path.join(repository, ".gitattributes")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    for (const file of files) {
      await mkdir(path.dirname(path.join(repository, file)), { recursive: true });
      await copyFile(path.join(root, file), path.join(repository, file));
    }
    git(["add", "."]);
    git(["-c", "core.autocrlf=true", "checkout-index", "--all", `--prefix=${checkout.replaceAll("\\", "/")}/`]);
    const result = spawnSync(process.execPath, [path.join(checkout, "scripts/release/check-version.mjs")], {
      cwd: checkout, encoding: "utf8", windowsHide: true
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Version metadata is consistent/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
