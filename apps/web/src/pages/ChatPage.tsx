import {
  ArrowDown,
  BrainCircuit,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Check,
  Download,
  FileText,
  Image,
  Plus,
  RefreshCw,
  Send,
  Settings,
  Sparkles,
  StopCircle,
  Trash2,
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
import { scopeCharacterChatUiCss } from "../lib/characterHtmlCss";
import { readFileAsDataUrl, saveTextFile } from "../lib/files";
import { generateId } from "../lib/uuid";
import { useWebSocket } from "../lib/useWebSocket";
import { useAppStore } from "../store/useAppStore";
import type {
  CharacterDTO,
  ChatMemoryDTO,
  ChatDTO,
  ChatWithMessagesDTO,
  GenerationClientMessage,
  GenerationServerMessage,
  MessageDTO,
  ProviderProfile,
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
const GENERATION_ERROR_PREFIX = "[GENERATION_FAILED] ";
const MAX_CHAT_BACKGROUND_FILE_SIZE = 2 * 1024 * 1024;
const CHAT_PAGE_STYLE_TAG = "chat-page-character-html-css";
const emptyMemoryForm = {
  title: "",
  content: "",
  keywords: "",
  importance: "3",
  enabled: true
};

const isSupportedChatBackgroundUrl = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) {
    return true;
  }

  if (/^data:image\/[a-zA-Z0-9.+-]+;base64,[a-zA-Z0-9+/=]+$/.test(trimmed)) {
    return true;
  }

  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

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
  const [chatMemories, setChatMemories] = useState<ChatMemoryDTO[]>([]);
  const [autoMemoryEnabled, setAutoMemoryEnabled] = useState(true);
  const [editingMemory, setEditingMemory] = useState<ChatMemoryDTO | "new" | null>(null);
  const [memoryForm, setMemoryForm] = useState(emptyMemoryForm);
  const [pendingDeleteMemory, setPendingDeleteMemory] = useState<ChatMemoryDTO | null>(null);
  const memorySettingsRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        memorySettingsOpen &&
        memorySettingsRef.current &&
        !memorySettingsRef.current.contains(event.target as Node)
      ) {
        setMemorySettingsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [memorySettingsOpen]);

  const [settingsProviders, setSettingsProviders] = useState<ProviderProfile[]>([]);
  const [activeProviderId, setActiveProviderId] = useState<string | null>(null);
  const [activeModelId, setActiveModelId] = useState<string | null>(null);
  const [expandedDialogProviderId, setExpandedDialogProviderId] = useState<string | null>(null);
  const [runtimeSettings, setRuntimeSettings] = useState<Pick<
    PublicUserSettingsDTO,
    "activeProvider" | "apiBaseUrl" | "model" | "temperature" | "maxTokens" | "topP" | "language"
  > | null>(null);
  const [autoSummarizeUser, setAutoSummarizeUser] = useState(true);
  const [showUserConfigDialog, setShowUserConfigDialog] = useState(false);
  const [showUserProfileDialog, setShowUserProfileDialog] = useState(false);
  const [showModelDialog, setShowModelDialog] = useState(false);
  const [modelSwitching, setModelSwitching] = useState(false);
  const [showMemoryDialog, setShowMemoryDialog] = useState(false);
  const [showBackgroundDialog, setShowBackgroundDialog] = useState(false);
  const [backgroundDraft, setBackgroundDraft] = useState("");
  const [backgroundInputValue, setBackgroundInputValue] = useState("");
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
  const [editingPersonaDraft, setEditingPersonaDraft] = useState<UserCustomConfigDTO>(() =>
    emptyUserCustomConfig()
  );
  const [editingProfileDraft, setEditingProfileDraft] = useState("");
  const [pendingDeleteMessage, setPendingDeleteMessage] = useState<MessageDTO | null>(null);
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const [messagePage, setMessagePage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const streamingBufferRef = useRef("");
  const draftTextAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const messageViewportRef = useRef<HTMLDivElement | null>(null);
  const backgroundFileInputRef = useRef<HTMLInputElement | null>(null);
  const paginationStateRef = useRef<{ chatId: string | null; totalPages: number }>({
    chatId: null,
    totalPages: 1
  });
  const hasMessagesRef = useRef(false);

  const autoResizeDraftTextArea = () => {
    const el = draftTextAreaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 19.6;
    const maxLines = 6;
    const maxHeight = lineHeight * maxLines;
    if (el.scrollHeight <= maxHeight) {
      el.style.height = `${el.scrollHeight}px`;
      el.style.overflowY = "hidden";
    } else {
      el.style.height = `${maxHeight}px`;
      el.style.overflowY = "auto";
    }
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
    setAutoMemoryEnabled(updated.autoMemoryEnabled);
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

  const {
    send: sendWs,
    connect,
    disconnect,
    isConnected
  } = useWebSocket({
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

      if (msg.type === "memory_matches") {
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
        handlers.chatsChanged();
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
    const timerId = window.setTimeout(() => {
      connect();
    }, 0);

    return () => {
      window.clearTimeout(timerId);
      disconnect();
    };
  }, [connect, disconnect]);

  const characterMap = useMemo(
    () => new Map(characters.map((character) => [character.id, character])),
    [characters]
  );

  const activeQuickReplies = useMemo(() => {
    if (!activeChat) {
      return [];
    }
    const characterId = activeChat.characterId;
    if (!characterId) {
      return [];
    }
    const character = characterMap.get(characterId);
    return character?.quickReplies ?? [];
  }, [activeChat, characterMap]);

  const activeOpeningHtml = useMemo(() => {
    if (!activeChat || activeChat.messages.length > 0 || hasMessagesRef.current) {
      return "";
    }
    const characterId = activeChat.characterId;
    if (!characterId) {
      return "";
    }
    const character = characterMap.get(characterId);
    return character?.openingHtml?.trim() ?? "";
  }, [activeChat, characterMap]);

  const activeCharacterHtmlCss = useMemo(() => {
    if (!activeChat?.characterId) {
      return "";
    }

    return characterMap.get(activeChat.characterId)?.htmlCss ?? "";
  }, [activeChat?.characterId, characterMap]);

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

  const backgroundCopy =
    language === "zh-CN"
      ? {
          button: "背景",
          title: "聊天背景",
          help: "为当前聊天单独设置背景图。支持 HTTPS 图片地址或上传本地图片（2 MB 以内）。",
          inputLabel: "背景图地址",
          inputPlaceholder: "粘贴图片地址；也可以直接上传本地图片",
          upload: "上传图片",
          clear: "清除背景",
          preview: "背景预览",
          empty: "当前聊天还没有设置背景。",
          uploaded: "已选择本地图片，保存后生效。",
          saved: "聊天背景已保存。",
          invalid: "请输入有效的图片地址，或上传图片文件。",
          tooLarge: "背景图片需小于 2 MB。",
          uploadFailed: "读取背景图片失败。"
        }
      : {
          button: "Background",
          title: "Chat Background",
          help: "Set a dedicated background image for this chat. Supports HTTPS image URLs or local uploads up to 2 MB.",
          inputLabel: "Background URL",
          inputPlaceholder: "Paste an image URL, or upload a local image instead",
          upload: "Upload Image",
          clear: "Clear Background",
          preview: "Preview",
          empty: "No background is set for this chat yet.",
          uploaded: "Local image selected. Save to apply it.",
          saved: "Chat background saved.",
          invalid: "Enter a valid image URL or upload an image file.",
          tooLarge: "Background image must be smaller than 2 MB.",
          uploadFailed: "Failed to read the selected image."
        };
  const activeBackgroundUrl = activeChat?.backgroundUrl.trim() ?? "";
  const usingUploadedBackground = backgroundDraft.startsWith("data:image/");

  const loadSettings = async () => {
    const settings = await api.settings.get();
    setSettingsProviders(settings.providers ?? []);
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
    setActiveProviderId(settings.activeProviderId || null);
    setActiveModelId(settings.activeModelId || null);
  };

  const loadChat = async (id: string | null) => {
    if (!id) {
      setActiveChat(null);
      hasMessagesRef.current = false;
      setChatMemories([]);
      return;
    }
    const chat = await api.chats.get(id);
    setActiveChat(chat);
    setChatMemories(chat.memories ?? []);
    setAutoMemoryEnabled(chat.autoMemoryEnabled);
    hasMessagesRef.current = chat.messages.length > 0;
    setMemoryDraft(String(chat.memoryTurns));

    const missingCharacterIds =
      chat.characterId && !characterMap.has(chat.characterId) ? [chat.characterId] : [];
    if (missingCharacterIds.length > 0) {
      const fetchedCharacters = await Promise.all(
        missingCharacterIds.map((characterId) => api.characters.get(characterId).catch(() => null))
      );
      mergeCharacterCache(
        fetchedCharacters.filter((character): character is CharacterDTO => character !== null)
      );

      if (fetchedCharacters.some((character) => character === null)) {
        setActiveChat((current) =>
          current && current.id === chat.id
            ? {
                ...current,
                characterId: null
              }
            : current
        );
      }
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
    const totalPages = Math.max(
      1,
      Math.ceil((activeChat?.messages.length ?? 0) / MESSAGES_PER_PAGE)
    );
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

  useEffect(() => {
    if (!status) {
      return;
    }

    const timeoutId = window.setTimeout(() => setStatus(null), 2200);
    return () => window.clearTimeout(timeoutId);
  }, [status]);

  useEffect(() => {
    const existing = document.head.querySelector<HTMLStyleElement>(
      `style[data-chat-style-tag="${CHAT_PAGE_STYLE_TAG}"]`
    );
    existing?.remove();

    const css = scopeCharacterChatUiCss(activeCharacterHtmlCss).trim();
    if (!css) {
      return;
    }

    const styleEl = document.createElement("style");
    styleEl.setAttribute("data-chat-style-tag", CHAT_PAGE_STYLE_TAG);
    styleEl.textContent = css;
    document.head.appendChild(styleEl);

    return () => {
      styleEl.remove();
    };
  }, [activeCharacterHtmlCss]);

  const openMemorySettings = () => {
    if (!activeChat) {
      return;
    }

    setMemoryDraft(String(activeChat.memoryTurns));
    setMemorySettingsOpen((current) => {
      if (!current) {
        void api.settings.get().then((settings) => {
          setSettingsProviders(settings.providers ?? []);
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
          setActiveProviderId(settings.activeProviderId || null);
          setActiveModelId(settings.activeModelId || null);
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

  const exportCurrentChat = async () => {
    if (!activeChat) return;
    try {
      const lines = activeChat.messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => `${m.role === "user" ? "用户" : "AI"}：${m.content}`);
      const safeName = activeChat.title.replace(/[^\w一-鿿-]/g, "_").slice(0, 50);
      const date = new Date().toISOString().slice(0, 10);
      await saveTextFile(`chat-${safeName}-${date}.txt`, lines.join("\n"));
      setStatus(t("chat.exportChatSuccess"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedExportChat"));
    }
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
    const initialProviderId =
      settingsProviders.find((provider) => provider.id === activeProviderId)?.id ??
      settingsProviders[0]?.id ??
      null;
    setExpandedDialogProviderId(initialProviderId);
    setShowModelDialog(true);
    setMemorySettingsOpen(false);
  };

  const closeModelDialog = () => {
    setShowModelDialog(false);
  };

  const loadChatMemories = async () => {
    if (!activeChat) {
      return;
    }

    try {
      const memories = await api.chats.memories.list(activeChat.id);
      setChatMemories(memories);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedLoadMemories"));
    }
  };

  const openMemoryDialog = () => {
    setMemoryDraft(String(activeChat?.memoryTurns ?? 12));
    setAutoMemoryEnabled(activeChat?.autoMemoryEnabled ?? true);
    setEditingMemory(null);
    setMemoryForm(emptyMemoryForm);
    setShowMemoryDialog(true);
    setMemorySettingsOpen(false);
    void loadChatMemories();
  };

  const closeMemoryDialog = () => {
    setShowMemoryDialog(false);
    setEditingMemory(null);
    setMemoryForm(emptyMemoryForm);
  };

  const openBackgroundDialog = () => {
    const currentBackgroundUrl = activeChat?.backgroundUrl ?? "";
    setBackgroundDraft(currentBackgroundUrl);
    setBackgroundInputValue(
      currentBackgroundUrl.startsWith("data:image/") ? "" : currentBackgroundUrl
    );
    setShowBackgroundDialog(true);
    setMemorySettingsOpen(false);
  };

  const closeBackgroundDialog = () => {
    setShowBackgroundDialog(false);
    setBackgroundDraft("");
    setBackgroundInputValue("");
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

  const updateAutoMemoryEnabled = async (enabled: boolean) => {
    if (!activeChat) {
      return;
    }

    setAutoMemoryEnabled(enabled);
    try {
      const updated = await api.chats.update(activeChat.id, { autoMemoryEnabled: enabled });
      applyChatUpdate(updated);
      setStatus(t("chat.chatSettingsSaved"));
    } catch (caught) {
      setAutoMemoryEnabled((current) => !current);
      setError(caught instanceof Error ? caught.message : t("chat.failedUpdateMemory"));
    }
  };

  const parseMemoryKeywords = (value: string) =>
    [...new Set(value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean))].slice(0, 12);

  const startCreatingMemory = () => {
    setEditingMemory("new");
    setMemoryForm(emptyMemoryForm);
  };

  const startEditingMemory = (memory: ChatMemoryDTO) => {
    setEditingMemory(memory);
    setMemoryForm({
      title: memory.title,
      content: memory.content,
      keywords: memory.keywords.join(", "),
      importance: String(memory.importance),
      enabled: memory.enabled
    });
  };

  const saveLongTermMemory = async () => {
    if (!activeChat || !editingMemory) {
      return;
    }

    const title = memoryForm.title.trim();
    const content = memoryForm.content.trim();
    if (!title || !content) {
      return;
    }

    const importance = Math.max(1, Math.min(5, Number(memoryForm.importance) || 3));
    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const payload = {
        title,
        content,
        keywords: parseMemoryKeywords(memoryForm.keywords),
        importance,
        enabled: memoryForm.enabled
      };
      const saved =
        editingMemory === "new"
          ? await api.chats.memories.create(activeChat.id, payload)
          : await api.chats.memories.update(activeChat.id, editingMemory.id, payload);
      setChatMemories((current) => {
        if (editingMemory === "new") {
          return [saved, ...current];
        }
        return current.map((memory) => (memory.id === saved.id ? saved : memory));
      });
      setEditingMemory(null);
      setMemoryForm(emptyMemoryForm);
      setStatus(t(editingMemory === "new" ? "chat.memoryCreated" : "chat.memoryUpdated"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedSaveMemory"));
    } finally {
      setLoading(false);
    }
  };

  const toggleLongTermMemory = async (memory: ChatMemoryDTO) => {
    if (!activeChat) {
      return;
    }

    try {
      const updated = await api.chats.memories.update(activeChat.id, memory.id, {
        enabled: !memory.enabled
      });
      setChatMemories((current) =>
        current.map((item) => (item.id === updated.id ? updated : item))
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedSaveMemory"));
    }
  };

  const deleteLongTermMemory = async () => {
    if (!activeChat || !pendingDeleteMemory) {
      return;
    }

    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      await api.chats.memories.remove(activeChat.id, pendingDeleteMemory.id);
      setChatMemories((current) =>
        current.filter((memory) => memory.id !== pendingDeleteMemory.id)
      );
      setPendingDeleteMemory(null);
      setStatus(t("chat.memoryDeleted"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedDeleteMemory"));
    } finally {
      setLoading(false);
    }
  };

  const refreshLongTermMemory = async () => {
    if (!activeChat) {
      return;
    }

    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const memories = await api.chats.memories.refresh(activeChat.id);
      setChatMemories(memories);
      setStatus(t("chat.memoryRefreshed"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedRefreshMemory"));
    } finally {
      setLoading(false);
    }
  };

  const updateMemory = async () => {
    if (!activeChat) {
      return;
    }

    const parsed = Number(memoryDraft);
    const memoryTurns = Math.max(
      1,
      Math.min(50, Number.isFinite(parsed) ? Math.floor(parsed) : activeChat.memoryTurns)
    );

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

  const updateBackgroundFile = async (file: File | undefined) => {
    if (!file) {
      return;
    }

    if (!file.type.startsWith("image/")) {
      setError(backgroundCopy.invalid);
      return;
    }

    if (file.size > MAX_CHAT_BACKGROUND_FILE_SIZE) {
      setError(backgroundCopy.tooLarge);
      return;
    }

    try {
      const nextBackground = await readFileAsDataUrl(file);
      setBackgroundDraft(nextBackground);
      setBackgroundInputValue("");
      setStatus(backgroundCopy.uploaded);
      setError(null);
    } catch {
      setError(backgroundCopy.uploadFailed);
    }
  };

  const saveBackground = async () => {
    if (!activeChat) {
      return;
    }

    const nextBackgroundUrl = backgroundDraft.trim();
    if (!isSupportedChatBackgroundUrl(nextBackgroundUrl)) {
      setError(backgroundCopy.invalid);
      return;
    }

    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const updated = await api.chats.update(activeChat.id, {
        backgroundUrl: nextBackgroundUrl
      });
      applyChatUpdate(updated);
      closeBackgroundDialog();
      setStatus(backgroundCopy.saved);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedUpdate"));
    } finally {
      setLoading(false);
    }
  };

  const switchModel = async (providerId: string, modelId: string) => {
    if (!runtimeSettings) {
      return;
    }

    const provider = settingsProviders.find((p) => p.id === providerId);
    const model = provider?.models.find((m) => m.id === modelId);
    if (!provider || !model) {
      return;
    }

    const previousProviderId = activeProviderId;
    const previousModelId = activeModelId;
    setModelSwitching(true);
    setError(null);
    setStatus(null);
    setActiveProviderId(providerId);
    setActiveModelId(modelId);
    setMemorySettingsOpen(false);

    const payload: SettingsInput = {
      activeProvider: provider.provider,
      apiBaseUrl: provider.apiBaseUrl,
      model: model.model,
      temperature: runtimeSettings.temperature,
      maxTokens: runtimeSettings.maxTokens,
      topP: runtimeSettings.topP,
      language: runtimeSettings.language,
      providers: settingsProviders,
      activeProviderId: providerId,
      activeModelId: modelId,
      autoSummarizeUser,
      showMessageAvatars
    };

    if (provider.key?.trim()) {
      payload.apiKey = provider.key.trim();
    }

    try {
      const updated = await api.settings.update(payload);
      setSettingsProviders(updated.providers ?? []);
      setActiveProviderId(updated.activeProviderId || null);
      setActiveModelId(updated.activeModelId || null);
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
      setStatus(t("chat.modelSwitched", { label: model.label || model.model }));
    } catch (caught) {
      setActiveProviderId(previousProviderId);
      setActiveModelId(previousModelId);
      setError(caught instanceof Error ? caught.message : t("chat.failedUpdateMemory"));
    } finally {
      setModelSwitching(false);
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
        content: draft.trim()
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
      return;
    }
    const lastMessage = activeChat.messages[activeChat.messages.length - 1];
    if (lastMessage.role === "user") {
      void resendMessage(lastMessage);
    } else if (lastMessage.role === "assistant") {
      void regenerateMessage(lastMessage);
    } else {
      for (let i = activeChat.messages.length - 1; i >= 0; i--) {
        if (activeChat.messages[i].role === "user") {
          void resendMessage(activeChat.messages[i]);
          return;
        }
      }
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
      <div className="flex flex-col h-full min-h-0 min-w-0" id="chat-page-root">
        <div className="flex flex-col h-full min-h-0 min-w-0" id="chat-panel">
          <Panel
            className="flex flex-col h-full min-h-0 min-w-0"
            title={
              <div className="min-w-0" id="chat-title">
                {titleEditing && activeChat ? (
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
                )}
              </div>
            }
            action={
              activeChat ? (
                <div className="relative" ref={memorySettingsRef}>
                  <Button
                    aria-expanded={memorySettingsOpen}
                    aria-label={t("chat.memorySettings")}
                    className="!h-8 !min-h-8 !w-8 !p-0"
                    id="chat-settings-trigger"
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
                      {settingsProviders.length > 0 ? (
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
                          onClick={openBackgroundDialog}
                        >
                          <span>{backgroundCopy.title}</span>
                          <Image size={14} className="text-slate-400" />
                        </button>
                      </div>

                      <div className="border-b border-white/10 pb-2 pt-2">
                        <button
                          className="flex min-h-[36px] w-full items-center justify-between text-sm font-semibold text-slate-100 transition-colors hover:text-ember-200 active:text-ember-300"
                          type="button"
                          onClick={() => void exportCurrentChat()}
                        >
                          <span>{t("chat.exportChat")}</span>
                          <Download size={14} className="text-slate-400" />
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
                              onChange={(event) =>
                                void updateAutoSummarizeUser(event.target.checked)
                              }
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
            <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl">
              {activeBackgroundUrl ? (
                <div className="pointer-events-none absolute inset-0">
                  <img
                    alt=""
                    aria-hidden="true"
                    className="h-full w-full object-cover"
                    src={activeBackgroundUrl}
                  />
                  <div className="absolute inset-0 bg-black/35" />
                  <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(12,13,18,0.2),rgba(12,13,18,0.7))]" />
                </div>
              ) : !activeChat ? (
                <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(251,146,60,0.08),transparent_38%)]" />
              ) : null}

              <div className="relative z-10 flex min-h-0 flex-1 flex-col">
                {!activeChat ? (
                  <div id="chat-empty-state">
                    <EmptyState>{t("chat.selectOrCreate")}</EmptyState>
                  </div>
                ) : (
                  <div className="flex min-h-0 flex-1 flex-col">
                    <ErrorNotice message={error} />
                    <SuccessNotice message={status} />

                    <div
                      id="chat-message-viewport"
                      ref={messageViewportRef}
                      data-testid="chat-message-viewport"
                      className={`custom-scrollbar min-h-0 flex-1 overscroll-auto scroll-smooth ${activeOpeningHtml ? "overflow-hidden" : "overflow-y-auto"}`}
                    >
                      {activeChat.messages.length === 0 && activeOpeningHtml ? (
                        <iframe
                          id="chat-opening-frame"
                          title={t("characters.openingHtml")}
                          srcDoc={activeOpeningHtml}
                          sandbox="allow-scripts"
                          className="w-full h-full border-0"
                        />
                      ) : (
                        <div
                          className="mx-auto max-w-2xl space-y-4 rounded-2xl p-2 sm:space-y-7 sm:p-5"
                          id="chat-message-list"
                        >
                          {activeChat.messages.length > MESSAGES_PER_PAGE ? (
                            <div
                              id="chat-pagination"
                              data-testid="chat-message-pagination"
                              className="sticky top-0 z-10 -mx-2 -mt-2 mb-3 flex flex-wrap items-center justify-between gap-2 rounded-t-2xl border-b border-white/5 bg-ink-900/90 px-2 pb-2 pt-1.5 backdrop-blur-md sm:-mx-5 sm:-mt-5 sm:mb-5 sm:gap-3 sm:px-5 sm:pb-3 sm:pt-5"
                            >
                              <div className="min-w-0">
                                <p className="text-xs font-semibold text-slate-200">
                                  {paginationCopy.page}
                                </p>
                                <p className="mt-1 text-xs text-slate-500">
                                  {paginationCopy.range}
                                </p>
                              </div>
                              <div className="flex items-center gap-1.5 sm:gap-2">
                                <Button
                                  className="!min-h-[36px] !px-2.5 sm:!min-h-[48px] sm:!px-3 text-xs"
                                  data-testid="chat-page-prev"
                                  disabled={safeMessagePage <= 1}
                                  variant="secondary"
                                  onClick={() =>
                                    setMessagePage((current) => Math.max(1, current - 1))
                                  }
                                >
                                  <ChevronLeft size={14} />
                                  {paginationCopy.previous}
                                </Button>
                                <Button
                                  className="!min-h-[36px] !px-2.5 sm:!min-h-[48px] sm:!px-3 text-xs"
                                  data-testid="chat-page-next"
                                  disabled={safeMessagePage >= totalMessagePages}
                                  variant="secondary"
                                  onClick={() =>
                                    setMessagePage((current) =>
                                      Math.min(totalMessagePages, current + 1)
                                    )
                                  }
                                >
                                  {safeMessagePage >= totalMessagePages
                                    ? paginationCopy.newest
                                    : paginationCopy.next}
                                  <ChevronRight size={14} />
                                </Button>
                              </div>
                            </div>
                          ) : null}
                          {activeChat.messages.length === 0 ? (
                            <div
                              className="flex h-full items-center justify-center"
                              id="chat-empty-state"
                            >
                              <EmptyState>{t("chat.noMessages")}</EmptyState>
                            </div>
                          ) : (
                            pagedMessages.map((message) => {
                              const isUser = message.role === "user";
                              const isSystem = message.role === "system";
                              const isErrorSystem =
                                isSystem && message.content.startsWith(GENERATION_ERROR_PREFIX);
                              const character = message.characterId
                                ? characterMap.get(message.characterId)
                                : undefined;
                              if (isErrorSystem) {
                                const errorText = message.content.slice(
                                  GENERATION_ERROR_PREFIX.length
                                );
                                const lastAssistant = [...activeChat.messages]
                                  .reverse()
                                  .find((m) => m.role === "assistant");
                                return (
                                  <ErrorBubble
                                    key={message.id}
                                    characterAvatar={
                                      lastAssistant?.characterId
                                        ? characterMap.get(lastAssistant.characterId)?.avatar
                                        : null
                                    }
                                    showAvatar={showMessageAvatars}
                                    error={errorText}
                                    onRetry={retryGeneration}
                                    onDismiss={() =>
                                      void api.messages.remove(message.id).then(() => {
                                        setActiveChat((current) =>
                                          current
                                            ? {
                                                ...current,
                                                messages: current.messages.filter(
                                                  (m) => m.id !== message.id
                                                )
                                              }
                                            : current
                                        );
                                      })
                                    }
                                  />
                                );
                              }
                              if (isSystem) {
                                return (
                                  <SystemNotification key={message.id} content={message.content} />
                                );
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
                          {activeRequestId &&
                          streamingCharacterId &&
                          safeMessagePage >= totalMessagePages ? (
                            <StreamingBubble
                              key="streaming"
                              characterAvatar={
                                streamingCharacterId
                                  ? characterMap.get(streamingCharacterId)?.avatar
                                  : null
                              }
                              showAvatar={showMessageAvatars}
                              htmlCss={
                                streamingCharacterId
                                  ? characterMap.get(streamingCharacterId)?.htmlCss
                                  : undefined
                              }
                              content={streamingContent}
                            />
                          ) : null}
                        </div>
                      )}
                      {!isNearBottom ? (
                        <button
                          id="chat-scroll-bottom"
                          type="button"
                          className="sticky bottom-3 z-20 mx-auto flex items-center gap-1.5 rounded-full border border-white/10 bg-ink-900/90 px-3 py-1.5 text-xs font-medium text-slate-300 shadow-lg shadow-black/30 backdrop-blur-sm transition-colors hover:bg-ink-800 hover:text-slate-100"
                          style={{
                            display: "flex",
                            width: "fit-content",
                            marginLeft: "auto",
                            marginRight: "auto"
                          }}
                          onClick={scrollToBottom}
                        >
                          <ArrowDown size={14} />
                          {t("chat.scrollToBottom")}
                        </button>
                      ) : null}
                    </div>

                    <div className="shrink-0">
                      {activeQuickReplies.length > 0 ? (
                        <div className="mx-auto mb-1 max-w-2xl px-1" id="chat-quick-replies">
                          <button
                            id="chat-quick-replies-toggle"
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
                                  data-chat-quick-reply=""
                                  key={qr.id}
                                  type="button"
                                  className="inline-flex h-7 items-center gap-1 rounded-md border border-white/10 bg-ink-950/80 px-2 text-xs font-medium text-slate-300 transition-colors hover:border-ember-500/40 hover:bg-ink-900 hover:text-slate-100 active:bg-ink-800"
                                  onClick={() =>
                                    setDraft((current) =>
                                      current ? `${current}\n${qr.content}` : qr.content
                                    )
                                  }
                                >
                                  {qr.label}
                                </button>
                              ))}
                            </div>
                          </div>
                        </div>
                      ) : null}
                      <div
                        className="mx-auto max-w-2xl rounded-xl border border-white/5 bg-ink-950/95 p-1.5 shadow-xl shadow-black/30 backdrop-blur-sm sm:p-2 xl:bg-ink-950/40 xl:shadow-none"
                        id="chat-composer"
                      >
                        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-end gap-1.5 sm:gap-2">
                          <TextArea
                            ref={draftTextAreaRef}
                            className="chat-input !resize-none border-0 bg-transparent !px-2 !py-[11px] !text-sm leading-[1.4] focus:bg-transparent focus:ring-0 sm:!py-3"
                            id="chat-message-input"
                            style={{ height: "auto" }}
                            placeholder={t("chat.writeMessage")}
                            rows={1}
                            value={draft}
                            onInput={autoResizeDraftTextArea}
                            onChange={(event) => setDraft(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" && !event.shiftKey) {
                                const hasTouch =
                                  navigator.maxTouchPoints > 0 || "ontouchstart" in window;
                                if (hasTouch && window.innerWidth < 768) return;
                                event.preventDefault();
                                void sendMessage();
                              }
                            }}
                          />
                          {activeRequestId ? (
                            <Button
                              className="!min-h-[40px] sm:!min-h-[44px]"
                              data-chat-action="stop"
                              id="chat-primary-action"
                              variant="danger"
                              onClick={stopGeneration}
                            >
                              <StopCircle size={16} />
                              {t("chat.stop")}
                            </Button>
                          ) : (
                            <Button
                              className="!min-h-[40px] sm:!min-h-[44px]"
                              data-chat-action="send"
                              id="chat-primary-action"
                              disabled={loading || !draft.trim()}
                              onClick={() => void sendMessage()}
                            >
                              <Send size={16} />
                              {t("chat.send")}
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </Panel>
        </div>
      </div>
      {editingMessage ? (
        <div className="animate-fade-in fixed inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-sm p-4">
          <section
            aria-labelledby="edit-message-title"
            className="animate-scale-in w-full max-w-2xl rounded-2xl border border-white/10 bg-ink-900 p-6 shadow-2xl shadow-black/50 max-h-[85vh] overflow-y-auto"
            role="dialog"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3
                  className="text-lg font-semibold tracking-tight text-slate-100"
                  id="edit-message-title"
                >
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
              <Button
                disabled={loading || !editDraft.trim()}
                onClick={() => void saveEditedMessage()}
              >
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
      {pendingDeleteMemory ? (
        <ConfirmDialog
          cancelLabel={t("common.cancel")}
          confirmLabel={t("common.delete")}
          loading={loading}
          message={t("chat.deleteMemoryConfirm")}
          title={t("chat.longTermMemory")}
          variant="danger"
          onCancel={() => setPendingDeleteMemory(null)}
          onConfirm={() => void deleteLongTermMemory()}
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
                <p className="text-sm font-semibold text-slate-300">{t("chat.userConfigPrefix")}</p>
                <MarkdownEditor
                  height={200}
                  placeholder={t("chat.userConfigPrefixHelp")}
                  value={editingPersonaDraft.prefix}
                  onChange={(nextValue) => updateUserConfigDraft("prefix", nextValue)}
                />
              </div>
              <div className="space-y-2">
                <p className="text-sm font-semibold text-slate-300">{t("chat.userConfigPrompt")}</p>
                <MarkdownEditor
                  height={200}
                  placeholder={t("chat.userConfigPromptHelp")}
                  value={editingPersonaDraft.prompt}
                  onChange={(nextValue) => updateUserConfigDraft("prompt", nextValue)}
                />
              </div>
              <div className="space-y-2">
                <p className="text-sm font-semibold text-slate-300">{t("chat.userConfigSuffix")}</p>
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
          <div className="space-y-1">
            {settingsProviders.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-slate-500">
                {t("chat.noProviders")}
              </p>
            ) : (
              settingsProviders.map((provider) => {
                const isExpanded = expandedDialogProviderId === provider.id;
                const hasActiveModel = provider.models.some((m) => m.id === activeModelId && provider.id === activeProviderId);

                return (
                  <div key={provider.id} className="rounded-lg">
                    <button
                      className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm transition-colors ${
                        hasActiveModel
                          ? "bg-ember-500/10 text-ember-200"
                          : "text-slate-300 hover:bg-white/5 hover:text-slate-100"
                      }`}
                      type="button"
                      onClick={() => {
                        setExpandedDialogProviderId(isExpanded ? null : provider.id);
                      }}
                    >
                      {isExpanded ? (
                        <ChevronDown size={14} className="shrink-0 text-slate-500" />
                      ) : (
                        <ChevronRight size={14} className="shrink-0 text-slate-500" />
                      )}
                      <span className="min-w-0 flex-1 truncate font-medium">
                        {provider.label || provider.provider}
                      </span>
                      <span className="ml-auto shrink-0 rounded-full bg-white/5 px-2 py-0.5 text-xs text-slate-500">
                        {provider.models.length}
                      </span>
                    </button>

                    {isExpanded ? (
                      <div className="ml-4 mt-1 space-y-0.5 border-l border-white/5 pl-3">
                        {provider.models.length === 0 ? (
                          <p className="px-2 py-3 text-xs text-slate-600">
                            {language === "zh-CN" ? "该供应商下还没有模型" : "No models configured"}
                          </p>
                        ) : (
                          provider.models.map((model) => {
                            const isActive = provider.id === activeProviderId && model.id === activeModelId;
                            return (
                              <button
                                className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                                  isActive
                                    ? "bg-ember-500/15 text-ember-200 ring-1 ring-ember-500/30"
                                    : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
                                }`}
                                disabled={modelSwitching}
                                key={model.id}
                                type="button"
                                onClick={() => {
                                  void switchModel(provider.id, model.id);
                                  closeModelDialog();
                                }}
                              >
                                {isActive ? (
                                  <Check size={14} className="shrink-0 text-ember-300" />
                                ) : (
                                  <Sparkles size={14} className="shrink-0 text-slate-600" />
                                )}
                                <span className="min-w-0 flex-1 truncate font-medium">
                                  {model.label || model.model}
                                </span>
                              </button>
                            );
                          })
                        )}
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        </Modal>
      ) : null}
      {showBackgroundDialog ? (
        <Modal title={backgroundCopy.title} onClose={closeBackgroundDialog}>
          <div className="space-y-4">
            <p className="whitespace-pre-line break-words text-xs leading-5 text-slate-400">
              {backgroundCopy.help}
            </p>
            <div className="space-y-3">
              <TextInput
                placeholder={backgroundCopy.inputPlaceholder}
                value={backgroundInputValue}
                onChange={(event) => {
                  const nextValue = event.target.value;
                  setBackgroundInputValue(nextValue);
                  setBackgroundDraft(nextValue);
                }}
              />
              <div className="flex flex-wrap gap-3">
                <Button
                  className="!min-h-[36px]"
                  disabled={loading}
                  variant="secondary"
                  onClick={() => backgroundFileInputRef.current?.click()}
                >
                  {backgroundCopy.upload}
                </Button>
                <Button
                  className="!min-h-[36px]"
                  disabled={loading || !backgroundDraft.trim()}
                  variant="ghost"
                  onClick={() => {
                    setBackgroundDraft("");
                    setBackgroundInputValue("");
                  }}
                >
                  {backgroundCopy.clear}
                </Button>
                <input
                  ref={backgroundFileInputRef}
                  className="sr-only"
                  type="file"
                  accept="image/*"
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = "";
                    void updateBackgroundFile(file);
                  }}
                />
              </div>
              <div className="rounded-xl border border-white/10 bg-ink-950/40 p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold text-slate-200">{backgroundCopy.preview}</p>
                  {usingUploadedBackground ? (
                    <span className="text-xs font-medium text-ember-200">
                      {backgroundCopy.uploaded}
                    </span>
                  ) : null}
                </div>
                {backgroundDraft.trim() ? (
                  <div className="overflow-hidden rounded-lg border border-white/10 bg-black/20">
                    <img
                      alt={backgroundCopy.preview}
                      className="h-44 w-full object-cover"
                      src={backgroundDraft}
                    />
                  </div>
                ) : (
                  <p className="text-sm text-slate-400">{backgroundCopy.empty}</p>
                )}
              </div>
            </div>
            <div className="flex justify-end gap-3">
              <Button
                className="!min-h-[36px]"
                disabled={loading}
                variant="ghost"
                onClick={closeBackgroundDialog}
              >
                {t("common.cancel")}
              </Button>
              <Button
                className="!min-h-[36px]"
                disabled={loading}
                onClick={() => void saveBackground()}
              >
                {t("common.save")}
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}
      {showMemoryDialog ? (
        <Modal title={t("chat.memorySettings")} onClose={closeMemoryDialog}>
          <div className="space-y-6">
            <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                <div className="space-y-2">
                  <p className="text-sm font-semibold text-slate-200">{t("chat.memorySettings")}</p>
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
                </div>
                <Button
                  className="!min-h-[36px]"
                  disabled={loading}
                  onClick={() => void updateMemory()}
                >
                  {t("common.save")}
                </Button>
              </div>
              <p className="mt-3 whitespace-pre-line break-words text-xs leading-5 text-slate-400">
                {t("chat.memoryHelp")}
              </p>
            </div>

            <div className="space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <h4 className="text-sm font-semibold text-slate-100">{t("chat.longTermMemory")}</h4>
                  <p className="max-w-xl text-xs leading-5 text-slate-400">
                    {t("chat.longTermMemoryHelp")}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    className="!min-h-[34px] !px-3 text-xs"
                    disabled={loading}
                    variant="secondary"
                    onClick={() => void refreshLongTermMemory()}
                  >
                    <RefreshCw size={14} />
                    {t("chat.refreshMemory")}
                  </Button>
                  <Button
                    className="!min-h-[34px] !px-3 text-xs"
                    variant="secondary"
                    onClick={startCreatingMemory}
                  >
                    <Plus size={14} />
                    {t("chat.addMemory")}
                  </Button>
                </div>
              </div>

              <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-slate-300">
                <span>{t("chat.autoMemory")}</span>
                <input
                  checked={autoMemoryEnabled}
                  type="checkbox"
                  className="rounded border-white/20 bg-ink-950 text-ember-500 focus:ring-ember-500/50"
                  onChange={(event) => void updateAutoMemoryEnabled(event.target.checked)}
                />
              </label>

              {editingMemory ? (
                <div className="space-y-3 rounded-xl border border-ember-500/20 bg-ember-500/[0.04] p-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-slate-100">
                      {t(editingMemory === "new" ? "chat.addMemory" : "chat.editMemory")}
                    </p>
                    <button
                      className="grid h-8 w-8 place-items-center rounded-lg text-slate-500 transition-colors hover:bg-white/10 hover:text-slate-200"
                      type="button"
                      onClick={() => {
                        setEditingMemory(null);
                        setMemoryForm(emptyMemoryForm);
                      }}
                    >
                      <X size={14} />
                    </button>
                  </div>
                  <TextInput
                    maxLength={80}
                    placeholder={t("chat.memoryTitle")}
                    value={memoryForm.title}
                    onChange={(event) =>
                      setMemoryForm((current) => ({ ...current, title: event.target.value }))
                    }
                  />
                  <TextArea
                    className="min-h-28"
                    maxLength={1200}
                    placeholder={t("chat.memoryContent")}
                    value={memoryForm.content}
                    onChange={(event) =>
                      setMemoryForm((current) => ({ ...current, content: event.target.value }))
                    }
                  />
                  <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem]">
                    <div className="space-y-1">
                      <TextInput
                        placeholder={t("chat.memoryKeywords")}
                        value={memoryForm.keywords}
                        onChange={(event) =>
                          setMemoryForm((current) => ({ ...current, keywords: event.target.value }))
                        }
                      />
                      <p className="text-xs text-slate-500">{t("chat.memoryKeywordsHelp")}</p>
                    </div>
                    <TextInput
                      min={1}
                      max={5}
                      type="number"
                      value={memoryForm.importance}
                      onChange={(event) =>
                        setMemoryForm((current) => ({ ...current, importance: event.target.value }))
                      }
                    />
                  </div>
                  <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-300">
                    <input
                      checked={memoryForm.enabled}
                      type="checkbox"
                      className="rounded border-white/20 bg-ink-950 text-ember-500 focus:ring-ember-500/50"
                      onChange={(event) =>
                        setMemoryForm((current) => ({ ...current, enabled: event.target.checked }))
                      }
                    />
                    {memoryForm.enabled ? t("common.enabled") : t("common.disabled")}
                  </label>
                  <div className="flex justify-end gap-2">
                    <Button
                      className="!min-h-[34px]"
                      disabled={loading}
                      variant="ghost"
                      onClick={() => {
                        setEditingMemory(null);
                        setMemoryForm(emptyMemoryForm);
                      }}
                    >
                      {t("common.cancel")}
                    </Button>
                    <Button
                      className="!min-h-[34px]"
                      disabled={loading || !memoryForm.title.trim() || !memoryForm.content.trim()}
                      onClick={() => void saveLongTermMemory()}
                    >
                      {t("common.save")}
                    </Button>
                  </div>
                </div>
              ) : null}

              {chatMemories.length === 0 ? (
                <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-6 text-center text-sm text-slate-500">
                  {t("chat.memoryEmpty")}
                </div>
              ) : (
                <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
                  {chatMemories.map((memory) => (
                    <div
                      key={memory.id}
                      className={`rounded-xl border p-3 ${
                        memory.enabled
                          ? "border-white/10 bg-white/[0.03]"
                          : "border-white/5 bg-white/[0.015] opacity-70"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="break-words text-sm font-semibold text-slate-100">
                              {memory.title}
                            </p>
                            <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-300">
                              {t("chat.memoryImportance")} {memory.importance}
                            </span>
                            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                              memory.enabled
                                ? "bg-ember-500/15 text-ember-300"
                                : "bg-white/10 text-slate-400"
                            }`}>
                              {memory.enabled ? t("common.enabled") : t("common.disabled")}
                            </span>
                          </div>
                          <p className="whitespace-pre-wrap break-words text-sm leading-6 text-slate-300">
                            {memory.content}
                          </p>
                          {memory.keywords.length ? (
                            <div className="flex flex-wrap gap-1">
                              {memory.keywords.map((keyword) => (
                                <span
                                  key={keyword}
                                  className="rounded-full bg-white/5 px-2 py-0.5 text-xs text-slate-400"
                                >
                                  {keyword}
                                </span>
                              ))}
                            </div>
                          ) : null}
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <button
                            className="grid h-8 w-8 place-items-center rounded-lg text-slate-500 transition-colors hover:bg-white/10 hover:text-slate-200"
                            type="button"
                            onClick={() => void toggleLongTermMemory(memory)}
                          >
                            <Check size={14} />
                          </button>
                          <button
                            className="grid h-8 w-8 place-items-center rounded-lg text-slate-500 transition-colors hover:bg-white/10 hover:text-slate-200"
                            type="button"
                            onClick={() => startEditingMemory(memory)}
                          >
                            <FileText size={14} />
                          </button>
                          <button
                            className="grid h-8 w-8 place-items-center rounded-lg text-rose-400 transition-colors hover:bg-rose-500/15"
                            type="button"
                            onClick={() => setPendingDeleteMemory(memory)}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </Modal>
      ) : null}
      <DebugPromptDrawer
        open={debugMessage !== null}
        onClose={() => setDebugMessage(null)}
        activeChat={activeChat}
        character={activeChat?.characterId ? characterMap.get(activeChat.characterId) : undefined}
        debugMessage={debugMessage}
      />
    </>
  );
}
