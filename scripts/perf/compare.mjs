import { readFile } from "node:fs/promises";
import path from "node:path";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const baselinePath = args.get("--baseline");
const currentPath = args.get("--current");
const threshold = Number(args.get("--threshold") ?? 20);
if (!baselinePath || !currentPath) throw new Error("Usage: npm run perf:compare -- --baseline <result.json> --current <result.json> [--threshold 20]");
if (!Number.isFinite(threshold) || threshold < 0 || threshold > 500) throw new Error("--threshold must be between 0 and 500 percent.");
const baseline = JSON.parse(await readFile(path.resolve(baselinePath), "utf8"));
const current = JSON.parse(await readFile(path.resolve(currentPath), "utf8"));
if (baseline.kind !== current.kind || baseline.profileName !== current.profileName) throw new Error("Only reports with the same runtime kind and dataset profile can be compared.");

const comparisons = [];
const compare = (metric, before, after) => {
  if (!Number.isFinite(before) || !Number.isFinite(after) || before <= 0) return;
  const changePercent = Math.round(((after - before) / before) * 10_000) / 100;
  comparisons.push({ metric, baseline: before, current: after, changePercent, regression: changePercent > threshold });
};
if (Array.isArray(baseline.metrics?.operations) && Array.isArray(current.metrics?.operations)) {
  const currentById = new Map(current.metrics.operations.map((item) => [item.id, item]));
  for (const operation of baseline.metrics.operations) {
    const next = currentById.get(operation.id);
    if (next) compare(`${operation.id}.p95Ms`, operation.timingMs?.p95, next.timingMs?.p95);
  }
  compare("peakRssBytes", baseline.metrics.peakRssBytes, current.metrics.peakRssBytes);
  compare("peakHeapUsedBytes", baseline.metrics.peakHeapUsedBytes, current.metrics.peakHeapUsedBytes);
} else {
  compare("interactiveMs", baseline.metrics?.interactiveMs, current.metrics?.interactiveMs);
  compare("heapUsedBytes", baseline.metrics?.heapUsedBytes, current.metrics?.heapUsedBytes);
  compare("maxLongTaskMs", baseline.metrics?.maxLongTaskMs, current.metrics?.maxLongTaskMs);
}
const regressions = comparisons.filter((item) => item.regression);
const result = { kind: "comparison", runtime: current.kind, profileName: current.profileName, thresholdPercent: threshold, comparisons, regressions, success: current.success === true && regressions.length === 0 };
console.log(JSON.stringify(result, null, 2));
if (!result.success) process.exitCode = 1;
