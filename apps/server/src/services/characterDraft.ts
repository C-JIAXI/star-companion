import { executeReliableTextCompletion } from "./reliableModelCalls.js";
import { getOrCreateSettings } from "../routes/settings.js";
import { resolveModuleSettings } from "./moduleModels.js";
import { buildCharacterDraftMessages, getCharacterDraftMeta, parseCharacterDraftItems, type CharacterDraftRequest } from "./characterDraftProtocol.js";
export { buildCharacterDraftMessages, getCharacterDraftMeta, parseCharacterDraftItems } from "./characterDraftProtocol.js";

export const createCharacterDraft = async (input: CharacterDraftRequest, signal?: AbortSignal) => {
  const settings = resolveModuleSettings(await getOrCreateSettings(), "agent");
  const content = (await executeReliableTextCompletion({ settings, messages: buildCharacterDraftMessages(input), maxTokens: Math.min(settings.maxTokens, 1200), temperature: Math.min(settings.temperature, 0.5), context: { requestId: input.requestId, module: "agent", operation: `character_${input.task}`, signal } })).content;
  const meta = getCharacterDraftMeta(input.task);
  return { requestId: input.requestId, task: input.task, title: meta.title, notice: "AI-generated draft. Review it for accuracy before applying or saving.", sentFieldCategories: meta.sentFieldCategories, items: parseCharacterDraftItems(content), createdAt: new Date().toISOString() };
};
