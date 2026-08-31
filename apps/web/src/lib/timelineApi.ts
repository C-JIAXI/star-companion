import type { ChatDTO, MessageLocationDTO, MessagePageDTO } from "../types";
import { request } from "./api";

const query = (values: Record<string, string>) => new URLSearchParams(values).toString();

export const timelineApi = {
  summary: (chatId: string, signal?: AbortSignal) =>
    request<ChatDTO>(`/api/chats/${chatId}/summary`, { signal }),
  page: (
    chatId: string,
    input: { limit: number; cursor?: string; includeTotal?: boolean; bookmarkedOnly?: boolean },
    signal?: AbortSignal
  ) => request<MessagePageDTO>(`/api/messages/page?${query({
    chatId,
    limit: String(input.limit),
    ...(input.cursor ? { cursor: input.cursor } : {}),
    ...(input.includeTotal === undefined ? {} : { includeTotal: String(input.includeTotal) }),
    ...(input.bookmarkedOnly === undefined ? {} : { bookmarkedOnly: String(input.bookmarkedOnly) })
  })}`, { signal }),
  locate: (chatId: string, messageId: string, radius = 25, signal?: AbortSignal) =>
    request<MessageLocationDTO>(`/api/messages/locate?${query({ chatId, messageId, radius: String(radius) })}`, { signal })
};
