import type { ChatCompletionMessage } from "./completions.js";

export const buildRegenerationGuidanceMessage = ({
  originalResponse,
  guidance
}: {
  originalResponse: string;
  guidance: string;
}): ChatCompletionMessage => ({
  role: "user",
  content: [
    "Rewrite the excluded assistant response according to the user's revision guidance.",
    "Preserve established story facts unless the guidance explicitly asks to correct them.",
    "Return only the replacement assistant response, without commentary about the revision.",
    JSON.stringify({
      originalAssistantResponse: originalResponse,
      revisionGuidance: guidance
    })
  ].join("\n\n")
});
