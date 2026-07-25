const PENDING_CHAT_MESSAGE_JUMP_KEY = "star-companion:pending-message-jump";

export type PendingChatMessageJump = {
  chatId: string;
  messageId: string;
  index: number;
};

export const queueChatMessageJump = (jump: PendingChatMessageJump) => {
  window.sessionStorage.setItem(PENDING_CHAT_MESSAGE_JUMP_KEY, JSON.stringify(jump));
};

export const takeChatMessageJump = (chatId: string): PendingChatMessageJump | null => {
  const raw = window.sessionStorage.getItem(PENDING_CHAT_MESSAGE_JUMP_KEY);
  window.sessionStorage.removeItem(PENDING_CHAT_MESSAGE_JUMP_KEY);
  if (!raw) return null;

  try {
    const value = JSON.parse(raw) as Partial<PendingChatMessageJump>;
    if (
      value.chatId === chatId &&
      typeof value.messageId === "string" &&
      typeof value.index === "number" &&
      Number.isInteger(value.index) &&
      value.index >= 0
    ) {
      return { chatId, messageId: value.messageId, index: value.index };
    }
  } catch {
    // A stale or malformed navigation hint is intentionally ignored.
  }

  return null;
};
