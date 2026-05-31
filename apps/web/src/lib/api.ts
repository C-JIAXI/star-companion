import type {
  ApiEnvelope,
  AvailableModelsDTO,
  BackupDTO,
  BackupImportSummaryDTO,
  CharacterCardDTO,
  CharacterCardImportInput,
  CharacterDTO,
  CharacterExportMode,
  CharacterInput,
  ChatDTO,
  ChatInput,
  ChatWithMessagesDTO,
  MessageDTO,
  MessageInput,
  PaginatedCharactersDTO,
  PublicUserSettingsDTO,
  SettingsInput
} from "../types";

type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
};

const isJsonResponse = (response: Response) =>
  response.headers.get("content-type")?.toLowerCase().includes("application/json") ?? false;

const getFallbackErrorMessage = (response: Response) =>
  response.statusText
    ? `Request failed: ${response.status} ${response.statusText}`
    : `Request failed: ${response.status}`;

const request = async <T>(path: string, options: RequestOptions = {}): Promise<T> => {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const rawBody = await response.text();
  const body = rawBody.trim();

  if (!body) {
    if (response.ok) {
      throw new Error(`Empty response received from ${path}`);
    }

    throw new Error(getFallbackErrorMessage(response));
  }

  if (!isJsonResponse(response)) {
    if (!response.ok) {
      throw new Error(body || getFallbackErrorMessage(response));
    }

    throw new Error(`Unexpected non-JSON response received from ${path}`);
  }

  let payload: ApiEnvelope<T> | { ok: false; error: string };

  try {
    payload = JSON.parse(body) as ApiEnvelope<T> | { ok: false; error: string };
  } catch {
    throw new Error(`Invalid JSON response received from ${path}`);
  }

  if (!response.ok || !payload.ok) {
    const message = "error" in payload ? payload.error : getFallbackErrorMessage(response);
    throw new Error(message);
  }

  return payload.data;
};

export const api = {
  characters: {
    list: () => request<CharacterDTO[]>("/api/characters"),
    get: (id: string) => request<CharacterDTO>(`/api/characters/${id}`),
    page: (query: { q?: string; page?: number; pageSize?: number } = {}) => {
      const params = new URLSearchParams();
      if (query.q?.trim()) {
        params.set("q", query.q.trim());
      }
      if (query.page !== undefined) {
        params.set("page", String(query.page));
      }
      if (query.pageSize !== undefined) {
        params.set("pageSize", String(query.pageSize));
      }
      const suffix = params.toString();
      return request<PaginatedCharactersDTO>(`/api/characters/page${suffix ? `?${suffix}` : ""}`);
    },
    create: (input: CharacterInput) =>
      request<CharacterDTO>("/api/characters", { method: "POST", body: input }),
    import: (input: CharacterCardImportInput) =>
      request<CharacterDTO>("/api/characters/import", { method: "POST", body: input }),
    export: (id: string, visibility: CharacterExportMode, password?: string) =>
      request<CharacterCardDTO>(`/api/characters/${id}/export`, {
        method: "POST",
        body: password ? { visibility, password } : { visibility }
      }),
    unlock: (id: string, password: string) =>
      request<CharacterDTO>(`/api/characters/${id}/unlock`, {
        method: "POST",
        body: { password }
      }),
    update: (id: string, input: Partial<CharacterInput>, accessPassword?: string) =>
      request<CharacterDTO>(`/api/characters/${id}`, {
        method: "PUT",
        body: accessPassword ? { ...input, accessPassword } : input
      }),
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
      request<PublicUserSettingsDTO>("/api/settings", { method: "PUT", body: input }),
    updateUserProfile: (input: { userProfileSummary: string; autoSummarizeUser?: boolean }) =>
      request<PublicUserSettingsDTO>("/api/settings/user-profile", {
        method: "PUT",
        body: input
      }),
    test: () =>
      request<{ reachable: true; model: string; checkedAt: string }>("/api/settings/test", {
        method: "POST"
      }),
    models: () => request<AvailableModelsDTO>("/api/settings/models")
  },
  backups: {
    export: () => request<BackupDTO>("/api/backups/export"),
    import: (backup: unknown, mode: "merge" | "replace") =>
      request<BackupImportSummaryDTO>("/api/backups/import", {
        method: "POST",
        body: { ...(backup && typeof backup === "object" ? backup : {}), mode }
      })
  }
};
