import type {
  ChatDraftDTO,
  ChatDraftSaveInput,
  DraftHandoffDTO,
  ApiEnvelope,
  AvailableModelsDTO,
  BackupDTO,
  BackupConflictResolutionDTO,
  BackupImportSummaryDTO,
  BackupPreviewDTO,
  ChatAgentDraftDTO,
  ChatAgentDraftRequestDTO,
  ChatAgentActionPreviewDTO,
  AgentSessionDTO,
  AgentRunStatusDTO,
  SkillSummaryDTO,
  SkillDetailDTO,
  SkillImportInputDTO,
  SkillImportPreviewDTO,
  McpConnectionDTO,
  WebSearchStatusDTO,
  PendingMcpApprovalDTO,
  AgentTaskRequestDTO,
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
  ChatMemoryPageDTO,
  MemoryEmbeddingJobStatusDTO,
  MemoryIndexSummaryDTO,
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
  ChatPageDTO,
  LanSyncInfoDTO,
  LanAutoSyncSettingsInputDTO,
  LanAutoSyncStatusDTO,
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
  ReadinessDTO,
  ConnectionDiagnosticDTO,
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

const withQuery = (path: string, values: Record<string, string | undefined>) => {
  const params = new URLSearchParams(
    Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  const suffix = params.toString();
  return suffix ? `${path}?${suffix}` : path;
};

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

export class ApiRequestError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}

export const request = async <T>(path: string, options: RequestOptions = {}): Promise<T> => {
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
    throw new ApiRequestError(message, response.status);
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
  skills: {
    list: () => request<SkillSummaryDTO[]>("/api/skills"),
    get: (name: string) => request<SkillDetailDTO>(`/api/skills/${encodeURIComponent(name)}`),
    reference: (name: string, path: string) => request<{ name: string; path: string; content: string }>(`/api/skills/${encodeURIComponent(name)}/reference?path=${encodeURIComponent(path)}`),
    import: (input: SkillImportInputDTO) => request<SkillSummaryDTO>("/api/skills/import", { method: "POST", body: input }),
    previewImport: (input: SkillImportInputDTO) => request<SkillImportPreviewDTO>("/api/skills/import-preview", { method: "POST", body: input }),
    enable: (name: string, input: { expectedVersion: number; agentEnabled?: boolean; chatId?: string; chatEnabled?: boolean }) =>
      request<SkillSummaryDTO>(`/api/skills/${encodeURIComponent(name)}/enabled`, { method: "PUT", body: input }),
    delete: (name: string, expectedVersion: number) => request<{ deleted: boolean }>(`/api/skills/${encodeURIComponent(name)}`, {
      method: "DELETE", body: { expectedVersion, confirm: "DELETE_SKILL" }
    })
  },
  mcp: {
    list: () => request<McpConnectionDTO[]>("/api/mcp"),
    create: (input: { name: string; endpointUrl: string; allowPrivateNetwork: boolean; bearerToken?: string }) =>
      request<McpConnectionDTO>("/api/mcp", { method: "POST", body: input }),
    update: (id: string, input: { expectedVersion: number; name?: string; endpointUrl?: string; allowPrivateNetwork?: boolean; bearerToken?: string | null; enabled?: boolean }) =>
      request<McpConnectionDTO>(`/api/mcp/${encodeURIComponent(id)}`, { method: "PUT", body: input }),
    check: (id: string, expectedVersion: number) =>
      request<McpConnectionDTO & { protocolEra: "modern" | "legacy" }>(`/api/mcp/${encodeURIComponent(id)}/check`, { method: "POST", body: { expectedVersion } }),
    enableTool: (id: string, input: { expectedVersion: number; toolName: string; definitionDigest: string; enabled: boolean }) =>
      request<McpConnectionDTO>(`/api/mcp/${encodeURIComponent(id)}/tools`, { method: "PUT", body: input }),
    delete: (id: string, expectedVersion: number) =>
      request<{ deleted: boolean }>(`/api/mcp/${encodeURIComponent(id)}`, { method: "DELETE", body: { expectedVersion, confirm: "DELETE_MCP_CONNECTION" } })
  },
  webSearch: {
    status: () => request<WebSearchStatusDTO>("/api/web-search"),
    saveKey: (apiKey: string | null) => request<WebSearchStatusDTO>("/api/web-search", { method: "PUT", body: { apiKey } })
  },
  readiness: {
    get: () => request<ReadinessDTO>("/api/readiness"),
    testConnection: (
      mode: "metadata" | "inference" = "metadata",
      confirmCost = false,
      signal?: AbortSignal
    ) => request<ConnectionDiagnosticDTO>("/api/readiness/connection-tests", {
      method: "POST",
      body: { mode, confirmCost },
      signal
    }),
    cancelConnectionTest: (testId: string) =>
      request<{ cancelled: boolean; testId: string }>(
        `/api/readiness/connection-tests/${encodeURIComponent(testId)}`,
        { method: "DELETE" }
      )
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
      return request<PaginatedCharactersDTO>(withQuery("/api/characters/page", {
        q: query.q?.trim() || undefined,
        tag: query.tag?.trim() || undefined,
        favoriteOnly: query.favoriteOnly ? "true" : undefined,
        sort: query.sort,
        page: query.page === undefined ? undefined : String(query.page),
        pageSize: query.pageSize === undefined ? undefined : String(query.pageSize)
      }));
    },
    create: (input: CharacterInput) =>
      request<CharacterDTO>("/api/characters", { method: "POST", body: input }),
    previewRegex: (input: { scripts: CharacterInput["regexScripts"]; content: string; role: "assistant" | "user"; stage: "stored" | "render" }) =>
      request<{ content: string }>("/api/characters/regex-preview", { method: "POST", body: input }),
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
    agentSession: (id: string) => request<AgentSessionDTO>(`/api/chats/${encodeURIComponent(id)}/agent/session`),
    agentTask: (id: string, input: AgentTaskRequestDTO) => request<AgentSessionDTO>(`/api/chats/${encodeURIComponent(id)}/agent/tasks`, { method: "POST", body: input }),
    agentRunStatus: (id: string, runId: string) => request<AgentRunStatusDTO>(`/api/chats/${encodeURIComponent(id)}/agent/runs/${encodeURIComponent(runId)}`),
    agentPendingApproval: (id: string, runId: string) => request<PendingMcpApprovalDTO | null>(`/api/chats/${encodeURIComponent(id)}/agent/runs/${encodeURIComponent(runId)}/approval`),
    decideAgentApproval: (id: string, runId: string, callId: string, input: { approved: boolean; sessionGrant: boolean }) =>
      request<{ accepted: boolean }>(`/api/chats/${encodeURIComponent(id)}/agent/runs/${encodeURIComponent(runId)}/approval/${encodeURIComponent(callId)}`, { method: "POST", body: input }),
    generationPendingApproval: (id: string, runId: string) => request<PendingMcpApprovalDTO | null>(`/api/chats/${encodeURIComponent(id)}/generation/runs/${encodeURIComponent(runId)}/approval`),
    decideGenerationApproval: (id: string, runId: string, callId: string, input: { approved: boolean; sessionGrant: boolean }) =>
      request<{ accepted: boolean }>(`/api/chats/${encodeURIComponent(id)}/generation/runs/${encodeURIComponent(runId)}/approval/${encodeURIComponent(callId)}`, { method: "POST", body: input }),
    previewAgentAction: (id: string, actionId: string, candidate: { title: string; content: string; keywords: string[] }, accessPassword?: string) => request<ChatAgentActionPreviewDTO>(`/api/chats/${encodeURIComponent(id)}/agent/actions/${encodeURIComponent(actionId)}/preview`, { method: "POST", body: { candidate, ...(accessPassword ? { accessPassword } : {}) } }),
    confirmAgentMemory: (id: string, actionId: string, candidate: { title: string; content: string; keywords: string[] }) => request<{ memory: ChatMemoryDTO; session: AgentSessionDTO; operationId: string | null }>(`/api/chats/${encodeURIComponent(id)}/agent/actions/${encodeURIComponent(actionId)}/confirm-memory`, { method: "POST", body: { confirm: "APPLY_AGENT_MEMORY", candidate } }),
    confirmAgentLore: (id: string, actionId: string, candidate: { title: string; content: string; keywords: string[] }, accessPassword?: string) => request<{ characterId: string; characterName: string; affectedChatCount: number; session: AgentSessionDTO; alreadyApplied: boolean }>(`/api/chats/${encodeURIComponent(id)}/agent/actions/${encodeURIComponent(actionId)}/confirm-lore`, { method: "POST", body: { confirm: "APPLY_AGENT_LORE", candidate, ...(accessPassword ? { accessPassword } : {}) } }),
    cancelAgentTask: (id: string, runId: string) => request<{ cancelled: boolean }>(`/api/chats/${encodeURIComponent(id)}/agent/tasks/${encodeURIComponent(runId)}/cancel`, { method: "POST" }),
    clearAgentSession: (id: string) => request<{ cleared: boolean }>(`/api/chats/${encodeURIComponent(id)}/agent/session`, { method: "DELETE" }),
    listDraftHandoffs: (id: string, signal?: AbortSignal) => request<DraftHandoffDTO[]>(`/api/chats/${encodeURIComponent(id)}/draft/handoffs`, { signal }),
    getDraftHandoff: (id: string, handoffId: string) => request<DraftHandoffDTO>(`/api/chats/${encodeURIComponent(id)}/draft/handoffs/${handoffId}`),
    createDraftHandoff: (id: string, body: { id: string; expectedVersion: number; purpose: "send" | "queue" }, signal?: AbortSignal) =>
      request<{ draft: ChatDraftDTO; handoff: DraftHandoffDTO }>(`/api/chats/${encodeURIComponent(id)}/draft/handoffs`, { method: "POST", body, signal }),
    restoreDraftHandoff: (id: string, handoffId: string, body: { expectedVersion: number; mutationId: string }, signal?: AbortSignal) =>
      request<ChatDraftDTO>(`/api/chats/${encodeURIComponent(id)}/draft/handoffs/${handoffId}/restore`, { method: "POST", body, signal }),
    discardDraftHandoff: (id: string, handoffId: string) => request<void>(`/api/chats/${encodeURIComponent(id)}/draft/handoffs/${handoffId}`, { method: "DELETE" }),
    getDraft: (id: string, signal?: AbortSignal) => request<ChatDraftDTO>(`/api/chats/${encodeURIComponent(id)}/draft`, { signal }),
    saveDraft: (id: string, body: ChatDraftSaveInput, signal?: AbortSignal) =>
      request<ChatDraftDTO>(`/api/chats/${encodeURIComponent(id)}/draft`, { method: "PUT", body, signal }),
    list: () => request<ChatDTO[]>("/api/chats"),
    page: (input: { scope?: "active" | "archived" | "trash" | "all"; folder?: string; q?: string; limit?: number; cursor?: string; includeTotal?: boolean } = {}, signal?: AbortSignal) => {
      return request<ChatPageDTO>(withQuery("/api/chats/page", {
        scope: input.scope,
        folder: input.folder,
        q: input.q,
        limit: input.limit ? String(input.limit) : undefined,
        cursor: input.cursor,
        includeTotal: input.includeTotal === undefined ? undefined : String(input.includeTotal)
      }), { signal });
    },
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
    agentHistorySearch: (id: string, query: string, limit = 10, cursor?: string) =>
      request<ChatMessageSearchDTO>(withQuery(`/api/chats/${encodeURIComponent(id)}/agent/history-search`, {
        q: query,
        limit: String(limit),
        cursor
      })),
    globalMessageSearch: (query: string, limit = 20) =>
      request<GlobalChatMessageSearchDTO>(
        `/api/chats/message-search?q=${encodeURIComponent(query)}&limit=${limit}`
      ),
    memories: {
      list: (chatId: string) => request<ChatMemoryDTO[]>(`/api/chats/${chatId}/memories`),
      get: (chatId: string, memoryId: string) => request<ChatMemoryDTO>(`/api/chats/${chatId}/memories/${memoryId}`),
      page: (chatId: string, cursor?: string, includeTotal = false) =>
        request<ChatMemoryPageDTO>(withQuery(`/api/chats/${chatId}/memories/page`, {
          limit: "100",
          cursor,
          includeTotal: includeTotal ? "true" : undefined
        })),
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
      startReindex: (chatId: string) =>
        request<MemoryEmbeddingJobStatusDTO>(`/api/chats/${chatId}/memories/reindex-jobs`, { method: "POST" }),
      reindexStatus: (chatId: string, jobId: string) =>
        request<MemoryEmbeddingJobStatusDTO>(`/api/chats/${chatId}/memories/reindex-jobs/${jobId}`),
      cancelReindex: (chatId: string, jobId: string) =>
        request<MemoryEmbeddingJobStatusDTO>(`/api/chats/${chatId}/memories/reindex-jobs/${jobId}`, { method: "DELETE" }),
      indexSummary: (chatId: string) =>
        request<MemoryIndexSummaryDTO>(`/api/chats/${chatId}/memories/index-summary`),
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
    uploadChatImage: (input: { draftId: string; dataBase64: string; mimeType: "image/png" | "image/jpeg"; originalFilename?: string }, signal?: AbortSignal) =>
      request<DraftImageAttachmentDTO>("/api/media/chat-images/drafts", { method: "POST", body: input, signal }),
    listDraftChatImages: (draftId: string, signal?: AbortSignal) => request<DraftImageAttachmentDTO[]>(`/api/media/chat-images/drafts/${encodeURIComponent(draftId)}`, { signal }),
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
    auto: {
      get: () => request<LanAutoSyncStatusDTO>("/api/sync/auto"),
      update: (input: LanAutoSyncSettingsInputDTO) =>
        request<LanAutoSyncStatusDTO>("/api/sync/auto", { method: "PUT", body: input }),
      run: () => request<LanAutoSyncStatusDTO>("/api/sync/auto/run", { method: "POST" })
    },
    pull: (input: LanSyncRequestDTO) =>
      request<LanSyncSummaryDTO>("/api/sync/pull", { method: "POST", body: input }),
    push: (input: LanSyncRequestDTO) =>
      request<LanSyncSummaryDTO>("/api/sync/push", { method: "POST", body: input })
  }
};
