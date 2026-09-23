import { Worker } from "node:worker_threads";
import type { CharacterRegexScriptRecord } from "./characterCards.js";

export type RegexInput = { content: string; role: "assistant" | "user" };
export type RegexStage = "stored" | "render";

const MAX_INPUT_LENGTH = 20_000;
const MAX_OUTPUT_LENGTH = 40_000;
const TIMEOUT_MS = 1_000;
export class CharacterRegexExecutionError extends Error {
  readonly status = 422;
  readonly details = undefined;
}
const executionError = (code: string) => new CharacterRegexExecutionError(
  code === "regex_input_too_long" ? "Character regex input exceeds 20,000 characters."
    : code === "regex_output_too_long" ? "Character regex output exceeds 40,000 characters."
      : code === "regex_timeout" ? "A character regex script exceeded the 1-second execution limit."
        : "A character regex script could not be applied.");

// The worker receives patterns as data. A timed-out expression is terminated with its worker.
const workerSource = `
const { parentPort, workerData } = require("node:worker_threads");
try {
  const result = workerData.inputs.map(({ content, role }) => {
    if (content.length > ${MAX_INPUT_LENGTH}) throw new Error("regex_input_too_long");
    let value = content;
    for (const script of workerData.scripts) {
      if (!script.enabled || script.renderOnly !== (workerData.stage === "render") ||
          (script.scope !== "both" && script.scope !== role)) continue;
      value = value.replace(new RegExp(script.pattern, "g"), script.replacement);
      if (value.length > ${MAX_OUTPUT_LENGTH}) throw new Error("regex_output_too_long");
    }
    return value;
  });
  parentPort.postMessage({ result });
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? error.message : "regex_failed" });
}
`;

export const runCharacterRegexScripts = async (
  inputs: RegexInput[],
  scripts: CharacterRegexScriptRecord[],
  stage: RegexStage
): Promise<string[]> => {
  const applicable = scripts.filter((script) => script.enabled && script.renderOnly === (stage === "render"));
  if (!applicable.length) return inputs.map((input) => input.content);
  if (inputs.some((input) => input.content.length > MAX_INPUT_LENGTH)) {
    throw executionError("regex_input_too_long");
  }
  const worker = new Worker(workerSource, { eval: true, workerData: { inputs, scripts: applicable, stage } });
  return new Promise<string[]>((resolve, reject) => {
    const timeout = setTimeout(() => {
      void worker.terminate();
      reject(executionError("regex_timeout"));
    }, TIMEOUT_MS);
    const finish = (error?: Error, result?: string[]) => {
      clearTimeout(timeout);
      void worker.terminate();
      if (error) reject(error);
      else resolve(result ?? []);
    };
    worker.once("message", (message: { error?: string; result?: string[] }) =>
      message.error ? finish(executionError(message.error)) : finish(undefined, message.result));
    worker.once("error", (error) => finish(error));
  });
};
