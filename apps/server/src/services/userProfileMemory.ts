import type { Chat, UserSettings } from "@prisma/client";
import { prisma } from "../db.js";
import { completeChatCompletion, type ChatCompletionMessage } from "./completions.js";
import { resolveModuleSettings } from "./moduleModels.js";

const MAX_PROFILE_LENGTH = 1800;
const RECENT_USER_MESSAGE_LIMIT = 16;

export const trimUserProfileSummary = (value: string) =>
  value.trim().slice(0, MAX_PROFILE_LENGTH);

export const buildUserProfileSummaryMessages = (
  currentSummary: string,
  userMessages: string[]
): ChatCompletionMessage[] => [
  {
    role: "system",
    content: [
      "You maintain a concise local user profile memory for a roleplay chat app.",
      "Update the profile only with durable facts or habits explicitly supported by user messages.",
      "Include stable preferences, recurring style, boundaries, goals, names/pronouns if stated, and interaction habits.",
      "Do not include API keys, secrets, credentials, private addresses, unsupported guesses, or one-off transient requests.",
      "Keep it short, neutral, and useful for future assistant responses.",
      "Return only the updated profile summary. If there is no durable new information, return the existing summary."
    ].join("\n")
  },
  {
    role: "user",
    content: [
      `Existing user profile:\n${currentSummary || "(empty)"}`,
      "",
      "Recent user messages:",
      userMessages.map((message, index) => `${index + 1}. ${message}`).join("\n")
    ].join("\n")
  }
];

export const updateUserProfileFromChat = async ({
  chatId,
  settings
}: {
  chatId: string;
  settings: UserSettings;
}): Promise<Chat | null> => {
  if (!settings.autoSummarizeUser) {
    return null;
  }

  const chat = await prisma.chat.findFirst({ where: { id: chatId, deletedAt: null } });
  if (!chat) {
    return null;
  }

  const userMessages = await prisma.message.findMany({
    where: {
      chatId,
      role: "user"
    },
    orderBy: { createdAt: "desc" },
    take: RECENT_USER_MESSAGE_LIMIT
  });

  const recentContents = userMessages
    .reverse()
    .map((message) => message.content.trim())
    .filter(Boolean);

  if (recentContents.length === 0) {
    return null;
  }

  const summary = trimUserProfileSummary(
    await completeChatCompletion({
      settings: resolveModuleSettings(settings, "user_profile"),
      messages: buildUserProfileSummaryMessages(chat.userProfileSummary, recentContents),
      maxTokens: 500,
      temperature: 0.2
    })
  );

  if (!summary || summary === chat.userProfileSummary) {
    return null;
  }

  return prisma.chat.update({
    where: { id: chatId },
    data: {
      userProfileSummary: summary,
      userProfileUpdatedAt: new Date()
    }
  });
};
