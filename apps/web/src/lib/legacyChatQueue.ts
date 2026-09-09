// Read-only compatibility input. Never write prepared text or image metadata back
// into browser storage; acknowledgement storage contains only old queue item IDs.
export type LegacyQueueItem = { id: string; content: string; draftId?: string; attachmentIds: string[] };
const sourceKey = (chatId: string) => `star-companion:chat-queue:${chatId}`;
const receiptKey = (chatId: string) => `star-companion:chat-queue-migrated:${chatId}`;
const receipts = (chatId: string): string[] => {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(receiptKey(chatId)) ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch { return []; }
};
export const readLegacyChatQueue = (chatId: string): { items: LegacyQueueItem[]; invalid: boolean } => {
  try {
    const raw = sessionStorage.getItem(sourceKey(chatId));
    if (!raw) return { items: [], invalid: false };
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length > 100) return { items: [], invalid: true };
    const migrated = new Set(receipts(chatId));
    const items: LegacyQueueItem[] = [];
    let invalid = false;
    for (const value of parsed) {
      if (!value || typeof value !== "object" || typeof value.id !== "string" || typeof value.content !== "string" || value.content.length > 200_000) { invalid = true; continue; }
      if (migrated.has(value.id)) continue;
      const images: unknown[] = Array.isArray(value.attachments) ? value.attachments : [];
      if (images.length > 4 || images.some((image) => !image || typeof image !== "object" || !("id" in image) || typeof image.id !== "string")) { invalid = true; continue; }
      const attachmentIds = images.map((image) => (image as { id: string }).id);
      items.push({ id: value.id, content: value.content, draftId: typeof value.draftId === "string" ? value.draftId : undefined, attachmentIds });
    }
    return { items, invalid };
  } catch { return { items: [], invalid: true }; }
};
export const acknowledgeLegacyQueueItem = (chatId: string, id: string) => {
  try {
    sessionStorage.setItem(receiptKey(chatId), JSON.stringify([...new Set([...receipts(chatId), id])]));
    const remaining = readLegacyChatQueue(chatId);
    if (!remaining.items.length && !remaining.invalid) {
      sessionStorage.removeItem(sourceKey(chatId));
      sessionStorage.removeItem(receiptKey(chatId));
    }
  } catch { /* Keep the old copy when acknowledgement storage is unavailable. */ }
  return readLegacyChatQueue(chatId);
};
