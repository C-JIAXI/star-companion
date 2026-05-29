import {
  ArrowDown,
  BrainCircuit,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Check,
  FileText,
  Send,
  Settings,
  Sparkles,
  StopCircle,
  User,
  X
} from "lucide-react";
import {
  emptyUserCustomConfig,
  parseUserCustomConfig,
  serializeUserCustomConfig,
  type UserCustomConfigDTO
} from "@local-roleplay/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorNotice,
  Modal,
  Panel,
  SuccessNotice,
  TextArea,
  TextInput
} from "../components/ui";
import {
  AssistantMessageBubble,
  ErrorBubble,
  StreamingBubble,
  SystemNotification,
  UserMessageBubble
} from "../components/messages";
import { MarkdownEditor } from "../components/MarkdownEditor";
import { DebugPromptDrawer } from "../components/DebugPromptDrawer";

const MESSAGES_PER_PAGE = 30;

export function ChatPage({
  selectedChatId,
  onChatsChanged
}: {
  selectedChatId: string | null;
  onChatsChanged: () => void;
}) {
  const { language, t } = useI18n();
  const showMessageAvatars = useAppStore((state) => state.showMessageAvatars);
  const [characters, setCharacters] = useState<CharacterDTO[]>([]);
  const [activeChat, setActiveChat] = useState<ChatWithMessagesDTO | null>(null);
  const [draft, setDraft] = useState("");
  const [streamingContent, setStreamingContent] = useState("");
  const [streamingCharacterId, setStreamingCharacterId] = useState<string | null>(null);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [editingMessage, setEditingMessage] = useState<MessageDTO | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [memorySettingsOpen, setMemorySettingsOpen] = useState(false);
  const [memoryDraft, setMemoryDraft] = useState("12");
  const memorySettingsRef = useRef<HTMLDivElement | null>(null);

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
  const [showUserConfigDialog, setShowUserConfigDialog] = useState(false);
  const [showUserProfileDialog, setShowUserProfileDialog] = useState(false);
  const [showModelDialog, setShowModelDialog] = useState(false);
  const [showMemoryDialog, setShowMemoryDialog] = useState(false);
  const [debugMessage, setDebugMessage] = useState<MessageDTO | null>(null);
  const [quickRepliesOpen, setQuickRepliesOpen] = useState(() => {
    try {
      return localStorage.getItem("chat.quickRepliesOpen") !== "false";
    } catch {
      return true;
    }
  });
  const toggleQuickReplies = useCallback(() => {
    setQuickRepliesOpen((prev) => {
      try {
        localStorage.setItem("chat.quickRepliesOpen", String(!prev));
      } catch {}
      return !prev;
    });
  }, []);
  const [editingPersonaDraft, setEditingPersonaDraft] = useState<UserCustomConfigDTO>(
    () => emptyUserCustomConfig()
  );
  const [editingProfileDraft, setEditingProfileDraft] = useState("");
  const [pendingDeleteMessage, setPendingDeleteMessage] = useState<MessageDTO | null>(null);
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const [messagePage, setMessagePage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const streamingBufferRef = useRef("");
  const draftTextAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const messageViewportRef = useRef<HTMLDivElement | null>(null);
  const paginationStateRef = useRef<{ chatId: string | null; totalPages: number }>({
    chatId: null,
    totalPages: 1
  });

  const autoResizeDraftTextArea = () => {
    const el = draftTextAreaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  useEffect(() => {
    autoResizeDraftTextArea();
  }, [draft]);

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
    setActiveChat((current) =>
      current && current.id === updated.id
        ? {
            ...current,
            ...updated
          }
        : current
    );
    onChatsChanged();
  };

  const commitTitleRename = async () => {
    if (!activeChat) {
      return;
    }
    const trimmed = titleDraft.trim();
    setTitleEditing(false);
    if (!trimmed || trimmed === activeChat.title) {
      return;
    }
    try {
      const updated = await api.chats.update(activeChat.id, { title: trimmed });
      applyChatUpdate(updated);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedUpdate"));
    }
  };

  const onMessageHandlersRef = useRef<{
    upsertMessage: (message: MessageDTO) => void;
    setStreamingContent: (value: React.SetStateAction<string>) => void;
    chatsChanged: () => void;
  }>({ upsertMessage: () => {}, setStreamingContent: () => {}, chatsChanged: () => {} });

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
        setGenerationError(null);
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
        handlers.chatsChanged();
        return;
      }

      if (msg.type === "error") {
        setError(msg.error);
        setGenerationError(msg.error);
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
      setStreamingContent,
      chatsChanged: onChatsChanged
    };
  }, [upsertMessage, setStreamingContent, onChatsChanged]);

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

  const activeQuickReplies = useMemo(() => {
    if (!activeChat) {
      return [];
    }
    const characterId = activeChat.characterIds[0];
    if (!characterId) {
      return [];
    }
    const character = characterMap.get(characterId);
    return character?.quickReplies ?? [];
  }, [activeChat, characterMap]);

  const mergeCharacterCache = (nextCharacters: CharacterDTO[]) => {
    setCharacters((current) => {
      const byId = new Map(current.map((character) => [character.id, character]));
      for (const character of nextCharacters) {
        byId.set(character.id, character);
      }
      return Array.from(byId.values());
    });
  };

  const scrollToBottom = useCallback(() => {
    const viewport = messageViewportRef.current;
    if (viewport) {
      viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
    }
  }, []);

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

  const loadSettings = async () => {
    const settings = await api.settings.get();
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
  };

  const loadChat = async (id: string | null) => {
    if (!id) {
      setActiveChat(null);
      setGenerationError(null);
      return;
    }
    const chat = await api.chats.get(id);
    setActiveChat(chat);
    setGenerationError(null);
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
    void loadSettings().catch((caught: unknown) =>
      setError(caught instanceof Error ? caught.message : t("chat.failedLoad"))
    );
  }, [t]);

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

  useEffect(() => {
    const viewport = messageViewportRef.current;
    if (!viewport) {
      return;
    }

    const THRESHOLD = 120;

    const check = () => {
      const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      setIsNearBottom(distance <= THRESHOLD);
    };

    check();
    viewport.addEventListener("scroll", check, { passive: true });
    return () => viewport.removeEventListener("scroll", check);
  }, [activeChat?.id]);

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

  const handleMemorySettingsPointerDownCapture = (_event: React.PointerEvent<HTMLDivElement>) => {
    // no-op: editing now uses modal dialogs
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
      setShowUserConfigDialog(false);
      setStatus(t("chat.userConfigSaved"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedUpdateUserConfig"));
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
      setShowUserProfileDialog(false);
      setStatus(t("chat.userProfileSaved"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedUpdateUserProfile"));
    } finally {
      setLoading(false);
    }
  };

  const startEditingUserConfig = () => {
    setEditingPersonaDraft(parseUserCustomConfig(activeChat?.userPersona));
    setShowUserConfigDialog(true);
    setMemorySettingsOpen(false);
  };

  const cancelEditingUserConfig = () => {
    setShowUserConfigDialog(false);
    setEditingPersonaDraft(emptyUserCustomConfig());
  };

  const startEditingProfile = () => {
    setEditingProfileDraft(activeChat?.userProfileSummary ?? "");
    setShowUserProfileDialog(true);
    setMemorySettingsOpen(false);
  };

  const cancelEditingProfile = () => {
    setShowUserProfileDialog(false);
    setEditingProfileDraft("");
  };

  const openModelDialog = () => {
    setShowModelDialog(true);
    setMemorySettingsOpen(false);
  };

  const closeModelDialog = () => {
    setShowModelDialog(false);
  };

  const openMemoryDialog = () => {
    setMemoryDraft(String(activeChat?.memoryTurns ?? 12));
    setShowMemoryDialog(true);
    setMemorySettingsOpen(false);
  };

  const closeMemoryDialog = () => {
    setShowMemoryDialog(false);
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
      onChatsChanged();
      setMemorySettingsOpen(false);
      setShowMemoryDialog(false);
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
      requestAnimationFrame(() => {
        if (draftTextAreaRef.current) {
          draftTextAreaRef.current.style.height = "auto";
        }
      });
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

  const resendMessage = async (message: MessageDTO) => {
    if (!activeChat) {
      return;
    }

    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      if (!isConnected) {
        throw new Error(t("chat.websocketFailed"));
      }

      const messages = activeChat.messages;
      const targetIndex = messages.findIndex((m) => m.id === message.id);
      if (targetIndex >= 0) {
        const toDeleteIds = new Set(messages.slice(targetIndex).map((m) => m.id));
        setActiveChat((current) =>
          current && current.id === activeChat.id
            ? { ...current, messages: current.messages.filter((m) => !toDeleteIds.has(m.id)) }
            : current
        );
      }

      const requestId = generateId();
      const payload: GenerationClientMessage = {
        type: "resend",
        requestId,
        messageId: message.id
      };
      setActiveRequestId(requestId);
      setStreamingContent("");
      setStreamingCharacterId(null);
      streamingBufferRef.current = "";
      setIsNearBottom(true);
      sendWs(payload);
      requestAnimationFrame(() => scrollToBottom());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedSend"));
      setLoading(false);
      setActiveRequestId(null);
    }
  };

  const retryGeneration = () => {
    if (!activeChat || activeChat.messages.length === 0) {
      setGenerationError(null);
      return;
    }
    const lastMessage = activeChat.messages[activeChat.messages.length - 1];
    setGenerationError(null);
    if (lastMessage.role === "user") {
      void resendMessage(lastMessage);
    } else if (lastMessage.role === "assistant") {
      void regenerateMessage(lastMessage);
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

    const messages = activeChat?.messages ?? [];
    const targetIndex = messages.findIndex((m) => m.id === pendingDeleteMessage.id);
    const isUser = pendingDeleteMessage.role === "user";

    if (isUser && targetIndex >= 0) {
      const toDelete = messages.slice(targetIndex);
      await Promise.all(toDelete.map((m) => api.messages.remove(m.id)));
    } else {
      await api.messages.remove(pendingDeleteMessage.id);
    }

    await loadChat(pendingDeleteMessage.chatId);
    setPendingDeleteMessage(null);
    setIsNearBottom(true);
    requestAnimationFrame(() => scrollToBottom());
  };

  return (
    <>
    <div className="flex flex-col h-full min-h-0 min-w-0">

      <Panel
        className="flex flex-col h-full min-h-0 min-w-0"
        title={
          titleEditing && activeChat ? (
            <input
              ref={titleInputRef}
              className="chat-input w-full rounded bg-transparent px-1 py-0.5 text-sm font-semibold tracking-wide text-slate-100 outline-none border-none focus:outline-none focus:ring-0"
              style={{ WebkitUserSelect: "none", userSelect: "none" }}
              value={titleDraft}
              onChange={(event) => setTitleDraft(event.target.value)}
              onBlur={() => void commitTitleRename()}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void commitTitleRename();
                }
                if (event.key === "Escape") {
                  setTitleEditing(false);
                }
              }}
            />
          ) : (
            <span
              className="cursor-pointer rounded px-1 py-0.5 hover:bg-white/5 outline-none focus:outline-none focus:ring-0"
              style={{ WebkitUserSelect: "none", userSelect: "none" }}
              title={t("chat.renameHint")}
              onClick={() => {
                if (!activeChat) {
                  return;
                }
                setTitleDraft(activeChat.title);
                setTitleEditing(true);
                setTimeout(() => titleInputRef.current?.focus(), 0);
              }}
            >
              {activeChat?.title ?? t("chat.messageStream")}
            </span>
          )
        }
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
                  className="custom-scrollbar absolute right-0 top-10 z-20 max-h-80 w-56 overflow-y-auto rounded-xl border border-white/10 bg-ink-900/95 p-3 shadow-xl shadow-black/30 backdrop-blur-md sm:max-h-[calc(100dvh-22rem)]"
                  onPointerDownCapture={handleMemorySettingsPointerDownCapture}
                >
                  {settingsModels.length > 0 ? (
                    <div className="mb-2 border-b border-white/10 pb-2">
                      <button
                        className="flex min-h-[36px] w-full items-center justify-between text-sm font-semibold text-slate-100 transition-colors hover:text-ember-200 active:text-ember-300"
                        type="button"
                        onClick={openModelDialog}
                      >
                        <span>{t("chat.modelSwitchTitle")}</span>
                        <Sparkles size={14} className="text-slate-400" />
                      </button>
                    </div>
                  ) : null}

                  <div className="border-b border-white/10 pb-2">
                    <button
                      className="flex min-h-[36px] w-full items-center justify-between text-sm font-semibold text-slate-100 transition-colors hover:text-ember-200 active:text-ember-300"
                      type="button"
                      onClick={openMemoryDialog}
                    >
                      <span>{t("chat.memorySettings")}</span>
                      <BrainCircuit size={14} className="text-slate-400" />
                    </button>
                  </div>

                  <div className="border-b border-white/10 pb-2 pt-2">
                    <button
                      className="flex min-h-[36px] w-full items-center justify-between text-sm font-semibold text-slate-100 transition-colors hover:text-ember-200 active:text-ember-300"
                      type="button"
                      onClick={startEditingUserConfig}
                    >
                      <span>{t("chat.userConfigTitle")}</span>
                      <FileText size={14} className="text-slate-400" />
                    </button>
                  </div>

                  <div className="pt-2">
                    <button
                      className="flex min-h-[36px] w-full items-center justify-between text-sm font-semibold text-slate-100 transition-colors hover:text-ember-200 active:text-ember-300"
                      type="button"
                      onClick={startEditingProfile}
                    >
                      <span>{t("chat.userProfileTitle")}</span>
                      <User size={14} className="text-slate-400" />
                    </button>
                    <div className="mt-1.5 flex items-center justify-between gap-2">
                      <p className="text-xs font-semibold text-slate-100">
                        {t("chat.autoSummarizeUser")}
                      </p>
                      <label className="flex cursor-pointer items-center gap-1.5 text-xs font-medium text-slate-400">
                        <input
                          checked={autoSummarizeUser}
                          type="checkbox"
                          className="rounded border-white/20 bg-ink-950 text-ember-500 focus:ring-ember-500/50"
                          onChange={(event) => void updateAutoSummarizeUser(event.target.checked)}
                        />
                        {t("chat.autoSummarizeUser")}
                      </label>
                    </div>
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
            <ErrorNotice message={error} />
            <SuccessNotice message={status} />

            <div
              ref={messageViewportRef}
              data-testid="chat-message-viewport"
              className="custom-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-auto scroll-smooth"
            >
              <div className="mx-auto max-w-2xl space-y-4 rounded-2xl p-2 sm:space-y-7 sm:p-5">
              {activeChat.messages.length > MESSAGES_PER_PAGE ? (
                <div
                  data-testid="chat-message-pagination"
                  className="sticky top-0 z-10 -mx-2 -mt-2 mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-white/5 bg-ink-900/90 px-2 pb-3 pt-2 backdrop-blur-md sm:-mx-5 sm:-mt-5 sm:px-5 sm:pt-5"
                >
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-slate-200">{paginationCopy.page}</p>
                    <p className="mt-1 text-xs text-slate-500">{paginationCopy.range}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      className="!min-h-[48px] !px-3 text-xs"
                      data-testid="chat-page-prev"
                      disabled={safeMessagePage <= 1}
                      variant="secondary"
                      onClick={() => setMessagePage((current) => Math.max(1, current - 1))}
                    >
                      <ChevronLeft size={14} />
                      {paginationCopy.previous}
                    </Button>
                    <Button
                      className="!min-h-[48px] !px-3 text-xs"
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
                        onResend={() => void resendMessage(message)}
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
                      onDebug={setDebugMessage}
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
              {generationError && !activeRequestId && safeMessagePage >= totalMessagePages ? (
                <ErrorBubble
                  key="generation-error"
                  characterAvatar={
                    streamingCharacterId ? characterMap.get(streamingCharacterId)?.avatar : activeChat?.messages.length ? characterMap.get(activeChat.messages[activeChat.messages.length - 1].characterId ?? "")?.avatar : null
                  }
                  showAvatar={showMessageAvatars}
                  error={generationError}
                  onRetry={retryGeneration}
                  onDismiss={() => setGenerationError(null)}
                />
              ) : null}
              </div>
              {!isNearBottom ? (
                <button
                  type="button"
                  className="sticky bottom-3 z-20 mx-auto flex items-center gap-1.5 rounded-full border border-white/10 bg-ink-900/90 px-3 py-1.5 text-xs font-medium text-slate-300 shadow-lg shadow-black/30 backdrop-blur-sm transition-colors hover:bg-ink-800 hover:text-slate-100"
                  style={{ display: "flex", width: "fit-content", marginLeft: "auto", marginRight: "auto" }}
                  onClick={scrollToBottom}
                >
                  <ArrowDown size={14} />
                  {t("chat.scrollToBottom")}
                </button>
              ) : null}
            </div>

            <div className="shrink-0">
              {activeQuickReplies.length > 0 ? (
                <div className="max-w-2xl mx-auto mb-1 px-1">
                  <button
                    type="button"
                    className="inline-flex h-6 items-center gap-1 text-xs font-medium text-slate-500 transition-colors hover:text-slate-300 active:text-slate-200"
                    onClick={toggleQuickReplies}
                  >
                    <ChevronDown
                      size={12}
                      className={`transition-transform duration-200 ${quickRepliesOpen ? "" : "-rotate-90"}`}
                    />
                    {t("chat.quickReplies")}
                  </button>
                  <div
                    className="overflow-hidden"
                    style={{
                      maxHeight: quickRepliesOpen ? "200px" : "0px",
                      opacity: quickRepliesOpen ? 1 : 0,
                      transition: "max-height 300ms ease-out, opacity 300ms ease-out"
                    }}
                  >
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      {activeQuickReplies.map((qr) => (
                        <button
                          key={qr.id}
                          type="button"
                          className="inline-flex h-7 items-center gap-1 rounded-md border border-white/10 bg-ink-950/80 px-2 text-xs font-medium text-slate-300 transition-colors hover:border-ember-500/40 hover:bg-ink-900 hover:text-slate-100 active:bg-ink-800"
                          onClick={() => setDraft((current) => current ? `${current}\n${qr.content}` : qr.content)}
                        >
                          {qr.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}
              <div className="max-w-2xl mx-auto rounded-xl border border-white/5 bg-ink-950/95 p-1.5 sm:p-2 shadow-xl shadow-black/30 backdrop-blur-sm xl:bg-ink-950/40 xl:shadow-none">
              <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-end gap-1.5 sm:gap-2">
              <TextArea
                ref={draftTextAreaRef}
                className="chat-input !h-10 max-h-[200px] !resize-none border-0 bg-transparent !px-2 !py-[11px] !text-sm leading-[1.4] focus:bg-transparent focus:ring-0 sm:!h-11 sm:!py-3"
                style={{ height: "auto" }}
                placeholder={t("chat.writeMessage")}
                rows={1}
                value={draft}
                onInput={autoResizeDraftTextArea}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void sendMessage();
                  }
                }}
              />
              {activeRequestId ? (
                <Button className="!min-h-[40px] sm:!min-h-[44px]" variant="danger" onClick={stopGeneration}><StopCircle size={16} />{t("chat.stop")}</Button>
              ) : (
                <Button className="!min-h-[40px] sm:!min-h-[44px]" disabled={loading || !draft.trim()} onClick={() => void sendMessage()}><Send size={16} />{t("chat.send")}</Button>
              )}
              </div>
            </div>
            </div>
          </div>
        )}
      </Panel>
    </div>
    {editingMessage ? (
      <div className="animate-fade-in fixed inset-0 z-50 grid place-items-end sm:place-items-center bg-black/60 backdrop-blur-sm p-0 sm:p-4">
        <section
          aria-labelledby="edit-message-title"
          className="animate-scale-in w-full max-w-2xl rounded-t-2xl sm:rounded-2xl border border-white/10 bg-ink-900 p-6 shadow-2xl shadow-black/50 safe-area-bottom max-h-[90vh] sm:max-h-[85vh] overflow-y-auto"
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
              className="grid h-[48px] w-[48px] shrink-0 place-items-center rounded-full bg-white/5 text-slate-400 transition-colors hover:bg-white/10 hover:text-slate-200"
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
    {showUserConfigDialog ? (
      <Modal title={t("chat.userConfigTitle")} onClose={cancelEditingUserConfig}>
        <div className="space-y-4">
          <p className="whitespace-pre-line break-words text-xs leading-5 text-slate-400">
            {t("chat.userConfigHelp")}
          </p>
          <div className="space-y-5">
            <div className="space-y-2">
              <p className="text-sm font-semibold text-slate-300">
                {t("chat.userConfigPrefix")}
              </p>
              <MarkdownEditor
                height={200}
                placeholder={t("chat.userConfigPrefixHelp")}
                value={editingPersonaDraft.prefix}
                onChange={(nextValue) => updateUserConfigDraft("prefix", nextValue)}
              />
            </div>
            <div className="space-y-2">
              <p className="text-sm font-semibold text-slate-300">
                {t("chat.userConfigPrompt")}
              </p>
              <MarkdownEditor
                height={200}
                placeholder={t("chat.userConfigPromptHelp")}
                value={editingPersonaDraft.prompt}
                onChange={(nextValue) => updateUserConfigDraft("prompt", nextValue)}
              />
            </div>
            <div className="space-y-2">
              <p className="text-sm font-semibold text-slate-300">
                {t("chat.userConfigSuffix")}
              </p>
              <MarkdownEditor
                height={200}
                placeholder={t("chat.userConfigSuffixHelp")}
                value={editingPersonaDraft.suffix}
                onChange={(nextValue) => updateUserConfigDraft("suffix", nextValue)}
              />
            </div>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <Button
              className="!min-h-[36px]"
              disabled={loading}
              variant="ghost"
              onClick={cancelEditingUserConfig}
            >
              {t("common.cancel")}
            </Button>
            <Button
              className="!min-h-[36px]"
              disabled={loading}
              onClick={() => void saveUserConfig()}
            >
              {t("common.save")}
            </Button>
          </div>
        </div>
      </Modal>
    ) : null}
    {showUserProfileDialog ? (
      <Modal title={t("chat.userProfileTitle")} onClose={cancelEditingProfile}>
        <div className="space-y-4">
          <p className="whitespace-pre-line break-words text-xs leading-5 text-slate-400">
            {t("chat.userProfileHelp")}
          </p>
          <MarkdownEditor
            height={300}
            value={editingProfileDraft}
            onChange={(nextValue) => setEditingProfileDraft(nextValue)}
          />
          <div className="flex justify-end gap-3">
            <Button
              className="!min-h-[36px]"
              disabled={loading}
              variant="ghost"
              onClick={cancelEditingProfile}
            >
              {t("common.cancel")}
            </Button>
            <Button
              className="!min-h-[36px]"
              disabled={loading}
              onClick={() => void saveUserProfileSummary()}
            >
              {t("common.save")}
            </Button>
          </div>
        </div>
      </Modal>
    ) : null}
    {showModelDialog ? (
      <Modal title={t("chat.modelSwitchTitle")} onClose={closeModelDialog}>
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
              onClick={() => {
                void switchModel(model);
                closeModelDialog();
              }}
            >
              <Sparkles
                size={14}
                className={activeModelId === model.id ? "text-ember-300" : "text-slate-500"}
              />
              <span className="min-w-0 flex-1 truncate font-medium">
                {model.label || model.model}
              </span>
              <span className="ml-auto shrink-0 text-xs font-medium text-slate-500">
                {model.provider}
              </span>
            </button>
          ))}
        </div>
      </Modal>
    ) : null}
    {showMemoryDialog ? (
      <Modal title={t("chat.memorySettings")} onClose={closeMemoryDialog}>
        <div className="space-y-4">
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
          <p className="whitespace-pre-line break-words text-xs leading-5 text-slate-400">
            {t("chat.memoryHelp")}
          </p>
          <div className="flex justify-end gap-3">
            <Button
              className="!min-h-[36px]"
              disabled={loading}
              variant="ghost"
              onClick={closeMemoryDialog}
            >
              {t("common.cancel")}
            </Button>
            <Button
              className="!min-h-[36px]"
              disabled={loading}
              onClick={() => void updateMemory()}
            >
              {t("common.save")}
            </Button>
          </div>
        </div>
      </Modal>
    ) : null}
    <DebugPromptDrawer
      open={debugMessage !== null}
      onClose={() => setDebugMessage(null)}
      activeChat={activeChat}
      character={activeChat?.characterIds[0] ? characterMap.get(activeChat.characterIds[0]) : undefined}
      debugMessage={debugMessage}
    />
    </>
  );
}
