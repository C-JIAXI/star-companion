import { prisma } from "../db.js";
import { HttpError } from "../lib/http.js";
import { completeChatCompletion, type ChatCompletionMessage } from "./completions.js";
import { buildPromptContext } from "./promptBuilder.js";
import { getOrCreateSettings } from "../routes/settings.js";
import { resolveModuleSettings } from "./moduleModels.js";

export type ChatAgentMode =
  | "scene_summary"
  | "next_steps"
  | "reply_drafts"
  | "memory_lore_candidates";

type CreateChatAgentDraftInput = {
  chatId: string;
  mode: ChatAgentMode;
  focus?: string;
};

type AgentModeConfig = {
  title: string;
  instruction: string;
};

const modeConfig = {
  scene_summary: {
    title: "Scene Summary",
    instruction: [
      "Summarize the current single-character roleplay scene for the user.",
      "Cover the current situation, relationship state, emotional tone, and unresolved threads.",
      "Keep it concise and practical."
    ].join("\n")
  },
  next_steps: {
    title: "Next Step Suggestions",
    instruction: [
      "Suggest 3 to 5 possible next actions the user can take in this single-character chat.",
      "Each suggestion should be concrete, in-character for the current scene, and easy to send or adapt.",
      "Do not continue the assistant character's reply for the user."
    ].join("\n")
  },
  reply_drafts: {
    title: "Reply Drafts",
    instruction: [
      "Write 2 to 3 alternative user reply drafts for the current single-character chat.",
      "Make each draft ready to paste into the user's message box.",
      "Keep the drafts distinct in tone or strategy."
    ].join("\n")
  },
  memory_lore_candidates: {
    title: "Memory and Lore Candidates",
    instruction: [
      "Identify candidate notes that the user may later save manually.",
      "Separate durable chat memory candidates from character embedded lore candidates.",
      "Do not claim anything was saved. Do not propose standalone lorebook or worldbook structures."
    ].join("\n")
  }
} satisfies Record<ChatAgentMode, AgentModeConfig>;

export const buildChatAgentDraftMessages = (
  baseMessages: ChatCompletionMessage[],
  mode: ChatAgentMode,
  focus?: string
): ChatCompletionMessage[] => [
  {
    role: "system",
    content: [
      "/no_think",
      "You are a read-only context assistant inside a local-first single-user, single-character roleplay chat app.",
      "You may inspect the provided chat context and produce a draft for the user.",
      "Do not modify data, claim that data was changed, create background tasks, introduce group chat, or introduce standalone lorebook/worldbook features.",
      "Return Markdown only.",
      modeConfig[mode].instruction,
      focus?.trim() ? `User focus:\n${focus.trim()}` : ""
    ]
      .filter(Boolean)
      .join("\n\n")
  },
  ...baseMessages,
  {
    role: "user",
    content: "Create the requested agent draft from the context above."
  }
];

export const getChatAgentModeTitle = (mode: ChatAgentMode) => modeConfig[mode].title;

export const createChatAgentDraft = async ({
  chatId,
  mode,
  focus
}: CreateChatAgentDraftInput) => {
  const chat = await prisma.chat.findFirst({
    where: { id: chatId, deletedAt: null },
    select: { id: true }
  });
  if (!chat) {
    throw new HttpError(404, "Chat not found");
  }

  const settings = resolveModuleSettings(await getOrCreateSettings(), "agent");
  const context = await buildPromptContext({ chatId, settings });
  const messages = buildChatAgentDraftMessages(context.messages, mode, focus);
  const content = (
    await completeChatCompletion({
      settings,
      messages,
      maxTokens: Math.min(settings.maxTokens, 900),
      temperature: Math.min(settings.temperature, 0.4)
    })
  ).trim();

  if (!content) {
    throw new Error("Agent returned an empty draft.");
  }

  return {
    mode,
    title: modeConfig[mode].title,
    content,
    createdAt: new Date().toISOString(),
    matchedLoreEntries: context.matchedLoreEntries,
    matchedMemoryEntries: context.matchedMemoryEntries
  };
};
