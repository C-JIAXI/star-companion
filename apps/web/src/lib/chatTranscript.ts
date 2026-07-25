import type { AppLanguage, ChatWithMessagesDTO } from "../types";

export type ChatTranscriptFormat = "markdown" | "text";

type ChatTranscriptOptions = {
  chat: ChatWithMessagesDTO;
  characterName?: string;
  language: AppLanguage;
  format: ChatTranscriptFormat;
  includeTimestamps: boolean;
  exportedAt?: string | Date;
};

const singleLine = (value: string) => value.replace(/\s+/g, " ").trim();

const formatDateTime = (value: string | Date, language: AppLanguage) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  return new Intl.DateTimeFormat(language === "zh-CN" ? "zh-CN" : "en", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
};

export const safeChatTranscriptName = (title: string) => {
  const safe = singleLine(title)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 60);
  return safe || "chat";
};

export const buildChatTranscript = ({
  chat,
  characterName,
  language,
  format,
  includeTimestamps,
  exportedAt = new Date()
}: ChatTranscriptOptions) => {
  const isChinese = language === "zh-CN";
  const title = singleLine(chat.title) || (isChinese ? "未命名聊天" : "Untitled chat");
  const roleName = singleLine(characterName ?? "") || (isChinese ? "角色" : "Character");
  const messages = chat.messages.filter(
    (message) => message.role === "user" || message.role === "assistant"
  );
  const exportedLabel = formatDateTime(exportedAt, language);
  const labels = isChinese
    ? { character: "角色", exported: "导出时间", messages: "消息数", user: "用户" }
    : { character: "Character", exported: "Exported", messages: "Messages", user: "You" };

  if (format === "markdown") {
    const metadata = [
      `- ${labels.character}: ${roleName}`,
      exportedLabel ? `- ${labels.exported}: ${exportedLabel}` : "",
      `- ${labels.messages}: ${messages.length}`
    ].filter(Boolean);
    const turns = messages.map((message) => {
      const speaker = message.role === "user" ? labels.user : roleName;
      const timestamp = includeTimestamps ? formatDateTime(message.createdAt, language) : "";
      return `## ${speaker}${timestamp ? ` · ${timestamp}` : ""}\n\n${message.content.trim()}`;
    });

    return [`# ${title}`, metadata.join("\n"), "---", ...turns].join("\n\n").trimEnd() + "\n";
  }

  const divider = "=".repeat(Math.min(Math.max(title.length, 12), 60));
  const header = [
    title,
    divider,
    `${labels.character}: ${roleName}`,
    exportedLabel ? `${labels.exported}: ${exportedLabel}` : "",
    `${labels.messages}: ${messages.length}`
  ].filter(Boolean);
  const turns = messages.map((message) => {
    const speaker = message.role === "user" ? labels.user : roleName;
    const timestamp = includeTimestamps ? formatDateTime(message.createdAt, language) : "";
    return `${speaker}${timestamp ? ` [${timestamp}]` : ""}\n${message.content.trim()}`;
  });

  return [...header, "", ...turns].join("\n\n").trimEnd() + "\n";
};
