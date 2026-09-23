import { prisma } from "../db.js";
import { resolveCharacterPromptFields, type CharacterRegexScriptRecord } from "./characterCards.js";
import { runCharacterRegexScripts, type RegexInput } from "./characterRegex.js";

export const scriptsForChat = async (chatId: string): Promise<CharacterRegexScriptRecord[]> => {
  const chat = await prisma.chat.findUnique({ where: { id: chatId }, select: { characterId: true } });
  if (!chat?.characterId) return [];
  const character = await prisma.character.findUnique({ where: { id: chat.characterId } });
  return character ? resolveCharacterPromptFields(character).regexScripts : [];
};

export const processStoredContent = async (chatId: string, role: "assistant" | "user", content: string) =>
  (await runCharacterRegexScripts([{ content, role }], await scriptsForChat(chatId), "stored"))[0] ?? content;

export const addDisplayContent = async <T extends { chatId: string; role: string; content: string }>(
  messages: T[]
): Promise<Array<T & { displayContent: string }>> => {
  if (!messages.length) return [];
  const byChat = new Map<string, Array<{ message: T; index: number }>>();
  messages.forEach((message, index) => byChat.set(message.chatId, [...(byChat.get(message.chatId) ?? []), { message, index }]));
  const result = messages.map((message) => ({ ...message, displayContent: message.content }));
  for (const [chatId, entries] of byChat) {
    try {
      const scripts = await scriptsForChat(chatId);
      const inputs: RegexInput[] = entries.map(({ message }) => ({
        content: message.content,
        role: message.role === "assistant" ? "assistant" : "user"
      }));
      const rendered = await runCharacterRegexScripts(inputs, scripts, "render");
      entries.forEach(({ message, index }, position) => {
        result[index]!.displayContent = message.role === "system" ? message.content : rendered[position] ?? message.content;
      });
    } catch {
      // An unsafe render expression must not make stored history unreadable.
    }
  }
  return result;
};
