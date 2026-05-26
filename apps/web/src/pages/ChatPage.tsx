import {
  ChevronLeft,
  ChevronRight,
  Check,
  MessageSquarePlus,
  RefreshCw,
  Search,
  Send,
  Settings,
  Sparkles,
  StopCircle,
  Trash2,
  X
} from "lucide-react";
import {
  emptyUserCustomConfig,
  hasUserCustomConfigContent,
  parseUserCustomConfig,
  serializeUserCustomConfig,
  type UserCustomConfigDTO
} from "@local-roleplay/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { api } from "../lib/api";
import { generateId } from "../lib/uuid";
import { useWebSocket } from "../lib/useWebSocket";
import { useAppStore } from "../store/useAppStore";
import type {
  CharacterDTO,
  ChatDTO,
  ChatWithMessagesDTO,
  GenerationClientMessage,
  GenerationServerMessage,
  MessageDTO,
  ModelPreset,
  PublicUserSettingsDTO,
  SettingsInput,
  TokenUsageDTO
} from "../types";
import { Badge, Button, ConfirmDialog, EmptyState, ErrorNotice, Field, Panel, SuccessNotice, TextArea, TextInput } from "../components/ui";
import {
  AssistantMessageBubble,
  StreamingBubble,
  SystemNotification,
  UserMessageBubble
} from "../components/messages";

const MESSAGES_PER_PAGE = 30;
const CREATE_CHAT_CHARACTER_PAGE_SIZE = 40;

const emptyCreateCharacterPage = {
  items: [] as CharacterDTO[],
  total: 0,
  page: 1,
  pageSize: CREATE_CHAT_CHARACTER_PAGE_SIZE,
  totalPages: 1
};

export function ChatPage() {
  const { language, t } = useI18n();
  const showMessageAvatars = useAppStore((state) => state.showMessageAvatars);
  const [mobilePane, setMobilePane] = useState<"chats" | "messages" | "create">("messages");
  const [characters, setCharacters] = useState<CharacterDTO[]>([]);
  const [createCharacters, setCreateCharacters] = useState<CharacterDTO[]>([]);
  const [createCharacterSearch, setCreateCharacterSearch] = useState("");
  const [createCharacterPage, setCreateCharacterPage] = useState(1);
  const [createCharacterPagination, setCreateCharacterPagination] = useState(emptyCreateCharacterPage);
  const [selectedCreateCharacter, setSelectedCreateCharacter] = useState<CharacterDTO | null>(null);
  const [chats, setChats] = useState<ChatDTO[]>([]);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [activeChat, setActiveChat] = useState<ChatWithMessagesDTO | null>(null);
  const [title, setTitle] = useState("");
  const [characterIds, setCharacterIds] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [streamingContent, setStreamingContent] = useState("");
  const [streamingCharacterId, setStreamingCharacterId] = useState<string | null>(null);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [editingMessage, setEditingMessage] = useState<MessageDTO | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [memorySettingsOpen, setMemorySettingsOpen] = useState(false);
  const [memoryDraft, setMemoryDraft] = useState("12");
  const memorySettingsRef = useRef<HTMLDivElement | null>(null);
  const personaEditorRef = useRef<HTMLDivElement | null>(null);
  const profileEditorRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (memorySettingsOpen && memorySettingsRef.current && !memorySettingsRef.current.contains(event.target as Node)) {
        setMemorySettingsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [memorySettingsOpen]);

  const [settingsModels, setSettingsModels] = useState<ModelPreset[]>([]);
  const [activeModelId, setActiveModelId] = useState<string | null>(null);
  const [runtimeSettings, setRuntimeSettings] = useState<Pick<
    PublicUserSettingsDTO,
    "activeProvider" | "apiBaseUrl" | "model" | "temperature" | "maxTokens" | "topP" | "language"
  > | null>(null);
  const [autoSummarizeUser, setAutoSummarizeUser] = useState(true);
  const [editingPersona, setEditingPersona] = useState(false);
  const [editingPersonaDraft, setEditingPersonaDraft] = useState<UserCustomConfigDTO>(
    () => emptyUserCustomConfig()
  );
  const [editingProfile, setEditingProfile] = useState(false);
  const [editingProfileDraft, setEditingProfileDraft] = useState("");
  const [pendingDeleteChat, setPendingDeleteChat] = useState<ChatDTO | null>(null);
  const [pendingDeleteMessage, setPendingDeleteMessage] = useState<MessageDTO | null>(null);
  const [messagePage, setMessagePage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const streamingBufferRef = useRef("");
  const messageViewportRef = useRef<HTMLDivElement | null>(null);
  const createCharacterRequestRef = useRef(0);
  const paginationStateRef = useRef<{ chatId: string | null; totalPages: number }>({
    chatId: null,
    totalPages: 1
  });

  const upsertMessage = (message: MessageDTO) => {
    setActiveChat((current) => {
      if (!current || current.id !== message.chatId) {
        return current;
      }

      if (current.messages.some((item) => item.id === message.id)) {
        return {
          ...current,
          messages: current.messages.map((item) => (item.id === message.id ? message : item))
        };
      }

      return {
        ...current,
        messages: [...current.messages, message]
      };
    });
  };

  const applyChatUpdate = (updated: ChatDTO) => {
    setChats((current) => current.map((chat) => (chat.id === updated.id ? updated : chat)));
    setActiveChat((current) =>
      current && current.id === updated.id
        ? {
            ...current,
            ...updated
          }
        : current
    );
  };

  const onMessageHandlersRef = useRef<{
    upsertMessage: (message: MessageDTO) => void;
    setStreamingContent: (value: React.SetStateAction<string>) => void;
  }>({ upsertMessage: () => {}, setStreamingContent: () => {} });

  const { send: sendWs, connect, disconnect, isConnected } = useWebSocket({
    onMessage(message) {
      const handlers = onMessageHandlersRef.current;
      const msg = message as GenerationServerMessage;

      if (msg.type === "user_message") {
        handlers.upsertMessage(msg.message);
        return;
      }

      if (msg.type === "token") {
        streamingBufferRef.current += msg.content;
        return;
      }

      if (msg.type === "generation_character_started") {
        setStreamingCharacterId(msg.characterId);
        setStreamingContent("");
        streamingBufferRef.current = "";
        return;
      }

      if (msg.type === "lore_matches") {
        return;
      }

      if (msg.type === "assistant_message") {
        handlers.upsertMessage(msg.message);
        setStreamingContent("");
        setStreamingCharacterId(null);
        streamingBufferRef.current = "";
        return;
      }

      if (msg.type === "generation_started") {
        setActiveRequestId(msg.requestId);
        setStreamingContent("");
        setStreamingCharacterId(null);
        streamingBufferRef.current = "";
        return;
      }

      if (msg.type === "user_profile_updated") {
        setActiveChat((current) =>
          current
            ? { ...current, userProfileSummary: msg.summary, userProfileUpdatedAt: msg.updatedAt }
            : current
        );
        return;
      }

      if (msg.type === "generation_done" || msg.type === "generation_stopped") {
        setActiveRequestId(null);
        setStreamingContent("");
        setStreamingCharacterId(null);
        streamingBufferRef.current = "";
        setLoading(false);
        return;
      }

      if (msg.type === "error") {
        setError(msg.error);
        setActiveRequestId(null);
        setStreamingContent("");
        setStreamingCharacterId(null);
        streamingBufferRef.current = "";
        setLoading(false);
        return;
      }
    }
  });

  useEffect(() => {
    onMessageHandlersRef.current = {
      upsertMessage,
      setStreamingContent
    };
  }, [upsertMessage, setStreamingContent]);

  useEffect(() => {
    if (!activeRequestId) {
      return;
    }

    const intervalId = setInterval(() => {
      if (streamingBufferRef.current) {
        setStreamingContent((prev) => prev + streamingBufferRef.current);
        streamingBufferRef.current = "";
      }
    }, 40);

    return () => clearInterval(intervalId);
  }, [activeRequestId]);

  useEffect(() => {
    connect();
  }, []);

  const characterMap = useMemo(
    () => new Map(characters.map((character) => [character.id, character])),
    [characters]
  );

  const mergeCharacterCache = (nextCharacters: CharacterDTO[]) => {
    setCharacters((current) => {
      const byId = new Map(current.map((character) => [character.id, character]));
      for (const character of nextCharacters) {
        byId.set(character.id, character);
      }
      return Array.from(byId.values());
    });
  };

  const formatTokenUsage = (usage: TokenUsageDTO | null) => {
    if (!usage) {
      return t("chat.tokensUnavailable");
    }

    const detail = t("chat.tokensUsage", {
      prompt: usage.promptTokens,
      completion: usage.completionTokens,
      total: usage.totalTokens
    });

    return usage.estimated ? `${detail} · ${t("chat.tokensEstimated")}` : detail;
  };

  const getTriggeredLorebooks = (message: MessageDTO) => {
    const books = new Map<string, { id: string; name: string; keys: Set<string>; count: number }>();

    for (const entry of message.loreMatches) {
      const id = entry.characterId;
      const existing = books.get(id);
      const name = entry.characterName?.trim() || entry.keys[0] || t("nav.characters");

      if (existing) {
        existing.count += 1;
        entry.keys.forEach((key) => existing.keys.add(key));
        continue;
      }

      books.set(id, {
        id,
        name,
        keys: new Set(entry.keys),
        count: 1
      });
    }

    return Array.from(books.values());
  };

  const getCharacterInitials = (name: string | undefined) => {
    const trimmed = name?.trim();
    return trimmed ? trimmed.slice(0, 2) : t("common.unknown").slice(0, 2);
  };

  const totalMessagePages = useMemo(() => {
    const totalMessages = activeChat?.messages.length ?? 0;
    return Math.max(1, Math.ceil(totalMessages / MESSAGES_PER_PAGE));
  }, [activeChat?.messages.length]);

  const safeMessagePage = Math.min(messagePage, totalMessagePages);

  const pagedMessages = useMemo(() => {
    if (!activeChat) {
      return [];
    }

    const startIndex = (safeMessagePage - 1) * MESSAGES_PER_PAGE;
    return activeChat.messages.slice(startIndex, startIndex + MESSAGES_PER_PAGE);
  }, [activeChat, safeMessagePage]);

  const pageRange = useMemo(() => {
    const totalMessages = activeChat?.messages.length ?? 0;

    if (totalMessages === 0) {
      return { start: 0, end: 0, total: 0 };
    }

    const start = (safeMessagePage - 1) * MESSAGES_PER_PAGE + 1;
    const end = Math.min(start + pagedMessages.length - 1, totalMessages);
    return { start, end, total: totalMessages };
  }, [activeChat?.messages.length, pagedMessages.length, safeMessagePage]);

  const createCharacterRange = useMemo(() => {
    if (createCharacterPagination.total === 0) {
      return { start: 0, end: 0 };
    }

    const start = (createCharacterPagination.page - 1) * createCharacterPagination.pageSize + 1;
    const end = Math.min(start + createCharacterPagination.items.length - 1, createCharacterPagination.total);
    return { start, end };
  }, [createCharacterPagination]);

  const createCharacterPaginationCopy =
    createCharacterPagination.total === 0
      ? t("characters.noSearchResults")
      : `${createCharacterRange.start}-${createCharacterRange.end} / ${createCharacterPagination.total}`;

  const activeUserConfig = useMemo(
    () => parseUserCustomConfig(activeChat?.userPersona),
    [activeChat?.userPersona]
  );
  const hasActiveUserConfig = hasUserCustomConfigContent(activeUserConfig);

  const paginationCopy =
    language === "zh-CN"
      ? {
          previous: "上一页",
          next: "下一页",
          newest: "最新页",
          page: `第 ${safeMessagePage} / ${totalMessagePages} 页`,
          range: `显示 ${pageRange.start}-${pageRange.end} / ${pageRange.total}`
        }
      : {
          previous: "Previous",
          next: "Next",
          newest: "Newest",
          page: `Page ${safeMessagePage} / ${totalMessagePages}`,
          range: `Showing ${pageRange.start}-${pageRange.end} of ${pageRange.total}`
        };

  const loadBase = async () => {
    const [chatData, settings] = await Promise.all([
      api.chats.list(),
      api.settings.get()
    ]);
    setChats(chatData);
    setSettingsModels(settings.models ?? []);
    setRuntimeSettings({
      activeProvider: settings.activeProvider,
      apiBaseUrl: settings.apiBaseUrl,
      model: settings.model,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      topP: settings.topP,
      language: settings.language
    });
    setAutoSummarizeUser(settings.autoSummarizeUser);
    useAppStore.getState().setShowMessageAvatars(settings.showMessageAvatars);
    if (settings.models?.length) {
      setActiveModelId(settings.models[0].id);
    }
    if (!selectedChatId && chatData[0]) {
      setSelectedChatId(chatData[0].id);
    }
  };

  const loadChat = async (id: string | null) => {
    if (!id) {
      setActiveChat(null);
      return;
    }
    const chat = await api.chats.get(id);
    setActiveChat(chat);
    setMemoryDraft(String(chat.memoryTurns));

    const missingCharacterIds = chat.characterIds.filter((characterId) => !characterMap.has(characterId));
    if (missingCharacterIds.length > 0) {
      const fetchedCharacters = await Promise.all(
        missingCharacterIds.map((characterId) => api.characters.get(characterId).catch(() => null))
      );
      mergeCharacterCache(fetchedCharacters.filter((character): character is CharacterDTO => character !== null));
    }
  };

  useEffect(() => {
    void loadBase().catch((caught: unknown) =>
      setError(caught instanceof Error ? caught.message : t("chat.failedLoad"))
    );
  }, [t]);

  useEffect(() => {
    const requestId = createCharacterRequestRef.current + 1;
    createCharacterRequestRef.current = requestId;

    void api.characters
      .page({
        q: createCharacterSearch,
        page: createCharacterPage,
        pageSize: CREATE_CHAT_CHARACTER_PAGE_SIZE
      })
      .then((data) => {
        if (requestId !== createCharacterRequestRef.current) {
          return;
        }

        if (data.items.length === 0 && data.total > 0 && data.page > 1) {
          setCreateCharacterPage(data.page - 1);
          return;
        }

        setCreateCharacters(data.items);
        setCreateCharacterPagination(data);
        mergeCharacterCache(data.items);
      })
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : t("characters.failedLoad"))
      );
  }, [createCharacterPage, createCharacterSearch, t]);

  useEffect(() => {
    void loadChat(selectedChatId).catch((caught: unknown) =>
      setError(caught instanceof Error ? caught.message : t("chat.failedLoadChat"))
    );
  }, [selectedChatId, t]);

  useEffect(() => {
    const chatId = activeChat?.id ?? null;
    const totalPages = Math.max(1, Math.ceil((activeChat?.messages.length ?? 0) / MESSAGES_PER_PAGE));
    const previous = paginationStateRef.current;

    setMessagePage((current) => {
      if (!chatId) {
        return 1;
      }

      if (previous.chatId !== chatId) {
        return totalPages;
      }

      if (current > totalPages) {
        return totalPages;
      }

      if (current === previous.totalPages && totalPages > previous.totalPages) {
        return totalPages;
      }

      return current;
    });

    paginationStateRef.current = { chatId, totalPages };
  }, [activeChat?.id, activeChat?.messages.length]);

  useEffect(() => {
    const viewport = messageViewportRef.current;
    if (!viewport) {
      return;
    }

    if (safeMessagePage >= totalMessagePages) {
      viewport.scrollTop = viewport.scrollHeight;
      return;
    }

    viewport.scrollTop = 0;
  }, [activeChat?.id, safeMessagePage, totalMessagePages]);

  useEffect(
    () => () => {
      disconnect();
    },
    []
  );

  useEffect(() => {
    if (!status) {
      return;
    }

    const timeoutId = window.setTimeout(() => setStatus(null), 2200);
    return () => window.clearTimeout(timeoutId);
  }, [status]);

  const toggleCharacter = (character: CharacterDTO) => {
    setCharacterIds((current) => (current.includes(character.id) ? [] : [character.id]));
    setSelectedCreateCharacter((current) => (current?.id === character.id ? null : character));
    mergeCharacterCache([character]);
  };

  const createChat = async () => {
    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const chat = await api.chats.create({
        title: title.trim(),
        mode: "single",
        characterIds
      });
      setTitle("");
      setCharacterIds([]);
      setSelectedCreateCharacter(null);
      setSelectedChatId(chat.id);
      setMobilePane("messages");
      await loadBase();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedCreate"));
    } finally {
      setLoading(false);
    }
  };

  const openMemorySettings = () => {
    if (!activeChat) {
      return;
    }

    setMemoryDraft(String(activeChat.memoryTurns));
    setMemorySettingsOpen((current) => {
      if (!current) {
        void api.settings.get().then((settings) => {
          const models = settings.models ?? [];
          setSettingsModels(models);
          setRuntimeSettings({
            activeProvider: settings.activeProvider,
            apiBaseUrl: settings.apiBaseUrl,
            model: settings.model,
            temperature: settings.temperature,
            maxTokens: settings.maxTokens,
            topP: settings.topP,
            language: settings.language
          });
          setAutoSummarizeUser(settings.autoSummarizeUser);
          if (models.length > 0) {
            const active = models.find(
              (m) => m.provider === settings.activeProvider && m.model === settings.model
            );
            setActiveModelId(active?.id ?? models[0].id);
          } else {
            setActiveModelId(null);
          }
          useAppStore.getState().setShowMessageAvatars(settings.showMessageAvatars);
        });
      }
      return !current;
    });
  };

  const handleMemorySettingsPointerDownCapture = (event: React.PointerEvent<HTMLDivElement>) => {
    if (editingPersona && personaEditorRef.current && !personaEditorRef.current.contains(event.target as Node)) {
      setEditingPersona(false);
      setEditingPersonaDraft(emptyUserCustomConfig());
    }

    if (!editingProfile || !profileEditorRef.current) {
      return;
    }

    if (!profileEditorRef.current.contains(event.target as Node)) {
      setEditingProfile(false);
      setEditingProfileDraft("");
    }
  };

  const clearUserConfig = async () => {
    if (!activeChat) {
      return;
    }

    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const updated = await api.chats.update(activeChat.id, { userPersona: "" });
      applyChatUpdate(updated);
      setEditingPersona(false);
      setEditingPersonaDraft(emptyUserCustomConfig());
      setStatus(t("chat.userConfigCleared"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedUpdateUserConfig"));
    } finally {
      setLoading(false);
    }
  };

  const saveUserConfig = async () => {
    if (!activeChat) {
      return;
    }

    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const userPersona = serializeUserCustomConfig(editingPersonaDraft);
      const updated = await api.chats.update(activeChat.id, { userPersona });
      applyChatUpdate(updated);
      setEditingPersona(false);
      setStatus(t("chat.userConfigSaved"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedUpdateUserConfig"));
    } finally {
      setLoading(false);
    }
  };

  const clearUserProfileSummary = async () => {
    if (!activeChat) {
      return;
    }

    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const updated = await api.chats.update(activeChat.id, { userProfileSummary: "" });
      applyChatUpdate(updated);
      setEditingProfile(false);
      setStatus(t("chat.userProfileCleared"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedUpdateUserProfile"));
    } finally {
      setLoading(false);
    }
  };

  const saveUserProfileSummary = async () => {
    if (!activeChat) {
      return;
    }

    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const summary = editingProfileDraft.trim();
      const updated = await api.chats.update(activeChat.id, {
        userProfileSummary: summary
      });
      applyChatUpdate(updated);
      setEditingProfile(false);
      setStatus(t("chat.userProfileSaved"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedUpdateUserProfile"));
    } finally {
      setLoading(false);
    }
  };

  const startEditingUserConfig = () => {
    setEditingPersonaDraft(parseUserCustomConfig(activeChat?.userPersona));
    setEditingPersona(true);
  };

  const cancelEditingUserConfig = () => {
    setEditingPersona(false);
    setEditingPersonaDraft(emptyUserCustomConfig());
  };

  const startEditingProfile = () => {
    setEditingProfileDraft(activeChat?.userProfileSummary ?? "");
    setEditingProfile(true);
  };

  const cancelEditingProfile = () => {
    setEditingProfile(false);
    setEditingProfileDraft("");
  };

  const updateUserConfigDraft = (field: keyof UserCustomConfigDTO, value: string) => {
    setEditingPersonaDraft((current) => ({
      ...current,
      [field]: value
    }));
  };

  const updateAutoSummarizeUser = async (enabled: boolean) => {
    setAutoSummarizeUser(enabled);
    try {
      await api.settings.updateUserProfile({
        userProfileSummary: "",
        autoSummarizeUser: enabled
      });
    } catch (caught) {
      setAutoSummarizeUser((current) => !current);
      setError(caught instanceof Error ? caught.message : t("chat.failedUpdateUserProfile"));
    }
  };

  const updateMemory = async () => {
    if (!activeChat) {
      return;
    }

    const parsed = Number(memoryDraft);
    const memoryTurns = Math.max(1, Math.min(50, Number.isFinite(parsed) ? Math.floor(parsed) : activeChat.memoryTurns));

    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const updated = await api.chats.update(activeChat.id, {
        memoryTurns
      });
      setActiveChat((current) =>
        current
          ? {
              ...current,
              memoryTurns: updated.memoryTurns
            }
          : current
      );
      setChats((current) =>
        current.map((chat) =>
          chat.id === updated.id
            ? { ...chat, memoryTurns: updated.memoryTurns }
            : chat
        )
      );
      setMemorySettingsOpen(false);
      setStatus(t("chat.chatSettingsSaved"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedUpdateMemory"));
    } finally {
      setLoading(false);
    }
  };

  const switchModel = async (model: ModelPreset) => {
    if (!runtimeSettings) {
      return;
    }

    const previousModelId = activeModelId;
    setLoading(true);
    setError(null);
    setStatus(null);
    setActiveModelId(model.id);
    setMemorySettingsOpen(false);

    const payload: SettingsInput = {
      activeProvider: model.provider,
      apiBaseUrl: model.apiBaseUrl,
      model: model.model,
      temperature: runtimeSettings.temperature,
      maxTokens: runtimeSettings.maxTokens,
      topP: runtimeSettings.topP,
      language: runtimeSettings.language,
      models: settingsModels
    };

    if (model.key?.trim()) {
      payload.apiKey = model.key.trim();
    }

    try {
      const updated = await api.settings.update(payload);
      setSettingsModels(updated.models ?? []);
      setRuntimeSettings({
        activeProvider: updated.activeProvider,
        apiBaseUrl: updated.apiBaseUrl,
        model: updated.model,
        temperature: updated.temperature,
        maxTokens: updated.maxTokens,
        topP: updated.topP,
        language: updated.language
      });
      useAppStore.getState().setShowMessageAvatars(updated.showMessageAvatars);
      const matchedModel = (updated.models ?? []).find(
        (item) =>
          item.provider === updated.activeProvider &&
          item.apiBaseUrl === updated.apiBaseUrl &&
          item.model === updated.model
      );
      setActiveModelId(matchedModel?.id ?? model.id);
      setStatus(t("chat.modelSwitched", { label: model.label || model.model }));
    } catch (caught) {
      setActiveModelId(previousModelId);
      setError(caught instanceof Error ? caught.message : t("chat.failedUpdateMemory"));
    } finally {
      setLoading(false);
    }
  };

  const deleteChat = async () => {
    if (!pendingDeleteChat) {
      return;
    }

    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      await api.chats.remove(pendingDeleteChat.id);
      setPendingDeleteChat(null);
      setSelectedChatId(null);
      setActiveChat(null);
      await loadBase();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedDelete"));
    } finally {
      setLoading(false);
    }
  };

  const sendMessage = async () => {
    if (!activeChat || !draft.trim()) {
      return;
    }

    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      if (!isConnected) {
        throw new Error(t("chat.websocketFailed"));
      }
      const requestId = generateId();
      const payload: GenerationClientMessage = {
        type: "generate",
        requestId,
        chatId: activeChat.id,
        content: draft.trim(),
        targetCharacterId: null
      };
      setActiveRequestId(requestId);
      setStreamingContent("");
      setStreamingCharacterId(null);
      streamingBufferRef.current = "";
      setDraft("");
      sendWs(payload);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedSend"));
      setLoading(false);
      setActiveRequestId(null);
    } finally {
      // Loading ends when the WebSocket sends generation_done, generation_stopped, or error.
    }
  };

  const stopGeneration = () => {
    if (!activeRequestId) {
      return;
    }

    const payload: GenerationClientMessage = {
      type: "stop",
      requestId: activeRequestId
    };
    sendWs(payload);
  };

  const regenerateMessage = async (message: MessageDTO) => {
    if (message.role !== "assistant") {
      return;
    }

    setLoading(true);
    setError(null);
    try {
      if (!isConnected) {
        throw new Error(t("chat.websocketFailed"));
      }
      const requestId = generateId();
      const payload: GenerationClientMessage = {
        type: "regenerate",
        requestId,
        messageId: message.id
      };
      setActiveRequestId(requestId);
      setStreamingContent("");
      setStreamingCharacterId(message.characterId);
      streamingBufferRef.current = "";
      sendWs(payload);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedRegenerate"));
      setLoading(false);
      setActiveRequestId(null);
    }
  };

  const copyMessage = async (message: MessageDTO) => {
    try {
      await navigator.clipboard.writeText(message.content);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = message.content;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
  };

  const switchVariant = async (message: MessageDTO, direction: -1 | 1) => {
    if (message.variants.length <= 1) {
      return;
    }

    const nextIndex =
      (message.activeVariantIndex + direction + message.variants.length) % message.variants.length;
    const content = message.variants[nextIndex] ?? message.content;
    const updated = await api.messages.update(message.id, {
      content,
      activeVariantIndex: nextIndex
    });
    upsertMessage(updated);
  };

  const startEditingMessage = (message: MessageDTO) => {
    setEditingMessage(message);
    setEditDraft(message.content);
  };

  const cancelEditingMessage = () => {
    setEditingMessage(null);
    setEditDraft("");
  };

  const saveEditedMessage = async () => {
    if (!editingMessage) {
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const updated = await api.messages.update(editingMessage.id, { content: editDraft });
      upsertMessage(updated);
      cancelEditingMessage();
      setStatus(t("chat.messageSaved"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedEdit"));
    } finally {
      setLoading(false);
    }
  };

  const deleteMessage = async () => {
    if (!pendingDeleteMessage) {
      return;
    }

    await api.messages.remove(pendingDeleteMessage.id);
    await loadChat(pendingDeleteMessage.chatId);
    setPendingDeleteMessage(null);
  };

  return (
    <>
    <div className="mb-5 grid grid-cols-3 gap-1 rounded-xl border border-white/10 bg-ink-900/80 p-1 xl:hidden">
      {[
        { key: "chats", label: t("chat.chats") },
        { key: "messages", label: t("chat.messageStream") },
        { key: "create", label: t("chat.createChat") }
      ].map((item) => (
        <button
          className={`min-h-10 rounded-lg px-2 text-xs font-medium transition-colors ${
            mobilePane === item.key
              ? "bg-ember-500 text-ink-950 shadow-md shadow-ember-500/20"
              : "text-slate-300 hover:bg-white/10 hover:text-slate-100"
          }`}
          key={item.key}
          type="button"
          onClick={() => setMobilePane(item.key as "chats" | "messages" | "create")}
        >
          {item.label}
        </button>
      ))}
    </div>
    <div className="grid min-w-0 gap-8 xl:h-[calc(100vh-112px)] xl:min-h-0 xl:grid-cols-[300px_minmax(0,1fr)_300px] 2xl:grid-cols-[340px_minmax(0,1fr)_320px]">
      <div
        className={
          mobilePane === "chats"
            ? "block min-w-0 xl:h-full xl:min-h-0"
            : "hidden min-w-0 xl:block xl:h-full xl:min-h-0"
        }
      >
      <Panel
        title={t("chat.chats")}
        action={
          <Button variant="secondary" onClick={() => void loadBase()} className="!min-h-[32px] !h-8 !px-3 text-xs">
            <RefreshCw size={14} />
            {t("common.refresh")}
          </Button>
        }
      >
        <div className="max-h-[calc(100vh-220px)] space-y-3 overflow-y-auto pr-1 xl:h-[calc(100%-40px)] xl:max-h-none">
          <ErrorNotice message={error} />
          <SuccessNotice message={status} />
          {chats.length === 0 ? (
            <EmptyState>{t("chat.noChats")}</EmptyState>
          ) : (
            chats.map((chat) => (
              <div
                className={`group w-full cursor-pointer rounded-xl border p-4 text-left text-sm transition-all duration-200 ${
                  selectedChatId === chat.id
                    ? "border-ember-500/50 bg-ember-500/10 shadow-md shadow-ember-500/5"
                    : "border-white/5 bg-white/5 hover:border-white/10 hover:bg-white/10"
                }`}
                key={chat.id}
                role="button"
                tabIndex={0}
                onClick={() => {
                  setSelectedChatId(chat.id);
                  setMobilePane("messages");
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setSelectedChatId(chat.id);
                    setMobilePane("messages");
                  }
                }}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className={`truncate font-medium transition-colors ${selectedChatId === chat.id ? 'text-ember-100' : 'text-slate-100 group-hover:text-white'}`}>{chat.title}</p>
                    <p className="mt-1.5 flex items-center gap-1.5 text-xs text-slate-400">
                      <span className="opacity-50">{t("chat.boundCharacters", { count: chat.characterIds.length })}</span>
                    </p>
                  </div>
                  <Button className="!h-8 !min-h-8 !w-8 !p-0 opacity-0 transition-opacity group-hover:opacity-100" variant="ghost" onClick={(event) => { event.stopPropagation(); setPendingDeleteChat(chat); }}>
                    <Trash2 size={14} className="text-rose-400" />
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
      </Panel>
      </div>

      <div
        className={
          mobilePane === "messages"
            ? "block min-w-0 xl:h-full xl:min-h-0"
            : "hidden min-w-0 xl:block xl:h-full xl:min-h-0"
        }
      >
      <Panel
        className="flex min-h-0 flex-col"
        title={activeChat?.title ?? t("chat.messageStream")}
        action={
          activeChat ? (
            <div className="relative" ref={memorySettingsRef}>
              <Button
                aria-expanded={memorySettingsOpen}
                aria-label={t("chat.memorySettings")}
                className="!h-8 !min-h-8 !w-8 !p-0"
                variant="ghost"
                onClick={openMemorySettings}
              >
                <Settings size={15} />
              </Button>
              {memorySettingsOpen ? (
                <div
                  className="custom-scrollbar absolute right-0 top-10 z-20 max-h-80 w-72 overflow-y-auto rounded-xl border border-white/10 bg-ink-900/95 p-3.5 shadow-xl shadow-black/30 backdrop-blur-md sm:max-h-[calc(100dvh-22rem)]"
                  onPointerDownCapture={handleMemorySettingsPointerDownCapture}
                >
                  {settingsModels.length > 0 ? (
                    <div className="mb-3 border-b border-white/10 pb-3">
                      <p className="mb-2 text-sm font-semibold text-slate-100">
                        {t("chat.modelSwitchTitle")}
                      </p>
                      <div className="space-y-1.5">
                        {settingsModels.map((model) => (
                          <button
                            className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm transition-colors ${
                              activeModelId === model.id
                                ? "bg-ember-500/15 text-ember-200 ring-1 ring-ember-500/30"
                                : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
                            }`}
                            disabled={loading}
                            key={model.id}
                            type="button"
                            onClick={() => void switchModel(model)}
                          >
                            <Sparkles
                              size={14}
                              className={activeModelId === model.id ? "text-ember-300" : "text-slate-500"}
                            />
                            <span className="min-w-0 flex-1 truncate font-medium">
                              {model.label || model.model}
                            </span>
                            <span className="ml-auto shrink-0 text-[11px] font-medium text-slate-500">
                              {model.provider}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  <div className="space-y-3">
                    <Field label={t("chat.memorySettings")} labelClassName="!text-sm !font-semibold !text-slate-100">
                      <TextInput
                        min={1}
                        max={50}
                        type="number"
                        value={memoryDraft}
                        onChange={(event) => setMemoryDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            void updateMemory();
                          }
                        }}
                      />
                    </Field>
                    <p className="whitespace-pre-line break-words text-xs leading-5 text-slate-400">
                      {t("chat.memoryHelp")}
                    </p>
                    <div className="border-t border-white/10 pt-3">
                      <div className="mb-2">
                        <p className="text-sm font-semibold text-slate-100">
                          {t("chat.userConfigTitle")}
                        </p>
                        <p className="mt-1 text-xs leading-5 text-slate-400">
                          {t("chat.userConfigHelp")}
                        </p>
                      </div>
                      {editingPersona ? (
                        <div ref={personaEditorRef} className="space-y-3">
                          <Field label={t("chat.userConfigPrefix")}>
                            <TextArea
                              className="!h-24 min-h-[96px] text-xs leading-5"
                              placeholder={t("chat.userConfigPrefixHelp")}
                              value={editingPersonaDraft.prefix}
                              onChange={(event) =>
                                updateUserConfigDraft("prefix", event.target.value)
                              }
                            />
                          </Field>
                          <Field label={t("chat.userConfigPrompt")}>
                            <TextArea
                              className="!h-28 min-h-[112px] text-xs leading-5"
                              placeholder={t("chat.userConfigPromptHelp")}
                              value={editingPersonaDraft.prompt}
                              onChange={(event) =>
                                updateUserConfigDraft("prompt", event.target.value)
                              }
                            />
                          </Field>
                          <Field label={t("chat.userConfigSuffix")}>
                            <TextArea
                              className="!h-24 min-h-[96px] text-xs leading-5"
                              placeholder={t("chat.userConfigSuffixHelp")}
                              value={editingPersonaDraft.suffix}
                              onChange={(event) =>
                                updateUserConfigDraft("suffix", event.target.value)
                              }
                            />
                          </Field>
                          <div className="flex gap-2">
                            <Button
                              className="flex-1 !min-h-[32px] text-xs"
                              disabled={loading}
                              onClick={() => void saveUserConfig()}
                            >
                              {t("common.save")}
                            </Button>
                            <Button
                              className="!min-h-[32px] px-3 text-xs"
                              disabled={loading}
                              variant="ghost"
                              onClick={cancelEditingUserConfig}
                            >
                              {t("common.cancel")}
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="rounded-lg border border-white/5 bg-ink-950/55 px-3 py-2 text-xs leading-5 text-slate-400">
                            {hasActiveUserConfig ? (
                              <div className="custom-scrollbar max-h-52 space-y-3 overflow-y-auto pr-1">
                                {activeUserConfig.prefix.trim() ? (
                                  <div>
                                    <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                                      {t("chat.userConfigPrefix")}
                                    </p>
                                    <p className="whitespace-pre-wrap">{activeUserConfig.prefix}</p>
                                  </div>
                                ) : null}
                                {activeUserConfig.prompt.trim() ? (
                                  <div>
                                    <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                                      {t("chat.userConfigPrompt")}
                                    </p>
                                    <p className="whitespace-pre-wrap">{activeUserConfig.prompt}</p>
                                  </div>
                                ) : null}
                                {activeUserConfig.suffix.trim() ? (
                                  <div>
                                    <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                                      {t("chat.userConfigSuffix")}
                                    </p>
                                    <p className="whitespace-pre-wrap">{activeUserConfig.suffix}</p>
                                  </div>
                                ) : null}
                              </div>
                            ) : (
                              <p>{t("chat.userConfigEmpty")}</p>
                            )}
                          </div>
                          <div className="mt-2 flex gap-2">
                            <Button
                              className="flex-1 !min-h-[32px] text-xs"
                              disabled={loading}
                              variant="secondary"
                              onClick={startEditingUserConfig}
                            >
                              {t("chat.editUserConfig")}
                            </Button>
                            {hasActiveUserConfig ? (
                              <Button
                                className="!min-h-[32px] px-3 text-xs"
                                disabled={loading}
                                variant="danger"
                                onClick={() => void clearUserConfig()}
                              >
                                {t("chat.clearUserConfig")}
                              </Button>
                            ) : null}
                          </div>
                        </>
                      )}
                    </div>
                    <div className="border-t border-white/10 pt-3">
                      <div className="mb-2">
                        <p className="text-sm font-semibold text-slate-100">
                          {t("chat.userProfileTitle")}
                        </p>
                        <p className="mt-1 text-xs leading-5 text-slate-400">
                          {t("chat.userProfileHelp")}
                        </p>
                      </div>
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <p className="text-sm font-semibold text-slate-100">
                          {t("chat.autoSummarizeUser")}
                        </p>
                        <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-slate-400">
                          <input
                            checked={autoSummarizeUser}
                            type="checkbox"
                            className="rounded border-white/20 bg-ink-950 text-ember-500 focus:ring-ember-500/50"
                            onChange={(event) => void updateAutoSummarizeUser(event.target.checked)}
                          />
                          {t("chat.autoSummarizeUser")}
                        </label>
                      </div>
                      {editingProfile ? (
                        <div ref={profileEditorRef} className="space-y-2">
                          <textarea
                            className="min-h-[100px] w-full min-w-0 resize-none rounded-lg border border-white/10 bg-ink-950/50 px-3 py-2.5 text-xs leading-5 text-slate-100 outline-none transition-all placeholder:text-slate-500 hover:border-white/20 focus:border-ember-500 focus:bg-ink-950 focus:ring-1 focus:ring-ember-500/50"
                            value={editingProfileDraft}
                            onChange={(event) => setEditingProfileDraft(event.target.value)}
                          />
                          <div className="flex gap-2">
                            <Button
                              className="flex-1 !min-h-[32px] text-xs"
                              disabled={loading}
                              onClick={() => void saveUserProfileSummary()}
                            >
                              {t("common.save")}
                            </Button>
                            <Button
                              className="!min-h-[32px] px-3 text-xs"
                              disabled={loading}
                              variant="ghost"
                              onClick={cancelEditingProfile}
                            >
                              {t("common.cancel")}
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="rounded-lg border border-white/5 bg-ink-950/55 px-3 py-2 text-xs leading-5 text-slate-400">
                            {activeChat?.userProfileSummary?.trim() ? (
                              <p className="custom-scrollbar max-h-28 overflow-y-auto whitespace-pre-wrap pr-1">
                                {activeChat.userProfileSummary}
                              </p>
                            ) : (
                              <p>{t("chat.userProfileEmpty")}</p>
                            )}
                            {activeChat?.userProfileUpdatedAt ? (
                              <p className="mt-2 text-[11px] text-slate-500">
                                {t("chat.userProfileUpdated")}
                              </p>
                            ) : null}
                          </div>
                          <div className="mt-2 flex gap-2">
                            <Button
                              className="flex-1 !min-h-[32px] text-xs"
                              disabled={loading}
                              variant="secondary"
                              onClick={startEditingProfile}
                            >
                              {t("chat.editUserProfile")}
                            </Button>
                            {activeChat?.userProfileSummary?.trim() ? (
                              <Button
                                className="!min-h-[32px] px-3 text-xs"
                                disabled={loading}
                                variant="danger"
                                onClick={() => void clearUserProfileSummary()}
                              >
                                {t("chat.clearUserProfile")}
                              </Button>
                            ) : null}
                          </div>
                        </>
                      )}
                    </div>
                    <Button className="w-full !min-h-[34px]" disabled={loading} onClick={() => void updateMemory()}>
                      {t("common.save")}
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null
        }
      >
        {!activeChat ? (
          <EmptyState>{t("chat.selectOrCreate")}</EmptyState>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="mb-5 flex shrink-0 flex-wrap items-center gap-2 border-b border-white/5 pb-5">
              {activeChat.characterIds.map((id) => (
                <Badge key={id}>{characterMap.get(id)?.name ?? t("common.unknown")}</Badge>
              ))}
            </div>

            <div
              ref={messageViewportRef}
              data-testid="chat-message-viewport"
              className="custom-scrollbar min-h-[320px] h-[min(62dvh,42rem)] overflow-y-auto overscroll-contain scroll-smooth rounded-2xl border border-white/5 bg-ink-950/30 p-5 space-y-7 xl:h-0 xl:min-h-0 xl:flex-1"
            >
              {activeChat.messages.length > MESSAGES_PER_PAGE ? (
                <div
                  data-testid="chat-message-pagination"
                  className="sticky top-0 z-10 -mx-5 -mt-5 mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-white/5 bg-ink-900/90 px-5 pb-3 pt-5 backdrop-blur-md"
                >
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-slate-200">{paginationCopy.page}</p>
                    <p className="mt-1 text-[11px] text-slate-500">{paginationCopy.range}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      className="!min-h-[32px] !px-3 text-xs"
                      data-testid="chat-page-prev"
                      disabled={safeMessagePage <= 1}
                      variant="secondary"
                      onClick={() => setMessagePage((current) => Math.max(1, current - 1))}
                    >
                      <ChevronLeft size={14} />
                      {paginationCopy.previous}
                    </Button>
                    <Button
                      className="!min-h-[32px] !px-3 text-xs"
                      data-testid="chat-page-next"
                      disabled={safeMessagePage >= totalMessagePages}
                      variant="secondary"
                      onClick={() => setMessagePage((current) => Math.min(totalMessagePages, current + 1))}
                    >
                      {safeMessagePage >= totalMessagePages ? paginationCopy.newest : paginationCopy.next}
                      <ChevronRight size={14} />
                    </Button>
                  </div>
                </div>
              ) : null}
              {activeChat.messages.length === 0 ? (
                <div className="h-full flex items-center justify-center">
                  <EmptyState>{t("chat.noMessages")}</EmptyState>
                </div>
              ) : (
                pagedMessages.map((message) => {
                  const isUser = message.role === "user";
                  const isSystem = message.role === "system";
                  const character = message.characterId ? characterMap.get(message.characterId) : undefined;
                  if (isSystem) {
                    return <SystemNotification key={message.id} content={message.content} />;
                  }

                  if (isUser) {
                    return (
                      <UserMessageBubble
                        key={message.id}
                        message={message}
                        showAvatar={showMessageAvatars}
                        onCopy={() => void copyMessage(message)}
                        onEdit={() => startEditingMessage(message)}
                        onDelete={() => setPendingDeleteMessage(message)}
                      />
                    );
                  }

                  return (
                    <AssistantMessageBubble
                      key={message.id}
                      message={message}
                      avatar={character?.avatar}
                      showAvatar={showMessageAvatars}
                      htmlCss={character?.htmlCss}
                      tokenUsageFormatter={formatTokenUsage}
                      triggeredLorebooks={getTriggeredLorebooks(message)}
                      onCopy={() => void copyMessage(message)}
                      onRegenerate={() => void regenerateMessage(message)}
                      onEdit={() => startEditingMessage(message)}
                      onDelete={() => setPendingDeleteMessage(message)}
                      onVariantPrev={() => void switchVariant(message, -1)}
                      onVariantNext={() => void switchVariant(message, 1)}
                      disableRegenerate={Boolean(activeRequestId)}
                    />
                  );
                })
              )}
              {activeRequestId && streamingCharacterId && safeMessagePage >= totalMessagePages ? (
                <StreamingBubble
                  key="streaming"
                  characterAvatar={
                    streamingCharacterId ? characterMap.get(streamingCharacterId)?.avatar : null
                  }
                  showAvatar={showMessageAvatars}
                  htmlCss={
                    streamingCharacterId ? characterMap.get(streamingCharacterId)?.htmlCss : undefined
                  }
                  content={streamingContent}
                />
              ) : null}
            </div>

            <div className="sticky bottom-3 mt-4 grid min-w-0 shrink-0 grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-xl border border-white/5 bg-ink-950/95 p-2 shadow-xl shadow-black/30 backdrop-blur-sm xl:static xl:bg-ink-950/40 xl:shadow-none">
              <TextInput
                className="min-w-0 border-0 bg-transparent focus:bg-transparent focus:ring-0"
                placeholder={t("chat.writeMessage")}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void sendMessage();
                  }
                }}
              />
              {activeRequestId ? (
                <Button className="!min-h-[38px]" variant="danger" onClick={stopGeneration}><StopCircle size={16} />{t("chat.stop")}</Button>
              ) : (
                <Button className="!min-h-[38px]" disabled={loading || !draft.trim()} onClick={() => void sendMessage()}><Send size={16} />{t("chat.send")}</Button>
              )}
            </div>
          </div>
        )}
      </Panel>
      </div>

      <div
        className={
          mobilePane === "create"
            ? "block min-w-0 xl:h-full xl:min-h-0"
            : "hidden min-w-0 xl:block xl:h-full xl:min-h-0"
        }
      >
      <Panel
        title={t("chat.createChat")}
        action={<MessageSquarePlus size={16} className="text-slate-400" />}
      >
        <div className="space-y-5">
          <Field label={t("chat.title")}><TextInput value={title} onChange={(event) => setTitle(event.target.value)} /></Field>
          <div className="space-y-3">
            <p className="text-sm font-medium text-slate-300">{t("nav.characters")}</p>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size={16} />
              <TextInput
                className="pl-9"
                placeholder={t("characters.searchPlaceholder")}
                value={createCharacterSearch}
                onChange={(event) => {
                  setCreateCharacterSearch(event.target.value);
                  setCreateCharacterPage(1);
                }}
              />
            </div>
            {selectedCreateCharacter && !createCharacters.some((character) => character.id === selectedCreateCharacter.id) ? (
              <label
                className="grid min-h-[72px] cursor-pointer grid-cols-[auto_40px_minmax(0,1fr)] items-center gap-3 rounded-xl border border-ember-500/30 bg-ember-500/5 px-3 py-2.5 text-sm transition-all duration-200 hover:bg-white/10"
              >
                <input checked type="radio" name="character-select" onChange={() => toggleCharacter(selectedCreateCharacter)} className="rounded-full border-white/20 bg-ink-950 text-ember-500 focus:ring-ember-500/50" />
                <span className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-lg border border-ember-400/40 bg-ember-500/10 text-xs font-semibold text-ember-100">
                  {selectedCreateCharacter.avatar ? (
                    <img alt="" className="h-full w-full object-cover" src={selectedCreateCharacter.avatar} />
                  ) : (
                    getCharacterInitials(selectedCreateCharacter.name)
                  )}
                </span>
                <span className="min-w-0 truncate text-[13px] font-medium leading-5 text-ember-100">
                  {selectedCreateCharacter.name}
                </span>
              </label>
            ) : null}
            {createCharacters.length === 0 && createCharacterPagination.total === 0 && !createCharacterSearch.trim() ? (
              <EmptyState>{t("chat.createCharactersFirst")}</EmptyState>
            ) : createCharacters.length === 0 ? (
              <EmptyState>{t("characters.noSearchResults")}</EmptyState>
            ) : (
              <div className="custom-scrollbar max-h-[420px] space-y-2.5 overflow-y-auto pr-1">
                {createCharacters.map((character) => (
                  <label
                    className={`grid min-h-[72px] cursor-pointer grid-cols-[auto_40px_minmax(0,1fr)] items-center gap-3 rounded-xl border px-3 py-2.5 text-sm transition-all duration-200 hover:bg-white/10 ${
                      characterIds.includes(character.id)
                        ? "border-ember-500/30 bg-ember-500/5"
                        : "border-white/5 bg-white/5"
                    }`}
                    key={character.id}
                  >
                    <input checked={characterIds.includes(character.id)} type="radio" name="character-select" onChange={() => toggleCharacter(character)} className="rounded-full border-white/20 bg-ink-950 text-ember-500 focus:ring-ember-500/50" />
                    <span className={`grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-lg border text-xs font-semibold ${
                      characterIds.includes(character.id)
                        ? "border-ember-400/40 bg-ember-500/10 text-ember-100"
                        : "border-white/10 bg-ink-800 text-slate-200"
                    }`}>
                      {character.avatar ? (
                        <img alt="" className="h-full w-full object-cover" src={character.avatar} />
                      ) : (
                        getCharacterInitials(character.name)
                      )}
                    </span>
                    <span
                      className={`min-w-0 truncate text-[13px] leading-5 ${
                        characterIds.includes(character.id) ? "font-medium text-ember-100" : "text-slate-200"
                      }`}
                    >
                      {character.name}
                    </span>
                  </label>
                ))}
              </div>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/5 pt-3 text-xs text-slate-400">
              <span>{createCharacterPaginationCopy}</span>
              <div className="flex items-center gap-2">
                <Button
                  className="!min-h-[32px] !px-3 text-xs"
                  data-testid="create-chat-character-page-prev"
                  disabled={loading || createCharacterPagination.page <= 1}
                  variant="secondary"
                  onClick={() => setCreateCharacterPage((current) => Math.max(1, current - 1))}
                >
                  <ChevronLeft size={14} />
                  {language === "zh-CN" ? "上一页" : "Previous"}
                </Button>
                <Button
                  className="!min-h-[32px] !px-3 text-xs"
                  data-testid="create-chat-character-page-next"
                  disabled={loading || createCharacterPagination.page >= createCharacterPagination.totalPages}
                  variant="secondary"
                  onClick={() => setCreateCharacterPage((current) => Math.min(createCharacterPagination.totalPages, current + 1))}
                >
                  {language === "zh-CN" ? "下一页" : "Next"}
                  <ChevronRight size={14} />
                </Button>
              </div>
            </div>
          </div>
          <Button disabled={loading || !title.trim() || characterIds.length === 0} onClick={() => void createChat()} className="w-full">
            <MessageSquarePlus size={16} />
            {t("chat.createChat")}
          </Button>
        </div>
      </Panel>
      </div>
    </div>
    {editingMessage ? (
      <div className="animate-fade-in fixed inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-sm p-4">
        <section
          aria-labelledby="edit-message-title"
          className="animate-scale-in w-full max-w-2xl rounded-2xl border border-white/10 bg-ink-900 p-6 shadow-2xl shadow-black/50"
          role="dialog"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-lg font-semibold tracking-tight text-slate-100" id="edit-message-title">
                {t("chat.editMessageTitle")}
              </h3>
              <p className="mt-1 text-sm text-slate-400">{t("chat.editMessageHelp")}</p>
            </div>
            <button
              aria-label={t("common.cancel")}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white/5 text-slate-400 transition-colors hover:bg-white/10 hover:text-slate-200"
              type="button"
              onClick={cancelEditingMessage}
            >
              <X size={18} />
            </button>
          </div>

          <div className="mt-6">
            <TextArea
              autoFocus
              className="min-h-[200px] text-base leading-relaxed"
              placeholder={t("chat.editMessagePlaceholder")}
              value={editDraft}
            onChange={(event) => setEditDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                cancelEditingMessage();
              }

              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                void saveEditedMessage();
              }
            }}
          />
          </div>

          <div className="mt-6 flex flex-wrap justify-end gap-3 pt-4 border-t border-white/5">
            <Button disabled={loading} variant="ghost" onClick={cancelEditingMessage}>
              <X size={16} />
              {t("common.cancel")}
            </Button>
            <Button disabled={loading || !editDraft.trim()} onClick={() => void saveEditedMessage()}>
              <Check size={16} />
              {t("chat.saveEdit")}
            </Button>
          </div>
        </section>
      </div>
    ) : null}
    {pendingDeleteChat ? (
      <ConfirmDialog
        cancelLabel={t("common.cancel")}
        confirmLabel={t("common.delete")}
        loading={loading}
        message={t("chat.deleteChatConfirm", { title: pendingDeleteChat.title })}
        title={t("chat.deleteChatTitle")}
        onCancel={() => setPendingDeleteChat(null)}
        onConfirm={() => void deleteChat()}
      />
    ) : null}
    {pendingDeleteMessage ? (
      <ConfirmDialog
        cancelLabel={t("common.cancel")}
        confirmLabel={t("common.delete")}
        loading={loading}
        message={t("chat.deleteMessageConfirm")}
        title={t("chat.deleteMessageTitle")}
        onCancel={() => setPendingDeleteMessage(null)}
        onConfirm={() => void deleteMessage()}
      />
    ) : null}
    </>
  );
}
