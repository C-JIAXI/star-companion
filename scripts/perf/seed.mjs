import path from "node:path";
import { fileURLToPath } from "node:url";
import { PERF_DATASET_PROFILES, seedPerformanceDataset } from "./dataset.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const profileName = args.get("--profile") ?? "small";
const output = args.get("--output");
const seed = Number(args.get("--seed") ?? 20260831);
if (!output) throw new Error("Pass an explicit temporary directory with --output. The generator never defaults to a development database.");
if (!(profileName in PERF_DATASET_PROFILES)) throw new Error(`Unknown profile ${profileName}.`);
if (!Number.isSafeInteger(seed)) throw new Error("--seed must be a safe integer.");
const directory = path.resolve(output);
const metadata = await seedPerformanceDataset({ profileName, seed, databasePath: path.join(directory, "performance.db"), mediaDirectory: path.join(directory, "media"), migrationsDirectory: path.join(root, "apps/server/prisma/migrations") });
console.log(JSON.stringify({ ok: true, databasePath: path.join(directory, "performance.db"), mediaDirectory: path.join(directory, "media"), metadata }, null, 2));
