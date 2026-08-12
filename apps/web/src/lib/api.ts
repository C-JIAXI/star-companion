import type {
  ApiEnvelope,
  AvailableModelsDTO,
  BackupDTO,
  BackupConflictResolutionDTO,
  BackupImportSummaryDTO,
  BackupPreviewDTO,
  ChatAgentDraftDTO,
  ChatAgentDraftRequestDTO,
  ChatBatchArchiveRequestDTO,
  ChatBatchArchiveResultDTO,
  ChatBatchFolderRequestDTO,
  ChatBatchFolderResultDTO,
  ChatRenameFolderRequestDTO,
  ChatRenameFolderResultDTO,
  ChatBatchPermanentDeleteRequestDTO,
  ChatBatchPermanentDeleteResultDTO,
  ChatBatchTrashRequestDTO,
  ChatBatchTrashResultDTO,
  ChatBranchRequestDTO,
  ChatArchiveDTO,
  ChatArchiveImportDTO,
  ChatMessageSearchDTO,
  CharacterCardDTO,
  CharacterBatchTagsRequestDTO,
  CharacterBatchTagsResultDTO,
  CharacterCardImportInput,
  CharacterDTO,
  CharacterDraftRequestDTO,
  CharacterDraftResponseDTO,
  CharacterExportMode,
  CharacterInput,
  CharacterSortMode,
  ChatMemoryDTO,
  ChatMemoryInput,
  MemoryOperationDTO,
  MemoryRestorePreviewDTO,
  MemoryRestoreResultDTO,
  MemoryRevisionDTO,
  MemoryUndoPreviewDTO,
  MemoryUndoResolutionDTO,
  MemoryUndoResultDTO,
  ProfileSummaryRestorePreviewDTO,
  ProfileSummaryRevisionDTO,
  ChatDTO,
  ChatInput,
  ChatTitleSuggestionDTO,
  ChatWithMessagesDTO,
  LanSyncInfoDTO,
  LanSyncRequestDTO,
  LanSyncSummaryDTO,
  ImageGenerationDTO,
  ImageGenerationRequestDTO,
  GlobalChatMessageSearchDTO,
  MessageDTO,
  DraftImageAttachmentDTO,
  MessageInput,
  VoiceSpeechDTO,
  VoiceSpeechRequestDTO,
  VoiceTranscriptionDTO,
  VoiceTranscriptionRequestDTO,
  PaginatedCharactersDTO,
  PublicUserSettingsDTO,
  RecoveryPointDTO,
  RecoveryPointRestoreResultDTO,
  AppInfoDTO,
  SettingsInput
  ,UsageSummaryDTO
  ,CostPreviewDTO
} from "../types";
import { resolveApiUrl } from "./appBackend";

type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchWithStartupRetry = async (url: string, init: RequestInit) => {
  const attempts = import.meta.env.VITE_API_BASE_URL ? 8 : 1;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fetch(url, init);
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) {
        await wait(250 + attempt * 250);
      }
    }
  }

  throw lastError;
};

const isJsonResponse = (response: Response) =>
  response.headers.get("content-type")?.toLowerCase().includes("application/json") ?? false;

const getFallbackErrorMessage = (response: Response) =>
  response.statusText
    ? `Request failed: ${response.status} ${response.statusText}`
    : `Request failed: ${response.status}`;

const request = async <T>(path: string, options: RequestOptions = {}): Promise<T> => {
  const response = await fetchWithStartupRetry(resolveApiUrl(path), {
    method: options.method ?? "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
    ,signal: options.signal
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
  privacy: {
    status: () => request<{ locked: boolean }>("/api/privacy/status"),
    lock: (passcode: string) => request<{ locked: boolean }>("/api/privacy/lock", { method: "POST", body: { passcode } }),
    unlock: (passcode: string) => request<{ locked: boolean }>("/api/privacy/unlock", { method: "POST", body: { passcode } })
  },
  app: {
    info: () => request<AppInfoDTO>("/api/app/info")
  },
  characters: {
    list: () => request<CharacterDTO[]>("/api/characters"),
    get: (id: string) => request<CharacterDTO>(`/api/characters/${id}`),
    page: (
      query: {
        q?: string;
        tag?: string;
        favoriteOnly?: boolean;
        sort?: CharacterSortMode;
        page?: number;
        pageSize?: number;
      } = {}
    ) => {
      const params = new URLSearchParams();
      if (query.q?.trim()) {
        params.set("q", query.q.trim());
      }
      if (query.tag?.trim()) {
        params.set("tag", query.tag.trim());
      }
      if (query.favoriteOnly) {
        params.set("favoriteOnly", "true");
      }
      if (query.sort) {
        params.set("sort", query.sort);
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
    draft: (input: CharacterDraftRequestDTO, signal?: AbortSignal) =>
      request<CharacterDraftResponseDTO>("/api/characters/draft", {
        method: "POST",
        body: input,
        signal
      }),
    duplicate: (id: string, name: string) =>
      request<CharacterDTO>(`/api/characters/${id}/duplicate`, {
        method: "POST",
        body: { name }
      }),
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
    remove: (id: string) => request<void>(`/api/characters/${id}`, { method: "DELETE" }),
    batchRemove: (ids: string[]) =>
      request<{ deleted: number }>("/api/characters/batch-delete", {
        method: "POST",
        body: { ids }
      }),
    batchTags: (input: CharacterBatchTagsRequestDTO) =>
      request<CharacterBatchTagsResultDTO>("/api/characters/batch-tags", {
        method: "POST",
        body: input
      }),
    batchFetch: (ids: string[]) =>
      request<CharacterDTO[]>("/api/characters/batch-fetch", {
        method: "POST",
        body: { ids }
      })
  },
  chats: {
    list: () => request<ChatDTO[]>("/api/chats"),
    create: (input: ChatInput) => request<ChatDTO>("/api/chats", { method: "POST", body: input }),
    get: (id: string) => request<ChatWithMessagesDTO>(`/api/chats/${id}`),
    update: (id: string, input: Partial<ChatInput>) =>
      request<ChatDTO>(`/api/chats/${id}`, { method: "PUT", body: input }),
    batchArchive: (input: ChatBatchArchiveRequestDTO) =>
      request<ChatBatchArchiveResultDTO>("/api/chats/batch-archive", {
        method: "POST",
        body: input
      }),
    batchFolder: (input: ChatBatchFolderRequestDTO) =>
      request<ChatBatchFolderResultDTO>("/api/chats/batch-folder", {
        method: "POST",
        body: input
      }),
    renameFolder: (input: ChatRenameFolderRequestDTO) =>
      request<ChatRenameFolderResultDTO>("/api/chats/rename-folder", {
        method: "POST",
        body: input
      }),
    batchTrash: (input: ChatBatchTrashRequestDTO) =>
      request<ChatBatchTrashResultDTO>("/api/chats/batch-trash", {
        method: "POST",
        body: input
      }),
    batchPermanentlyRemove: (input: ChatBatchPermanentDeleteRequestDTO) =>
      request<ChatBatchPermanentDeleteResultDTO>("/api/chats/batch-permanent-delete", {
        method: "POST",
        body: input
      }),
    remove: (id: string) => request<void>(`/api/chats/${id}`, { method: "DELETE" }),
    restore: (id: string) =>
      request<ChatDTO>(`/api/chats/${id}/restore`, { method: "POST" }),
    permanentlyRemove: (id: string) =>
      request<void>(`/api/chats/${id}/permanent`, { method: "DELETE" }),
    exportArchive: (id: string) => request<ChatArchiveDTO>(`/api/chats/${id}/archive`),
    importArchive: (input: ChatArchiveImportDTO) =>
      request<ChatWithMessagesDTO>("/api/chats/import-archive", { method: "POST", body: input }),
    agentDraft: (id: string, input: ChatAgentDraftRequestDTO) =>
      request<ChatAgentDraftDTO>(`/api/chats/${id}/agent-draft`, {
        method: "POST",
        body: input
      }),
    titleSuggestion: (id: string) =>
      request<ChatTitleSuggestionDTO>(`/api/chats/${id}/title-suggestion`, {
        method: "POST"
      }),
    autoTitle: (id: string) =>
      request<ChatDTO | null>(`/api/chats/${id}/auto-title`, { method: "POST" }),
    openingMessage: (id: string) =>
      request<MessageDTO>(`/api/chats/${id}/opening-message`, {
        method: "POST"
      }),
    branch: (id: string, input: ChatBranchRequestDTO) =>
      request<ChatWithMessagesDTO>(`/api/chats/${id}/branches`, {
        method: "POST",
        body: input
      }),
    messageSearch: (id: string, query: string, limit = 20) =>
      request<ChatMessageSearchDTO>(
        `/api/chats/${id}/message-search?q=${encodeURIComponent(query)}&limit=${limit}`
      ),
    globalMessageSearch: (query: string, limit = 20) =>
      request<GlobalChatMessageSearchDTO>(
        `/api/chats/message-search?q=${encodeURIComponent(query)}&limit=${limit}`
      ),
    memories: {
      list: (chatId: string) => request<ChatMemoryDTO[]>(`/api/chats/${chatId}/memories`),
      create: (chatId: string, input: ChatMemoryInput) =>
        request<ChatMemoryDTO>(`/api/chats/${chatId}/memories`, {
          method: "POST",
          body: input
        }),
      update: (chatId: string, memoryId: string, input: Partial<ChatMemoryInput>) =>
        request<ChatMemoryDTO>(`/api/chats/${chatId}/memories/${memoryId}`, {
          method: "PUT",
          body: input
        }),
      remove: (chatId: string, memoryId: string) =>
        request<void>(`/api/chats/${chatId}/memories/${memoryId}`, { method: "DELETE" }),
      refresh: (chatId: string) =>
        request<ChatMemoryDTO[]>(`/api/chats/${chatId}/memories/refresh`, { method: "POST" }),
      reindex: (chatId: string) =>
        request<ChatMemoryDTO[]>(`/api/chats/${chatId}/memories/reindex`, { method: "POST" }),
      revisions: (chatId: string, memoryId: string) =>
        request<MemoryRevisionDTO[]>(`/api/chats/${chatId}/memories/${memoryId}/revisions`),
      restorePreview: (chatId: string, memoryId: string, revision: number) =>
        request<MemoryRestorePreviewDTO>(`/api/chats/${chatId}/memories/${memoryId}/revisions/${revision}/restore-preview`),
      restore: (chatId: string, memoryId: string, revision: number, expectedCurrentRevision: number) =>
        request<MemoryRestoreResultDTO>(`/api/chats/${chatId}/memories/${memoryId}/restore`, { method: "POST", body: { revision, expectedCurrentRevision, confirm: "RESTORE_MEMORY_REVISION" } }),
      purge: (chatId: string, memoryId: string) =>
        request<{ purged: boolean }>(`/api/chats/${chatId}/memories/${memoryId}/purge`, { method: "POST", body: { confirm: "PURGE_MEMORY_HISTORY" } })
    }
    ,memoryOperations: {
      list: (chatId: string) => request<MemoryOperationDTO[]>(`/api/chats/${chatId}/memory-operations`),
      undoPreview: (chatId: string, operationId: string) => request<MemoryUndoPreviewDTO>(`/api/chats/${chatId}/memory-operations/${operationId}/undo-preview`, { method: "POST" }),
      undo: (chatId: string, operationId: string, resolutions: MemoryUndoResolutionDTO[]) => request<MemoryUndoResultDTO>(`/api/chats/${chatId}/memory-operations/${operationId}/undo`, { method: "POST", body: { resolutions, confirm: "UNDO_MEMORY_OPERATION" } })
    }
    ,profileSummaryHistory: {
      list: (chatId: string) => request<ProfileSummaryRevisionDTO[]>(`/api/chats/${chatId}/profile-summary/revisions`),
      restorePreview: (chatId: string, revision: number) => request<ProfileSummaryRestorePreviewDTO>(`/api/chats/${chatId}/profile-summary/revisions/${revision}/restore-preview`),
      restore: (chatId: string, revision: number, expectedCurrentRevision: number) => request<{ chat: ChatDTO; revision: ProfileSummaryRevisionDTO }>(`/api/chats/${chatId}/profile-summary/restore`, { method: "POST", body: { revision, expectedCurrentRevision, confirm: "RESTORE_PROFILE_SUMMARY" } })
    }
  },
  messages: {
    list: (chatId?: string) =>
      request<MessageDTO[]>(chatId ? `/api/messages?chatId=${encodeURIComponent(chatId)}` : "/api/messages"),
    create: (input: MessageInput) =>
      request<MessageDTO>("/api/messages", { method: "POST", body: input }),
    update: (id: string, input: Partial<MessageInput>) =>
      request<MessageDTO>(`/api/messages/${id}`, { method: "PUT", body: input }),
    removeTimeline: (id: string) =>
      request<{ chatId: string; deletedCount: number; disabledMemoryCount: number }>(
        `/api/messages/${id}/timeline`,
        { method: "DELETE" }
      ),
    remove: (id: string) => request<void>(`/api/messages/${id}`, { method: "DELETE" })
  },
  media: {
    stageChatImagesForEdit: (messageId: string, draftId: string) =>
      request<DraftImageAttachmentDTO[]>(`/api/media/chat-images/messages/${encodeURIComponent(messageId)}/edit-draft`, { method: "POST", body: { draftId } }),
    uploadChatImage: (input: { draftId: string; dataBase64: string; mimeType: "image/png" | "image/jpeg"; originalFilename?: string }) =>
      request<DraftImageAttachmentDTO>("/api/media/chat-images/drafts", { method: "POST", body: input }),
    listDraftChatImages: (draftId: string) => request<DraftImageAttachmentDTO[]>(`/api/media/chat-images/drafts/${encodeURIComponent(draftId)}`),
    removeDraftChatImage: (draftId: string, attachmentId: string) => request<void>(`/api/media/chat-images/drafts/${encodeURIComponent(draftId)}/${encodeURIComponent(attachmentId)}`, { method: "DELETE" }),
    reorderDraftChatImages: (draftId: string, attachmentIds: string[]) => request<DraftImageAttachmentDTO[]>(`/api/media/chat-images/drafts/${encodeURIComponent(draftId)}/order`, { method: "PUT", body: { attachmentIds } }),
    discardDraftChatImages: (draftId: string) => request<void>(`/api/media/chat-images/drafts/${encodeURIComponent(draftId)}`, { method: "DELETE" }),
    transcribe: (input: VoiceTranscriptionRequestDTO) =>
      request<VoiceTranscriptionDTO>("/api/media/voice/transcriptions", {
        method: "POST",
        body: input
      }),
    speech: (input: VoiceSpeechRequestDTO) =>
      request<VoiceSpeechDTO>("/api/media/voice/speech", {
        method: "POST",
        body: input
      }),
    image: (input: ImageGenerationRequestDTO) =>
      request<ImageGenerationDTO>("/api/media/images/generations", {
        method: "POST",
        body: input
      })
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
    models: () => request<AvailableModelsDTO>("/api/settings/models"),
    providerModels: (providerId: string, data?: { provider?: string; apiBaseUrl: string; key?: string }) =>
      request<AvailableModelsDTO>(`/api/settings/providers/${providerId}/models`, {
        method: "POST",
        body: data
      })
  },
  backups: {
    export: () => request<BackupDTO>("/api/backups/export"),
    preview: (backup: unknown, mode: "merge" | "replace") =>
      request<BackupPreviewDTO>("/api/backups/preview", {
        method: "POST",
        body: { ...(backup && typeof backup === "object" ? backup : {}), mode }
      }),
    import: (
      backup: unknown,
      mode: "merge" | "replace",
      previewId: string,
      conflictResolutions: BackupConflictResolutionDTO[]
    ) =>
      request<BackupImportSummaryDTO>("/api/backups/import", {
        method: "POST",
        body: {
          ...(backup && typeof backup === "object" ? backup : {}),
          mode,
          previewId,
          conflictResolutions
        }
      }),
    recoveryPoints: () => request<RecoveryPointDTO[]>("/api/backups/recovery-points"),
    restoreRecoveryPoint: (id: string) =>
      request<RecoveryPointRestoreResultDTO>(`/api/backups/recovery-points/${id}/restore`, {
        method: "POST"
      })
  },
  usage: {
    summary: (from?: string, to?: string) => request<UsageSummaryDTO>(`/api/usage/summary${from || to ? `?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) })}` : ""}`),
    preview: (input: { module: string; texts?: string[]; inputTokens?: number; maxOutputTokens?: number }) => request<CostPreviewDTO>("/api/usage/preview", { method: "POST", body: input }),
    clear: () => request<{ attempts: number; requests: number }>("/api/usage/history", { method: "DELETE", body: { confirm: "DELETE_USAGE_HISTORY" } })
  },
  sync: {
    info: () => request<LanSyncInfoDTO>("/api/sync/info"),
    pull: (input: LanSyncRequestDTO) =>
      request<LanSyncSummaryDTO>("/api/sync/pull", { method: "POST", body: input }),
    push: (input: LanSyncRequestDTO) =>
      request<LanSyncSummaryDTO>("/api/sync/push", { method: "POST", body: input })
  }
};
