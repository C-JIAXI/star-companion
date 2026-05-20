import type {
  ApiEnvelope,
  CharacterDTO,
  CharacterInput,
  ChatDTO,
  ChatInput,
  ChatWithMessagesDTO,
  LorebookDTO,
  LorebookInput,
  LorebookWithEntriesDTO,
  LoreEntryDTO,
  LoreEntryInput,
  MessageDTO,
  MessageInput,
  PublicUserSettingsDTO,
  SettingsInput
} from "../types";

type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
};

const request = async <T>(path: string, options: RequestOptions = {}): Promise<T> => {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const payload = (await response.json()) as ApiEnvelope<T> | { ok: false; error: string };

  if (!response.ok || !payload.ok) {
    const message = "error" in payload ? payload.error : `Request failed: ${response.status}`;
    throw new Error(message);
  }

  return payload.data;
};

export const api = {
  characters: {
    list: () => request<CharacterDTO[]>("/api/characters"),
    create: (input: CharacterInput) =>
      request<CharacterDTO>("/api/characters", { method: "POST", body: input }),
    update: (id: string, input: Partial<CharacterInput>) =>
      request<CharacterDTO>(`/api/characters/${id}`, { method: "PUT", body: input }),
    remove: (id: string) => request<void>(`/api/characters/${id}`, { method: "DELETE" })
  },
  chats: {
    list: () => request<ChatDTO[]>("/api/chats"),
    create: (input: ChatInput) => request<ChatDTO>("/api/chats", { method: "POST", body: input }),
    get: (id: string) => request<ChatWithMessagesDTO>(`/api/chats/${id}`),
    update: (id: string, input: Partial<ChatInput>) =>
      request<ChatDTO>(`/api/chats/${id}`, { method: "PUT", body: input }),
    remove: (id: string) => request<void>(`/api/chats/${id}`, { method: "DELETE" })
  },
  messages: {
    list: (chatId?: string) =>
      request<MessageDTO[]>(chatId ? `/api/messages?chatId=${encodeURIComponent(chatId)}` : "/api/messages"),
    create: (input: MessageInput) =>
      request<MessageDTO>("/api/messages", { method: "POST", body: input }),
    update: (id: string, input: Partial<MessageInput>) =>
      request<MessageDTO>(`/api/messages/${id}`, { method: "PUT", body: input }),
    remove: (id: string) => request<void>(`/api/messages/${id}`, { method: "DELETE" })
  },
  settings: {
    get: () => request<PublicUserSettingsDTO>("/api/settings"),
    update: (input: SettingsInput) =>
      request<PublicUserSettingsDTO>("/api/settings", { method: "PUT", body: input })
  },
  lorebooks: {
    list: () => request<LorebookDTO[]>("/api/lorebooks"),
    create: (input: LorebookInput) =>
      request<LorebookDTO>("/api/lorebooks", { method: "POST", body: input }),
    get: (id: string) => request<LorebookWithEntriesDTO>(`/api/lorebooks/${id}`),
    update: (id: string, input: Partial<LorebookInput>) =>
      request<LorebookDTO>(`/api/lorebooks/${id}`, { method: "PUT", body: input }),
    remove: (id: string) => request<void>(`/api/lorebooks/${id}`, { method: "DELETE" }),
    createEntry: (lorebookId: string, input: LoreEntryInput) =>
      request<LoreEntryDTO>(`/api/lorebooks/${lorebookId}/entries`, {
        method: "POST",
        body: input
      }),
    updateEntry: (id: string, input: Partial<LoreEntryInput>) =>
      request<LoreEntryDTO>(`/api/lorebooks/entries/${id}`, { method: "PUT", body: input }),
    removeEntry: (id: string) =>
      request<void>(`/api/lorebooks/entries/${id}`, { method: "DELETE" })
  }
};
