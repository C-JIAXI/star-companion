const assert = require("node:assert/strict");
const test = require("node:test");
const { classifyUpdateError, createInitialUpdateState, reduceUpdateState } = require("./update-state.cjs");

test("desktop update state covers no update and available update", () => {
  const initial = createInitialUpdateState({ enabled: true, currentVersion: "1.0.2" });
  const checking = reduceUpdateState(initial, { type: "check_started", at: "2026-08-10T00:00:00.000Z" });
  assert.equal(checking.status, "checking");
  assert.equal(reduceUpdateState(checking, { type: "update_not_available", at: "2026-08-10T00:00:01.000Z" }).status, "not_available");
  const available = reduceUpdateState(checking, { type: "update_available", version: "1.1.0", releaseNotes: "Safe upgrade" });
  assert.equal(available.status, "available");
  assert.equal(available.availableVersion, "1.1.0");
});

test("desktop update state covers progress, download failure, deferral, and install confirmation", () => {
  let state = createInitialUpdateState({ enabled: true, currentVersion: "1.0.2" });
  state = reduceUpdateState(state, { type: "update_available", version: "1.1.0" });
  state = reduceUpdateState(state, { type: "download_started" });
  state = reduceUpdateState(state, { type: "download_progress", percent: 42.4, transferred: 42, total: 100 });
  assert.equal(state.progressPercent, 42.4);
  assert.equal(classifyUpdateError(new Error("connection reset"), "downloading"), "download_failed");
  state = reduceUpdateState(state, { type: "downloaded", version: "1.1.0" });
  assert.equal(reduceUpdateState(state, { type: "deferred" }).status, "deferred");
  assert.equal(reduceUpdateState(state, { type: "install_confirmed" }).status, "installing");
});

test("desktop update state separates verification, metadata, and network errors", () => {
  assert.equal(classifyUpdateError(new Error("sha512 checksum mismatch"), "downloading"), "verification_failed");
  assert.equal(classifyUpdateError(new Error("latest.yml YAML parse failed"), "checking"), "metadata_invalid");
  assert.equal(classifyUpdateError(Object.assign(new Error("lookup failed"), { code: "ENOTFOUND" }), "checking"), "network_failed");
});

test("development builds remain disabled and cannot start a real check", () => {
  const state = createInitialUpdateState({ enabled: false, disabledReason: "development_build", currentVersion: "1.0.2" });
  assert.equal(state.status, "disabled");
  assert.equal(reduceUpdateState(state, { type: "check_started" }), state);
});
