import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const directory = path.resolve(args.get("--directory") ?? path.join(root, "perf-results"));
const output = path.resolve(args.get("--output") ?? path.join(directory, "report.md"));
const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
if (!names.length) throw new Error(`No JSON performance results were found in ${directory}.`);
const reports = [];
for (const name of names) {
  const report = JSON.parse(await readFile(path.join(directory, name), "utf8"));
  if (["server", "web", "mobile"].includes(report.kind)) reports.push({ name, report });
}
if (!reports.length) throw new Error("No server, web, or mobile benchmark reports were found.");

const mb = (bytes) => bytes == null ? "—" : (bytes / 1024 / 1024).toFixed(1);
const lines = [
  "# Star Companion performance report",
  "",
  `Generated: ${new Date().toISOString()}`,
  "",
  "All datasets are deterministic, synthetic, and created in explicit temporary directories. No user database is used.",
  "",
  "| Runtime | Profile | Dataset (characters / chats / messages / memories) | Peak RSS MB | Peak heap MB | Result |",
  "| --- | --- | ---: | ---: | ---: | --- |"
];
for (const { report } of reports) {
  const dataset = report.dataset ?? {};
  lines.push(`| ${report.kind} | ${report.profileName} | ${dataset.characters ?? "—"} / ${dataset.chats ?? "—"} / ${dataset.messages ?? "—"} / ${dataset.memories ?? "—"} | ${mb(report.metrics?.peakRssBytes)} | ${mb(report.metrics?.peakHeapUsedBytes ?? report.metrics?.heapUsedBytes)} | ${report.success ? "pass" : "fail"} |`);
}
for (const { name, report } of reports) {
  lines.push("", `## ${report.kind}: ${report.profileName}`, "", `Source: \`${name}\``, "");
  if (Array.isArray(report.metrics?.operations)) {
    lines.push("| Operation | Rows | p50 ms | p95 ms | Max ms | Queries |", "| --- | ---: | ---: | ---: | ---: | ---: |");
    for (const operation of report.metrics.operations) {
      const queries = operation.queries ? `${operation.queries.min}-${operation.queries.max}` : "—";
      lines.push(`| ${operation.id} | ${operation.returnedRows} | ${operation.timingMs.p50} | ${operation.timingMs.p95} | ${operation.timingMs.max} | ${queries} |`);
    }
  } else {
    lines.push(`- Interactive: ${report.metrics?.interactiveMs ?? "—"} ms`, `- Rendered message containers: ${report.metrics?.initialMessageContainers ?? "—"} initially, ${report.metrics?.steadyMessageContainers ?? "—"} steady`, `- Anchor violations: ${report.metrics?.anchorViolations ?? "—"}`, `- Long tasks: ${report.metrics?.longTaskCount ?? "—"} (max ${report.metrics?.maxLongTaskMs ?? "—"} ms)`);
  }
}
lines.push("", "## Interpretation", "", "Compare like-for-like runtime, profile, schema, hardware, Node/browser version, sample count, and warm/cold mode. A report is evidence for this environment, not a universal latency guarantee.", "");
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${lines.join("\n")}\n`);
console.log(output);
