import type { ProviderKind, TokenUsage } from "./completions.js";

export type ModelToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ModelToolCall = {
  id: string;
  providerCallId?: string;
  name: string;
  arguments: Record<string, unknown> | null;
};

export type ModelToolResult = {
  id: string;
  name: string;
  content: string;
  isError?: boolean;
};

export type ModelToolExchange = {
  assistant: unknown;
  results: ModelToolResult[];
};

export type ModelToolDecision = {
  text: string;
  calls: ModelToolCall[];
  assistant: unknown;
  usage: TokenUsage | null;
};

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const string = (value: unknown): string => typeof value === "string" ? value : "";
const usage = (input: number, output: number): TokenUsage => ({ promptTokens: input, completionTokens: output, totalTokens: input + output, estimated: false });

const toolArguments = (value: unknown): Record<string, unknown> | null => {
  if (typeof value === "string") {
    try { return record(JSON.parse(value)); } catch { return null; }
  }
  return record(value);
};

export const parseModelToolDecision = (provider: ProviderKind, payload: unknown): ModelToolDecision => {
  const data = record(payload) ?? {};
  if (provider === "openai-compatible") {
    const choice = record(array(data.choices)[0]) ?? {};
    const assistant = record(choice.message) ?? {};
    const calls = array(assistant.tool_calls).map((item) => {
      const call = record(item) ?? {};
      const fn = record(call.function) ?? {};
      return { id: string(call.id), name: string(fn.name), arguments: toolArguments(fn.arguments) };
    });
    const tokenCounts = record(data.usage);
    const input = Number(tokenCounts?.prompt_tokens ?? 0);
    const output = Number(tokenCounts?.completion_tokens ?? 0);
    return { text: string(assistant.content).trim(), calls, assistant, usage: tokenCounts && Number.isFinite(input) && Number.isFinite(output) ? usage(input, output) : null };
  }
  if (provider === "anthropic") {
    const blocks = array(data.content);
    const calls = blocks.flatMap((item) => {
      const block = record(item) ?? {};
      return block.type === "tool_use" ? [{ id: string(block.id), name: string(block.name), arguments: toolArguments(block.input) }] : [];
    });
    const tokenCounts = record(data.usage);
    const input = Number(tokenCounts?.input_tokens ?? 0);
    const output = Number(tokenCounts?.output_tokens ?? 0);
    return {
      text: blocks.map((item) => { const block = record(item); return block?.type === "text" ? string(block.text) : ""; }).join("").trim(),
      calls, assistant: blocks,
      usage: tokenCounts && Number.isFinite(input) && Number.isFinite(output) ? usage(input, output) : null
    };
  }
  const candidate = record(array(data.candidates)[0]) ?? {};
  const content = record(candidate.content) ?? {};
  const parts = array(content.parts);
  const calls = parts.flatMap((item, index) => {
    const part = record(item) ?? {};
    const fn = record(part.functionCall);
    if (!fn) return [];
    const providerCallId = string(fn.id);
    return [{ id: providerCallId || `gemini_call_${index}`, ...(providerCallId ? { providerCallId } : {}), name: string(fn.name), arguments: toolArguments(fn.args) }];
  });
  const tokenCounts = record(data.usageMetadata);
  const input = Number(tokenCounts?.promptTokenCount ?? 0);
  const output = Number(tokenCounts?.candidatesTokenCount ?? 0);
  return {
    text: parts.map((item) => string(record(item)?.text)).join("").trim(), calls,
    assistant: content,
    usage: tokenCounts && Number.isFinite(input) && Number.isFinite(output) ? usage(input, output) : null
  };
};

const geminiSchema = (value: unknown): unknown => {
  const schema = record(value);
  if (!schema) return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(schema)) {
    if (key === "additionalProperties" || key === "$schema") continue;
    if (key === "type" && typeof item === "string") result.type = item.toUpperCase();
    else if (key === "properties" && record(item)) result.properties = Object.fromEntries(Object.entries(record(item)!).map(([name, child]) => [name, geminiSchema(child)]));
    else if (key === "items") result.items = geminiSchema(item);
    else result[key] = item;
  }
  return result;
};

export const providerToolDefinitions = (provider: ProviderKind, tools: ModelToolDefinition[]) => {
  if (provider === "openai-compatible") return tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
  if (provider === "anthropic") return tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
  return [{ functionDeclarations: tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: geminiSchema(tool.parameters) })) }];
};

export const providerToolHistory = (provider: ProviderKind, exchanges: ModelToolExchange[]): unknown[] => exchanges.flatMap((exchange) => {
  if (provider === "openai-compatible") {
    return [exchange.assistant, ...exchange.results.map((result) => ({ role: "tool", tool_call_id: result.id, content: result.content }))];
  }
  if (provider === "anthropic") {
    return [
      { role: "assistant", content: exchange.assistant },
      { role: "user", content: exchange.results.map((result) => ({ type: "tool_result", tool_use_id: result.id, content: result.content, is_error: result.isError === true })) }
    ];
  }
  const original = record(exchange.assistant) ?? {};
  const parts = array(original.parts);
  return [
    { role: "model", parts },
    { role: "user", parts: exchange.results.map((result) => ({ functionResponse: { name: result.name, ...(result.id.startsWith("gemini_call_") ? {} : { id: result.id }), response: { result: result.content, ...(result.isError ? { isError: true } : {}) } } })) }
  ];
});
