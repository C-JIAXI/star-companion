import {
  ArrowDown,
  Bookmark,
  BrainCircuit,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Check,
  Clipboard,
  Download,
  FileText,
  GitBranch,
  Image,
  ListChecks,
  Mic,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Send,
  Settings,
  Sparkles,
  StopCircle,
  Trash2,
  User,
  Volume2,
  VolumeX,
  X
} from "lucide-react";
import {
  emptyUserCustomConfig,
  modelSupportsAiModule,
  parseUserCustomConfig,
  serializeUserCustomConfig,
  type AiModuleId,
  type UserCustomConfigDTO
} from "@local-roleplay/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { api } from "../lib/api";
import {
  buildChatTranscript,
  safeChatTranscriptName,
  type ChatTranscriptFormat
} from "../lib/chatTranscript";
import { scopeCharacterChatUiCss } from "../lib/characterHtmlCss";
import { readFileAsDataUrl, saveTextFile } from "../lib/files";
import { queueChatMessageJump, takeChatMessageJump } from "../lib/messageNavigation";
import { generateId } from "../lib/uuid";
import { useWebSocket } from "../lib/useWebSocket";
import { useAppStore } from "../store/useAppStore";
import type {
  CharacterDTO,
  ChatAgentDraftDTO,
  ChatAgentMode,
  ChatMemoryDTO,
  ChatMessageSearchDTO,
  ChatDTO,
  ChatTitleSuggestionDTO,
  ChatWithMessagesDTO,
  GenerationClientMessage,
  GenerationServerMessage,
  MessageDTO,
  ProviderProfile,
  PublicUserSettingsDTO,
  SettingsInput,
  TokenUsageDTO,
  UserPersonaPresetDTO
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
import { ChatStoryNavigator } from "../components/ChatStoryNavigator";

const MESSAGES_PER_PAGE = 30;
const CHAT_DRAFT_STORAGE_PREFIX = "star-companion:chat-draft:";
const CHAT_QUEUE_STORAGE_PREFIX = "star-companion:chat-queue:";
const MAX_QUEUED_MESSAGES = 10;
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
const agentModes: ChatAgentMode[] = [
  "scene_summary",
  "next_steps",
  "reply_drafts",
  "memory_lore_candidates"
];

const getMessagePreview = (content: string, maxLength = 180) => {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength).trimEnd()}…`
    : normalized;
};

const blobToBase64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result ?? "");
      resolve(value.includes(",") ? value.split(",").pop() ?? "" : value);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(blob);
  });

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

const chatDraftStorageKey = (chatId: string) => `${CHAT_DRAFT_STORAGE_PREFIX}${chatId}`;

const readStoredChatDraft = (chatId: string) => {
  try {
    return window.localStorage.getItem(chatDraftStorageKey(chatId)) ?? "";
  } catch {
    return "";
  }
};

const saveStoredChatDraft = (chatId: string, value: string) => {
  try {
    if (value) {
      window.localStorage.setItem(chatDraftStorageKey(chatId), value);
    } else {
      window.localStorage.removeItem(chatDraftStorageKey(chatId));
    }
  } catch {
    // Draft persistence is best-effort when browser storage is unavailable.
  }
};

type QueuedChatMessage = {
  id: string;
  content: string;
};

const chatQueueStorageKey = (chatId: string) => `${CHAT_QUEUE_STORAGE_PREFIX}${chatId}`;

const readStoredChatQueue = (chatId: string): QueuedChatMessage[] => {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(chatQueueStorageKey(chatId)) ?? "[]");
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter(
        (entry): entry is QueuedChatMessage =>
          Boolean(
            entry &&
              typeof entry === "object" &&
              typeof entry.id === "string" &&
              typeof entry.content === "string" &&
              entry.content.trim()
          )
      )
      .slice(0, MAX_QUEUED_MESSAGES)
      .map((entry) => ({ id: entry.id, content: entry.content.trim() }));
  } catch {
    return [];
  }
};

const saveStoredChatQueue = (chatId: string, messages: QueuedChatMessage[]) => {
  try {
    if (messages.length > 0) {
      window.sessionStorage.setItem(chatQueueStorageKey(chatId), JSON.stringify(messages));
    } else {
      window.sessionStorage.removeItem(chatQueueStorageKey(chatId));
    }
  } catch {
    // Queue persistence is best-effort and intentionally limited to this browser session.
  }
};

const hasCompatibleModuleModel = (
  settings: PublicUserSettingsDTO,
  moduleId: AiModuleId
) => {
  const preference = settings.moduleModelPreferences?.[moduleId];
  const provider = preference
    ? settings.providers.find((entry) => entry.id === preference.providerId)
    : settings.providers.find((entry) => entry.id === settings.activeProviderId);
  const model = preference
    ? provider?.models.find((entry) => entry.id === preference.modelId)
    : provider?.models.find((entry) => entry.id === settings.activeModelId) ?? {
        model: settings.model
      };

  return Boolean(model?.model && modelSupportsAiModule(provider?.provider ?? settings.activeProvider, model, moduleId));
};

export function ChatPage({
  selectedChatId,
  onChatsChanged,
  onNewChat,
  onSelectChat
}: {
  selectedChatId: string | null;
  onChatsChanged: () => void;
  onNewChat: () => void;
  onSelectChat: (id: string | null) => void;
}) {
  const { language, t } = useI18n();
  const showMessageAvatars = useAppStore((state) => state.showMessageAvatars);
  const showMessageTimestamps = useAppStore((state) => state.showMessageTimestamps);
  const [characters, setCharacters] = useState<CharacterDTO[]>([]);
  const [activeChat, setActiveChat] = useState<ChatWithMessagesDTO | null>(null);
  const [draft, setDraft] = useState("");
  const [queuedMessages, setQueuedMessages] = useState<QueuedChatMessage[]>([]);
  const [streamingContent, setStreamingContent] = useState("");
  const [streamingCharacterId, setStreamingCharacterId] = useState<string | null>(null);
  const [streamingContextCounts, setStreamingContextCounts] = useState<{
    lore: number;
    memory: number;
  } | null>(null);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [generationChatId, setGenerationChatId] = useState<string | null>(null);
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
  const [hasApiKey, setHasApiKey] = useState(false);
  const [characterTotal, setCharacterTotal] = useState<number | null>(null);
  const [expandedDialogProviderId, setExpandedDialogProviderId] = useState<string | null>(null);
  const [runtimeSettings, setRuntimeSettings] = useState<PublicUserSettingsDTO | null>(null);
  const [autoSummarizeUser, setAutoSummarizeUser] = useState(true);
  const [showUserConfigDialog, setShowUserConfigDialog] = useState(false);
  const [showUserProfileDialog, setShowUserProfileDialog] = useState(false);
  const [showModelDialog, setShowModelDialog] = useState(false);
  const [modelSwitching, setModelSwitching] = useState(false);
  const [showMemoryDialog, setShowMemoryDialog] = useState(false);
  const [showBackgroundDialog, setShowBackgroundDialog] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [transcriptFormat, setTranscriptFormat] = useState<ChatTranscriptFormat>("markdown");
  const [transcriptIncludeTimestamps, setTranscriptIncludeTimestamps] = useState(true);
  const [transcriptExportedAt, setTranscriptExportedAt] = useState(() => new Date().toISOString());
  const [showReadinessDialog, setShowReadinessDialog] = useState(false);
  const [showStoryNavigator, setShowStoryNavigator] = useState(false);
  const [storyChats, setStoryChats] = useState<ChatDTO[]>([]);
  const [storyNavigatorLoading, setStoryNavigatorLoading] = useState(false);
  const [storyNavigatorError, setStoryNavigatorError] = useState<string | null>(null);
  const [showImageDialog, setShowImageDialog] = useState(false);
  const [imagePromptDraft, setImagePromptDraft] = useState("");
  const [imageSize, setImageSize] = useState<"1024x1024" | "1024x1536" | "1536x1024" | "auto">(
    "1024x1024"
  );
  const [generatedImagePreview, setGeneratedImagePreview] = useState<{
    prompt: string;
    src: string;
  } | null>(null);
  const [backgroundDraft, setBackgroundDraft] = useState("");
  const [backgroundInputValue, setBackgroundInputValue] = useState("");
  const [debugMessage, setDebugMessage] = useState<MessageDTO | null>(null);
  const [agentPanelOpen, setAgentPanelOpen] = useState(false);
  const [agentMode, setAgentMode] = useState<ChatAgentMode>("next_steps");
  const [agentFocus, setAgentFocus] = useState("");
  const [agentDraft, setAgentDraft] = useState<ChatAgentDraftDTO | null>(null);
  const [agentLoading, setAgentLoading] = useState(false);
  const [messageSearchOpen, setMessageSearchOpen] = useState(false);
  const [messageSearchQuery, setMessageSearchQuery] = useState("");
  const [messageSearchResult, setMessageSearchResult] = useState<ChatMessageSearchDTO | null>(null);
  const [messageSearchLoading, setMessageSearchLoading] = useState(false);
  const [showBookmarksDialog, setShowBookmarksDialog] = useState(false);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [mediaLoading, setMediaLoading] = useState(false);
  const [speechPlaying, setSpeechPlaying] = useState(false);
  const [speechMessageId, setSpeechMessageId] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const speechAudioRef = useRef<HTMLAudioElement | null>(null);
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
  const [userPersonaPresets, setUserPersonaPresets] = useState<UserPersonaPresetDTO[]>([]);
  const [personaPresetName, setPersonaPresetName] = useState("");
  const [editingProfileDraft, setEditingProfileDraft] = useState("");
  const [pendingDeleteMessage, setPendingDeleteMessage] = useState<MessageDTO | null>(null);
  const [pendingResendMessage, setPendingResendMessage] = useState<MessageDTO | null>(null);
  const [messageDeleteLoading, setMessageDeleteLoading] = useState(false);
  const [pendingCheckpointMessage, setPendingCheckpointMessage] = useState<MessageDTO | null>(null);
  const [checkpointTitleDraft, setCheckpointTitleDraft] = useState("");
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [titleSuggestionLoading, setTitleSuggestionLoading] = useState(false);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const [messagePage, setMessagePage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const streamingBufferRef = useRef("");
  const draftChatIdRef = useRef<string | null>(null);
  const queuedChatIdRef = useRef<string | null>(null);
  const queuedMessagesRef = useRef<QueuedChatMessage[]>([]);
  const interruptForQueueRef = useRef(false);
  const resendRequestRef = useRef<{ requestId: string; messageId: string } | null>(null);
  const draftTextAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const messageViewportRef = useRef<HTMLDivElement | null>(null);
  const backgroundFileInputRef = useRef<HTMLInputElement | null>(null);
  const paginationStateRef = useRef<{ chatId: string | null; totalPages: number }>({
    chatId: null,
    totalPages: 1
  });
  const hasMessagesRef = useRef(false);
  const autoTitleChatIdsRef = useRef(new Set<string>());

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
    dispatchQueuedMessages: () => void;
    autoPlayAssistantMessage: (message: MessageDTO) => void;
  }>({
    upsertMessage: () => {},
    setStreamingContent: () => {},
    chatsChanged: () => {},
    dispatchQueuedMessages: () => {},
    autoPlayAssistantMessage: () => {}
  });

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
        setStreamingContextCounts(null);
        streamingBufferRef.current = "";
        return;
      }

      if (msg.type === "lore_matches") {
        setStreamingContextCounts((current) => ({
          lore: msg.entries.length,
          memory: current?.memory ?? 0
        }));
        return;
      }

      if (msg.type === "memory_matches") {
        setStreamingContextCounts((current) => ({
          lore: current?.lore ?? 0,
          memory: msg.entries.length
        }));
        return;
      }

      if (msg.type === "assistant_message") {
        handlers.upsertMessage(msg.message);
        window.requestAnimationFrame(() => {
          onMessageHandlersRef.current.autoPlayAssistantMessage(msg.message);
        });
        setStreamingContent("");
        setStreamingCharacterId(null);
        setStreamingContextCounts(null);
        streamingBufferRef.current = "";
        return;
      }

      if (msg.type === "generation_started") {
        const resendRequest = resendRequestRef.current;
        if (resendRequest?.requestId === msg.requestId) {
          setActiveChat((current) => {
            if (!current) {
              return current;
            }
            const targetIndex = current.messages.findIndex(
              (message) => message.id === resendRequest.messageId
            );
            return targetIndex >= 0
              ? { ...current, messages: current.messages.slice(0, targetIndex) }
              : current;
          });
        }
        setActiveRequestId(msg.requestId);
        setStreamingContent("");
        setStreamingCharacterId(null);
        setStreamingContextCounts(null);
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

      if (msg.type === "chat_memory_updated") {
        setActiveChat((current) =>
          current && current.id === msg.summary.chatId
            ? { ...current, memoryUpdatedAt: msg.summary.memoryUpdatedAt }
            : current
        );
        setStatus(
          t("chat.memoryAutoUpdated", {
            created: msg.summary.created,
            updated: msg.summary.updated,
            disabled: msg.summary.disabled
          })
        );
        if (showMemoryDialog) {
          void loadChatMemories();
        }
        return;
      }

      if (msg.type === "timeline_memory_invalidated") {
        setActiveChat((current) =>
          current && current.id === msg.chatId ? { ...current, memoryUpdatedAt: null } : current
        );
        setStatus(t("chat.timelineMemoriesDisabled", { count: msg.disabledMemoryCount }));
        if (showMemoryDialog) {
          void loadChatMemories();
        }
        return;
      }

      if (msg.type === "generation_done" || msg.type === "generation_stopped") {
        if (resendRequestRef.current?.requestId === msg.requestId) {
          resendRequestRef.current = null;
        }
        const shouldDispatchQueue =
          msg.type === "generation_done" || interruptForQueueRef.current;
        interruptForQueueRef.current = false;
        setActiveRequestId(null);
        setGenerationChatId(null);
        setStreamingContent("");
        setStreamingCharacterId(null);
        setStreamingContextCounts(null);
        streamingBufferRef.current = "";
        setLoading(false);
        handlers.chatsChanged();
        if (
          shouldDispatchQueue &&
          queuedChatIdRef.current &&
          queuedMessagesRef.current.length > 0
        ) {
          handlers.dispatchQueuedMessages();
        }
        return;
      }

      if (msg.type === "error") {
        if (resendRequestRef.current?.requestId === msg.requestId) {
          resendRequestRef.current = null;
        }
        setError(msg.error);
        interruptForQueueRef.current = false;
        setActiveRequestId(null);
        setGenerationChatId(null);
        setStreamingContent("");
        setStreamingCharacterId(null);
        setStreamingContextCounts(null);
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
      chatsChanged: onChatsChanged,
      dispatchQueuedMessages: onMessageHandlersRef.current.dispatchQueuedMessages,
      autoPlayAssistantMessage: onMessageHandlersRef.current.autoPlayAssistantMessage
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

  const transcriptPreview = useMemo(() => {
    if (!activeChat) return "";
    return buildChatTranscript({
      chat: activeChat,
      characterName: activeChat.characterId
        ? characterMap.get(activeChat.characterId)?.name
        : undefined,
      language,
      format: transcriptFormat,
      includeTimestamps: transcriptIncludeTimestamps,
      exportedAt: transcriptExportedAt
    });
  }, [
    activeChat,
    characterMap,
    language,
    transcriptExportedAt,
    transcriptFormat,
    transcriptIncludeTimestamps
  ]);

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

  const navigateToSection = useCallback(
    (
      section: "chat" | "characters" | "settings",
      settingsFocus?:
        | "provider"
        | "api-key"
        | "model"
        | `module-${AiModuleId}`
    ) => {
      const path =
        section === "chat"
          ? "/"
          : section === "settings" && settingsFocus
            ? `/settings?section=providers&focus=${settingsFocus}`
            : `/${section}`;
      setShowReadinessDialog(false);
      window.history.pushState({}, "", path);
      window.dispatchEvent(new PopStateEvent("popstate"));
    },
    []
  );

  const openModuleModelSettings = useCallback(
    (moduleId: AiModuleId) => navigateToSection("settings", `module-${moduleId}`),
    [navigateToSection]
  );

  const activeProviderProfile = useMemo(
    () => settingsProviders.find((provider) => provider.id === activeProviderId) ?? null,
    [activeProviderId, settingsProviders]
  );

  const hasConfiguredProvider = Boolean(
    activeProviderProfile ||
      settingsProviders.length > 0 ||
      (runtimeSettings?.activeProvider.trim() && runtimeSettings.apiBaseUrl.trim())
  );
  const hasEffectiveApiKey = hasApiKey || Boolean(activeProviderProfile?.key?.trim());
  const hasConfiguredModel = Boolean(
    activeProviderProfile?.models.some((model) => model.id === activeModelId) ||
      runtimeSettings?.model.trim()
  );
  const canTranscribe = runtimeSettings
    ? hasCompatibleModuleModel(runtimeSettings, "voice_transcription")
    : true;
  const canSpeak = runtimeSettings
    ? hasCompatibleModuleModel(runtimeSettings, "voice_speech")
    : true;
  const canGenerateImage = runtimeSettings
    ? hasCompatibleModuleModel(runtimeSettings, "image_generation")
    : true;
  const hasAnyCharacter = (characterTotal ?? characters.length) > 0;
  const readinessItems = useMemo<
    {
      id: string;
      ready: boolean;
      title: string;
      detail: string;
      actionLabel?: string;
      onAction?: () => void;
    }[]
  >(
    () => [
      {
        id: "provider",
        ready: hasConfiguredProvider,
        title: t("chat.readinessProviderTitle"),
        detail: hasConfiguredProvider
          ? t("chat.readinessProviderReady")
          : t("chat.readinessProviderMissing"),
        actionLabel: t("chat.readinessOpenSettings"),
        onAction: () => navigateToSection("settings", "provider")
      },
      {
        id: "apiKey",
        ready: hasEffectiveApiKey,
        title: t("chat.readinessApiKeyTitle"),
        detail: hasEffectiveApiKey ? t("chat.readinessApiKeyReady") : t("chat.readinessApiKeyMissing"),
        actionLabel: t("chat.readinessOpenSettings"),
        onAction: () => navigateToSection("settings", "api-key")
      },
      {
        id: "model",
        ready: hasConfiguredModel,
        title: t("chat.readinessModelTitle"),
        detail: hasConfiguredModel ? t("chat.readinessModelReady") : t("chat.readinessModelMissing"),
        actionLabel: t("chat.readinessOpenSettings"),
        onAction: () => navigateToSection("settings", "model")
      },
      {
        id: "character",
        ready: hasAnyCharacter,
        title: t("chat.readinessCharacterTitle"),
        detail: hasAnyCharacter
          ? t("chat.readinessCharacterReady", { count: characterTotal ?? characters.length })
          : t("chat.readinessCharacterMissing"),
        actionLabel: t("chat.readinessOpenCharacters"),
        onAction: () => navigateToSection("characters")
      },
      {
        id: "chat",
        ready: Boolean(activeChat),
        title: t("chat.readinessChatTitle"),
        detail: activeChat ? t("chat.readinessChatReady") : t("chat.readinessChatMissing"),
        actionLabel: hasAnyCharacter ? t("chat.newChat") : undefined,
        onAction: hasAnyCharacter ? onNewChat : undefined
      }
    ],
    [
      activeChat,
      characterTotal,
      characters.length,
      hasAnyCharacter,
      hasConfiguredModel,
      hasConfiguredProvider,
      hasEffectiveApiKey,
      navigateToSection,
      onNewChat,
      t
    ]
  );
  const readinessIssueCount = readinessItems.filter((item) => !item.ready).length;

  const ensureChatGenerationReady = () => {
    if (hasConfiguredProvider && hasConfiguredModel) {
      return true;
    }

    setShowReadinessDialog(true);
    return false;
  };

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

  const bookmarkedMessages = useMemo(
    () =>
      (activeChat?.messages ?? [])
        .map((message, index) => ({ message, index }))
        .filter(({ message }) => message.isBookmarked)
        .reverse(),
    [activeChat?.messages]
  );

  const pageRange = useMemo(() => {
    const totalMessages = activeChat?.messages.length ?? 0;

    if (totalMessages === 0) {
      return { start: 0, end: 0, total: 0 };
    }

    const start = (safeMessagePage - 1) * MESSAGES_PER_PAGE + 1;
    const end = Math.min(start + pagedMessages.length - 1, totalMessages);
    return { start, end, total: totalMessages };
  }, [activeChat?.messages.length, pagedMessages.length, safeMessagePage]);

  const pendingDeleteImpact = useMemo(() => {
    if (!pendingDeleteMessage) {
      return null;
    }

    const messages = activeChat?.messages ?? [];
    const targetIndex = messages.findIndex(
      (message) => message.id === pendingDeleteMessage.id
    );
    const affectedMessages =
      pendingDeleteMessage.role === "user" && targetIndex >= 0
        ? messages.slice(targetIndex)
        : [pendingDeleteMessage];

    return {
      total: affectedMessages.length,
      following: Math.max(0, affectedMessages.length - 1),
      preview: getMessagePreview(pendingDeleteMessage.content)
    };
  }, [activeChat?.messages, pendingDeleteMessage]);

  const pendingResendImpact = useMemo(() => {
    if (!pendingResendMessage) {
      return null;
    }

    const messages = activeChat?.messages ?? [];
    const targetIndex = messages.findIndex((message) => message.id === pendingResendMessage.id);
    return {
      following: targetIndex >= 0 ? Math.max(0, messages.length - targetIndex - 1) : 0,
      preview: getMessagePreview(pendingResendMessage.content)
    };
  }, [activeChat?.messages, pendingResendMessage]);

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
    setRuntimeSettings(settings);
    setAutoSummarizeUser(settings.autoSummarizeUser);
    useAppStore.getState().setShowMessageAvatars(settings.showMessageAvatars);
    useAppStore.getState().setShowMessageTimestamps(settings.showMessageTimestamps);
    setActiveProviderId(settings.activeProviderId || null);
    setActiveModelId(settings.activeModelId || null);
    setHasApiKey(settings.hasApiKey);
  };

  useEffect(() => {
    if (!activeChat || activeChat.title !== "New Chat" || autoTitleChatIdsRef.current.has(activeChat.id)) {
      return;
    }
    const conversation = activeChat.messages.filter(
      (message) => message.role === "user" || message.role === "assistant"
    );
    if (
      conversation.length !== 2 ||
      !conversation.some((message) => message.role === "user") ||
      !conversation.some((message) => message.role === "assistant")
    ) {
      return;
    }

    autoTitleChatIdsRef.current.add(activeChat.id);
    void api.chats
      .titleSuggestion(activeChat.id)
      .then((suggestion) => api.chats.update(activeChat.id, { title: suggestion.title }))
      .then((updated) => applyChatUpdate(updated))
      .catch(() => {
        // Automatic titles are best-effort and must never interrupt the first reply.
      });
  }, [activeChat]);

  const generateTitleSuggestion = async () => {
    if (!activeChat) {
      return;
    }

    setTitleSuggestionLoading(true);
    setError(null);
    try {
      const suggestion: ChatTitleSuggestionDTO = await api.chats.titleSuggestion(activeChat.id);
      setTitleDraft(suggestion.title);
      setTitleEditing(true);
      setStatus(t("chat.titleSuggestionReady"));
      setTimeout(() => titleInputRef.current?.focus(), 0);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.titleSuggestionFailed"));
    } finally {
      setTitleSuggestionLoading(false);
    }
  };

  const replaceQueuedMessages = (messages: QueuedChatMessage[]) => {
    const next = messages.slice(0, MAX_QUEUED_MESSAGES);
    queuedMessagesRef.current = next;
    setQueuedMessages(next);
    if (queuedChatIdRef.current) {
      saveStoredChatQueue(queuedChatIdRef.current, next);
    }
  };

  const loadReadinessCharacters = async () => {
    const page = await api.characters.page({ page: 1, pageSize: 1 });
    setCharacterTotal(page.total);
    mergeCharacterCache(page.items);
  };

  const loadChat = async (id: string | null) => {
    const previousChatId = draftChatIdRef.current;
    if (previousChatId && previousChatId !== id) {
      saveStoredChatDraft(previousChatId, draft);
    }
    const previousQueueChatId = queuedChatIdRef.current;
    if (previousQueueChatId && previousQueueChatId !== id) {
      saveStoredChatQueue(previousQueueChatId, queuedMessagesRef.current);
    }

    if (!id) {
      draftChatIdRef.current = null;
      queuedChatIdRef.current = null;
      queuedMessagesRef.current = [];
      setDraft("");
      setQueuedMessages([]);
      setActiveChat(null);
      hasMessagesRef.current = false;
      setChatMemories([]);
      setAgentDraft(null);
      return;
    }

    draftChatIdRef.current = id;
    queuedChatIdRef.current = id;
    const storedQueue = readStoredChatQueue(id);
    queuedMessagesRef.current = storedQueue;
    setQueuedMessages(storedQueue);
    setDraft(readStoredChatDraft(id));
    const chat = await api.chats.get(id);
    setActiveChat(chat);
    setAgentDraft(null);
    setChatMemories(chat.memories ?? []);
    setAutoMemoryEnabled(chat.autoMemoryEnabled);
    hasMessagesRef.current = chat.messages.length > 0;
    setMemoryDraft(String(chat.memoryTurns));
    setMessagePage(1);
    setHighlightedMessageId(null);

    const pendingMessageJump = takeChatMessageJump(chat.id);
    if (pendingMessageJump) {
      setMessagePage(Math.max(1, Math.floor(pendingMessageJump.index / MESSAGES_PER_PAGE) + 1));
      setHighlightedMessageId(pendingMessageJump.messageId);
      setTimeout(() => {
        document
          .querySelector(`[data-message-id="${pendingMessageJump.messageId}"]`)
          ?.scrollIntoView({ block: "center", behavior: "smooth" });
      }, 50);
      window.setTimeout(() => {
        setHighlightedMessageId((current) =>
          current === pendingMessageJump.messageId ? null : current
        );
      }, 2400);
    }

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
    void loadReadinessCharacters().catch(() => {
      setCharacterTotal(null);
    });
  }, []);

  useEffect(() => {
    void loadChat(selectedChatId).catch((caught: unknown) => {
      const message = caught instanceof Error ? caught.message : t("chat.failedLoadChat");
      if (selectedChatId && /chat not found/i.test(message)) {
        onSelectChat(null);
        return;
      }
      setError(message);
    });
  }, [onSelectChat, selectedChatId, t]);

  useEffect(() => {
    if (!selectedChatId || draftChatIdRef.current !== selectedChatId) {
      return;
    }

    saveStoredChatDraft(selectedChatId, draft);
  }, [draft, selectedChatId]);

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
          setRuntimeSettings(settings);
          setAutoSummarizeUser(settings.autoSummarizeUser);
          setActiveProviderId(settings.activeProviderId || null);
          setActiveModelId(settings.activeModelId || null);
          setHasApiKey(settings.hasApiKey);
          useAppStore.getState().setShowMessageAvatars(settings.showMessageAvatars);
          useAppStore.getState().setShowMessageTimestamps(settings.showMessageTimestamps);
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

  const settingsToInput = (
    settings: PublicUserSettingsDTO,
    presets = settings.userPersonaPresets ?? []
  ): SettingsInput => ({
    activeProvider: settings.activeProvider,
    apiBaseUrl: settings.apiBaseUrl,
    model: settings.model,
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
    topP: settings.topP,
    language: settings.language,
    providers: settings.providers ?? [],
    activeProviderId: settings.activeProviderId ?? "",
    activeModelId: settings.activeModelId ?? "",
    moduleModelPreferences: settings.moduleModelPreferences ?? {},
    userPersonaPresets: presets,
    autoSummarizeUser: settings.autoSummarizeUser,
    showMessageAvatars: settings.showMessageAvatars,
    showMessageTimestamps: settings.showMessageTimestamps,
    ttsVoice: settings.ttsVoice,
    ttsPlaybackRate: settings.ttsPlaybackRate,
    ttsAutoPlay: settings.ttsAutoPlay,
    userProfileSummary: settings.userProfileSummary ?? ""
  });

  const refreshPersonaPresets = async () => {
    const settings = await api.settings.get();
    setUserPersonaPresets(settings.userPersonaPresets ?? []);
    return settings;
  };

  const savePersonaPreset = async () => {
    const name = personaPresetName.trim();
    const hasContent =
      editingPersonaDraft.prefix.trim() ||
      editingPersonaDraft.prompt.trim() ||
      editingPersonaDraft.suffix.trim();
    if (!name || !hasContent) {
      setError(t("chat.personaPresetInvalid"));
      return;
    }

    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const settings = await api.settings.get();
      const timestamp = new Date().toISOString();
      const nextPresets: UserPersonaPresetDTO[] = [
        ...(settings.userPersonaPresets ?? []),
        {
          id: generateId(),
          name,
          config: editingPersonaDraft,
          createdAt: timestamp,
          updatedAt: timestamp
        }
      ].slice(-30);
      const updated = await api.settings.update(settingsToInput(settings, nextPresets));
      setUserPersonaPresets(updated.userPersonaPresets ?? []);
      setPersonaPresetName("");
      setStatus(t("chat.personaPresetSaved"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.personaPresetFailed"));
    } finally {
      setLoading(false);
    }
  };

  const applyPersonaPreset = (preset: UserPersonaPresetDTO) => {
    setEditingPersonaDraft(preset.config);
    setStatus(t("chat.personaPresetApplied"));
  };

  const deletePersonaPreset = async (preset: UserPersonaPresetDTO) => {
    if (!window.confirm(t("chat.personaPresetDeleteConfirm", { name: preset.name }))) {
      return;
    }

    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const settings = await api.settings.get();
      const nextPresets = (settings.userPersonaPresets ?? []).filter((entry) => entry.id !== preset.id);
      const updated = await api.settings.update(settingsToInput(settings, nextPresets));
      setUserPersonaPresets(updated.userPersonaPresets ?? []);
      setStatus(t("chat.personaPresetDeleted"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.personaPresetFailed"));
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
    setPersonaPresetName("");
    setShowUserConfigDialog(true);
    setMemorySettingsOpen(false);
    void refreshPersonaPresets().catch((caught) => {
      setError(caught instanceof Error ? caught.message : t("chat.personaPresetFailed"));
    });
  };

  const openTranscriptExport = () => {
    if (!activeChat) return;
    setTranscriptFormat("markdown");
    setTranscriptIncludeTimestamps(true);
    setTranscriptExportedAt(new Date().toISOString());
    setShowExportDialog(true);
    setMemorySettingsOpen(false);
  };

  const downloadCurrentTranscript = async () => {
    if (!activeChat || !transcriptPreview) return;
    try {
      const date = new Date().toISOString().slice(0, 10);
      const extension = transcriptFormat === "markdown" ? "md" : "txt";
      const mimeType =
        transcriptFormat === "markdown"
          ? "text/markdown;charset=utf-8"
          : "text/plain;charset=utf-8";
      await saveTextFile(
        `chat-${safeChatTranscriptName(activeChat.title)}-${date}.${extension}`,
        transcriptPreview,
        mimeType
      );
      setStatus(t("chat.exportChatSuccess"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedExportChat"));
    }
  };

  const copyCurrentTranscript = async () => {
    if (!transcriptPreview) return;
    try {
      await navigator.clipboard.writeText(transcriptPreview);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = transcriptPreview;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    setStatus(t("chat.exportCopied"));
  };

  const cancelEditingUserConfig = () => {
    setShowUserConfigDialog(false);
    setEditingPersonaDraft(emptyUserCustomConfig());
    setPersonaPresetName("");
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

  const openAgentPanel = () => {
    setAgentPanelOpen(true);
    setMemorySettingsOpen(false);
  };

  const closeAgentPanel = () => {
    setAgentPanelOpen(false);
  };

  const getAgentModeLabel = (mode: ChatAgentMode) => {
    switch (mode) {
      case "scene_summary":
        return t("chat.agentModeSceneSummary");
      case "next_steps":
        return t("chat.agentModeNextSteps");
      case "reply_drafts":
        return t("chat.agentModeReplyDrafts");
      case "memory_lore_candidates":
        return t("chat.agentModeMemoryLore");
    }
  };

  const getAgentModeDescription = (mode: ChatAgentMode) => {
    switch (mode) {
      case "scene_summary":
        return t("chat.agentModeSceneSummaryHelp");
      case "next_steps":
        return t("chat.agentModeNextStepsHelp");
      case "reply_drafts":
        return t("chat.agentModeReplyDraftsHelp");
      case "memory_lore_candidates":
        return t("chat.agentModeMemoryLoreHelp");
    }
  };

  const runAgentDraft = async () => {
    if (!activeChat) {
      return;
    }

    setAgentLoading(true);
    setError(null);
    setStatus(null);
    try {
      const draftResult = await api.chats.agentDraft(activeChat.id, {
        mode: agentMode,
        focus: agentFocus.trim() || undefined
      });
      setAgentDraft(draftResult);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.agentFailed"));
    } finally {
      setAgentLoading(false);
    }
  };

  const insertAgentDraft = () => {
    if (!agentDraft?.content.trim()) {
      return;
    }

    setDraft(agentDraft.content.trim());
    requestAnimationFrame(autoResizeDraftTextArea);
  };

  const copyAgentDraft = async () => {
    if (!agentDraft?.content.trim()) {
      return;
    }

    try {
      await navigator.clipboard.writeText(agentDraft.content);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = agentDraft.content;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
    setStatus(t("chat.agentCopied"));
  };

  const runMessageSearch = async () => {
    if (!activeChat || !messageSearchQuery.trim()) {
      return;
    }

    setMessageSearchLoading(true);
    setError(null);
    try {
      const result = await api.chats.messageSearch(activeChat.id, messageSearchQuery.trim(), 30);
      setMessageSearchResult(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.searchFailed"));
    } finally {
      setMessageSearchLoading(false);
    }
  };

  const jumpToMessage = (message: MessageDTO, index: number) => {
    const targetPage = Math.max(1, Math.floor(index / MESSAGES_PER_PAGE) + 1);
    setMessagePage(targetPage);
    setHighlightedMessageId(message.id);
    setTimeout(() => {
      document
        .querySelector(`[data-message-id="${message.id}"]`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 50);
    window.setTimeout(() => {
      setHighlightedMessageId((current) => (current === message.id ? null : current));
    }, 2400);
  };

  const jumpToMessageSearchResult = (result: ChatMessageSearchDTO["results"][number]) => {
    setMessageSearchOpen(false);
    jumpToMessage(result.message, result.index);
  };

  const jumpToBookmarkedMessage = (message: MessageDTO, index: number) => {
    setShowBookmarksDialog(false);
    jumpToMessage(message, index);
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
      ...settingsToInput(runtimeSettings),
      activeProvider: provider.provider,
      apiBaseUrl: provider.apiBaseUrl,
      model: model.model,
      providers: settingsProviders,
      activeProviderId: providerId,
      activeModelId: modelId,
      autoSummarizeUser,
      showMessageAvatars,
      showMessageTimestamps
    };

    if (provider.key?.trim()) {
      payload.apiKey = provider.key.trim();
    }

    try {
      const updated = await api.settings.update(payload);
      setSettingsProviders(updated.providers ?? []);
      setActiveProviderId(updated.activeProviderId || null);
      setActiveModelId(updated.activeModelId || null);
      setRuntimeSettings(updated);
      useAppStore.getState().setShowMessageAvatars(updated.showMessageAvatars);
      useAppStore.getState().setShowMessageTimestamps(updated.showMessageTimestamps);
      setStatus(t("chat.modelSwitched", { label: model.label || model.model }));
    } catch (caught) {
      setActiveProviderId(previousProviderId);
      setActiveModelId(previousModelId);
      setError(caught instanceof Error ? caught.message : t("chat.failedUpdateMemory"));
    } finally {
      setModelSwitching(false);
    }
  };

  const startMessageGeneration = async (messageContent: string) => {
    if (!activeChat || !messageContent.trim()) {
      return;
    }

    const chatId = activeChat.id;
    const normalizedContent = messageContent.trim();
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
        chatId,
        content: normalizedContent
      };
      setActiveRequestId(requestId);
      setGenerationChatId(chatId);
      setStreamingContent("");
      setStreamingCharacterId(null);
      setStreamingContextCounts(null);
      streamingBufferRef.current = "";
      saveStoredChatDraft(chatId, "");
      setDraft("");
      requestAnimationFrame(() => {
        if (draftTextAreaRef.current) {
          draftTextAreaRef.current.style.height = "auto";
        }
      });
      sendWs(payload);
    } catch (caught) {
      if (draftChatIdRef.current === chatId) {
        setDraft((current) => current || normalizedContent);
      } else {
        saveStoredChatDraft(chatId, normalizedContent);
      }
      setError(caught instanceof Error ? caught.message : t("chat.failedSend"));
      setLoading(false);
      setActiveRequestId(null);
      setGenerationChatId(null);
      setStreamingContextCounts(null);
    } finally {
      // Loading ends when the WebSocket sends generation_done, generation_stopped, or error.
    }
  };

  const generateOpeningMessage = async () => {
    if (!activeChat || activeChat.messages.length > 0) {
      return;
    }

    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const message = await api.chats.openingMessage(activeChat.id);
      upsertMessage(message);
      hasMessagesRef.current = true;
      setIsNearBottom(true);
      requestAnimationFrame(() => scrollToBottom());
      setStatus(t("chat.openingGenerated"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedOpening"));
    } finally {
      setLoading(false);
    }
  };

  const queueDraftMessage = () => {
    if (!activeChat || !draft.trim()) {
      return;
    }
    if (queuedMessagesRef.current.length >= MAX_QUEUED_MESSAGES) {
      setError(t("chat.queueFull"));
      return;
    }

    const message: QueuedChatMessage = { id: generateId(), content: draft.trim() };
    replaceQueuedMessages([...queuedMessagesRef.current, message]);
    saveStoredChatDraft(activeChat.id, "");
    setDraft("");
    setStatus(t("chat.messageQueued"));
    requestAnimationFrame(() => {
      if (draftTextAreaRef.current) {
        draftTextAreaRef.current.style.height = "auto";
      }
    });
  };

  const sendMessage = async () => {
    if (!activeChat || !draft.trim()) {
      return;
    }
    if (activeRequestId) {
      queueDraftMessage();
      return;
    }
    if (loading) {
      return;
    }

    await startMessageGeneration(draft);
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

  const dispatchQueuedMessages = () => {
    if (
      !activeChat ||
      queuedChatIdRef.current !== activeChat.id ||
      queuedMessagesRef.current.length === 0
    ) {
      return;
    }

    const messageContent = queuedMessagesRef.current.map((message) => message.content).join("\n\n");
    replaceQueuedMessages([]);
    void startMessageGeneration(messageContent);
  };

  const sendQueuedMessagesNow = () => {
    if (queuedMessagesRef.current.length === 0) {
      return;
    }
    if (activeRequestId) {
      interruptForQueueRef.current = true;
      stopGeneration();
      return;
    }
    dispatchQueuedMessages();
  };

  const editQueuedMessage = (message: QueuedChatMessage) => {
    replaceQueuedMessages(queuedMessagesRef.current.filter((entry) => entry.id !== message.id));
    setDraft((current) => (current.trim() ? `${message.content}\n\n${current}` : message.content));
    requestAnimationFrame(() => draftTextAreaRef.current?.focus());
  };

  const deleteQueuedMessage = (messageId: string) => {
    replaceQueuedMessages(queuedMessagesRef.current.filter((entry) => entry.id !== messageId));
  };

  useEffect(() => {
    onMessageHandlersRef.current.dispatchQueuedMessages = dispatchQueuedMessages;
  }, [activeChat, isConnected]);

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
      setGenerationChatId(message.chatId);
      setStreamingContent("");
      setStreamingCharacterId(message.characterId);
      setStreamingContextCounts(null);
      streamingBufferRef.current = "";
      sendWs(payload);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedRegenerate"));
      setLoading(false);
      setActiveRequestId(null);
      setGenerationChatId(null);
      setStreamingContextCounts(null);
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

  const toggleMessageContext = async (message: MessageDTO) => {
    setLoading(true);
    setError(null);
    try {
      const updated = await api.messages.update(message.id, {
        contextIncluded: !message.contextIncluded
      });
      upsertMessage(updated);
      setStatus(
        updated.contextIncluded ? t("chat.messageIncludedInContext") : t("chat.messageExcludedFromContext")
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedUpdate"));
    } finally {
      setLoading(false);
    }
  };

  const toggleMessageBookmark = async (message: MessageDTO) => {
    try {
      const updated = await api.messages.update(message.id, {
        isBookmarked: !message.isBookmarked
      });
      upsertMessage(updated);
      setStatus(t(updated.isBookmarked ? "chat.messageBookmarked" : "chat.messageUnbookmarked"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedUpdate"));
    }
  };

  const continueMessage = async (message: MessageDTO) => {
    if (message.role !== "assistant" || !activeChat) {
      return;
    }

    const lastMessage = activeChat.messages[activeChat.messages.length - 1];
    if (lastMessage?.id !== message.id) {
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
        type: "continue",
        requestId,
        messageId: message.id
      };
      setActiveRequestId(requestId);
      setGenerationChatId(message.chatId);
      setStreamingContent("");
      setStreamingCharacterId(message.characterId);
      setStreamingContextCounts(null);
      streamingBufferRef.current = "";
      sendWs(payload);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedContinue"));
      setLoading(false);
      setActiveRequestId(null);
      setGenerationChatId(null);
      setStreamingContextCounts(null);
    }
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;

      const target = event.target as HTMLElement | null;
      const isComposer = target?.id === "chat-message-input";
      const isEditable =
        isComposer ||
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;

      if (event.key === "Escape" && activeRequestId) {
        event.preventDefault();
        stopGeneration();
        return;
      }

      if (isComposer && event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void sendMessage();
        return;
      }

      if (isEditable || event.key !== "Enter" || !event.altKey || !activeChat || activeRequestId) {
        return;
      }

      const latestAssistant = [...activeChat.messages]
        .reverse()
        .find((message) => message.role === "assistant");
      if (latestAssistant) {
        event.preventDefault();
        void continueMessage(latestAssistant);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeChat, activeRequestId, continueMessage, sendMessage, stopGeneration]);

  const loadStoryNavigator = async () => {
    setStoryNavigatorLoading(true);
    setStoryNavigatorError(null);
    try {
      setStoryChats(await api.chats.list());
    } catch (caught) {
      setStoryNavigatorError(
        caught instanceof Error ? caught.message : t("chat.storyLoadFailed")
      );
    } finally {
      setStoryNavigatorLoading(false);
    }
  };

  const openStoryNavigator = () => {
    setShowStoryNavigator(true);
    void loadStoryNavigator();
  };

  const navigateToStoryChat = (chatId: string) => {
    setShowStoryNavigator(false);
    onSelectChat(chatId);
  };

  const returnToParentChat = async () => {
    if (!activeChat?.parentChatId) {
      return;
    }

    const parentChatId = activeChat.parentChatId;
    const sourceMessageId = activeChat.branchSourceMessageId;
    setStoryNavigatorLoading(true);
    setStoryNavigatorError(null);

    try {
      const parentChat = await api.chats.get(parentChatId);
      if (sourceMessageId) {
        const sourceIndex = parentChat.messages.findIndex((message) => message.id === sourceMessageId);
        if (sourceIndex >= 0) {
          queueChatMessageJump({
            chatId: parentChatId,
            messageId: sourceMessageId,
            index: sourceIndex
          });
        }
      }
      setShowStoryNavigator(false);
      onSelectChat(parentChatId);
    } catch (caught) {
      setStoryNavigatorError(
        caught instanceof Error ? caught.message : t("chat.storyParentUnavailable")
      );
    } finally {
      setStoryNavigatorLoading(false);
    }
  };

  const createStoryCopy = async (
    message: MessageDTO,
    kind: "branch" | "checkpoint",
    title?: string
  ) => {
    if (!activeChat) {
      return;
    }

    const isCheckpoint = kind === "checkpoint";
    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const branch = await api.chats.branch(activeChat.id, {
        messageId: message.id,
        title: title?.trim() || `${activeChat.title} - ${isCheckpoint ? t("chat.checkpoint") : "Branch"}`,
        kind
      });
      onChatsChanged();
      if (isCheckpoint) {
        setStatus(t("chat.checkpointCreated"));
      } else {
        setActiveChat(branch);
        setChatMemories(branch.memories ?? []);
        hasMessagesRef.current = branch.messages.length > 0;
        setMemoryDraft(String(branch.memoryTurns));
        onSelectChat(branch.id);
        setStatus(language === "zh-CN" ? "已创建聊天分支。" : "Chat branch created.");
        setIsNearBottom(true);
        requestAnimationFrame(() => scrollToBottom());
      }
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : language === "zh-CN"
            ? isCheckpoint
              ? "创建检查点失败"
              : "创建聊天分支失败"
            : isCheckpoint
              ? "Failed to create checkpoint"
              : "Failed to create chat branch"
      );
    } finally {
      setLoading(false);
    }
  };

  const branchFromMessage = (message: MessageDTO) => createStoryCopy(message, "branch");

  const checkpointFromMessage = (message: MessageDTO) => {
    if (!activeChat) {
      return;
    }
    setPendingCheckpointMessage(message);
    setCheckpointTitleDraft(`${activeChat.title} - ${t("chat.checkpoint")}`);
  };

  const saveCheckpoint = () => {
    if (!pendingCheckpointMessage || !checkpointTitleDraft.trim()) {
      return;
    }
    const message = pendingCheckpointMessage;
    const title = checkpointTitleDraft.trim();
    setPendingCheckpointMessage(null);
    setCheckpointTitleDraft("");
    void createStoryCopy(message, "checkpoint", title);
  };

  const transcribeRecording = async (blob: Blob) => {
    setMediaLoading(true);
    setError(null);
    try {
      const text = (
        await api.media.transcribe({
          audioBase64: await blobToBase64(blob),
          mimeType: blob.type || "audio/webm",
          filename: "recording.webm"
        })
      ).text.trim();

      if (text) {
        setDraft((current) => (current.trim() ? `${current.trim()}\n${text}` : text));
        setStatus(t("chat.voiceTranscribed"));
        requestAnimationFrame(autoResizeDraftTextArea);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.voiceFailed"));
    } finally {
      setMediaLoading(false);
    }
  };

  const toggleVoiceRecording = async () => {
    if (recording) {
      mediaRecorderRef.current?.stop();
      return;
    }

    if (!canTranscribe) {
      openModuleModelSettings("voice_transcription");
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError(t("chat.voiceUnsupported"));
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      recordingChunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          recordingChunksRef.current.push(event.data);
        }
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        setRecording(false);
        const blob = new Blob(recordingChunksRef.current, {
          type: recorder.mimeType || "audio/webm"
        });
        if (blob.size > 0) {
          void transcribeRecording(blob);
        }
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecording(true);
      setStatus(t("chat.voiceRecording"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.voiceFailed"));
    }
  };

  const stopSpeechPlayback = useCallback(() => {
    const audio = speechAudioRef.current;
    speechAudioRef.current = null;
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
    }
    setSpeechPlaying(false);
    setSpeechMessageId(null);
  }, []);

  const playAssistantMessage = useCallback(async (message: MessageDTO) => {
    if (!canSpeak) {
      openModuleModelSettings("voice_speech");
      return;
    }

    setMediaLoading(true);
    setError(null);
    try {
      stopSpeechPlayback();
      const speech = await api.media.speech({
        text: message.content.slice(0, 4000),
        voice: runtimeSettings?.ttsVoice?.trim() || "alloy",
        format: "mp3"
      });
      const audio = new Audio(`data:${speech.mimeType};base64,${speech.audioBase64}`);
      audio.playbackRate = Math.min(
        2,
        Math.max(0.5, runtimeSettings?.ttsPlaybackRate ?? 1)
      );
      audio.onended = () => {
        if (speechAudioRef.current === audio) {
          speechAudioRef.current = null;
          setSpeechPlaying(false);
          setSpeechMessageId(null);
        }
      };
      audio.onerror = () => {
        if (speechAudioRef.current === audio) {
          speechAudioRef.current = null;
          setSpeechPlaying(false);
          setSpeechMessageId(null);
          setError(t("chat.voiceFailed"));
        }
      };
      speechAudioRef.current = audio;
      setSpeechPlaying(true);
      setSpeechMessageId(message.id);
      await audio.play();
      setStatus(t("chat.voicePlaying"));
    } catch (caught) {
      stopSpeechPlayback();
      setError(caught instanceof Error ? caught.message : t("chat.voiceFailed"));
    } finally {
      setMediaLoading(false);
    }
  }, [
    canSpeak,
    openModuleModelSettings,
    runtimeSettings?.ttsPlaybackRate,
    runtimeSettings?.ttsVoice,
    stopSpeechPlayback,
    t
  ]);

  const speakLatestAssistantMessage = async () => {
    const latestAssistant = [...(activeChat?.messages ?? [])]
      .reverse()
      .find((message) => message.role === "assistant" && message.content.trim());
    if (!latestAssistant) {
      setError(t("chat.voiceNoAssistant"));
      return;
    }
    await playAssistantMessage(latestAssistant);
  };

  useEffect(() => {
    onMessageHandlersRef.current.autoPlayAssistantMessage = (message) => {
      if (
        runtimeSettings?.ttsAutoPlay &&
        canSpeak &&
        !recording &&
        message.chatId === activeChat?.id
      ) {
        void playAssistantMessage(message);
      }
    };
  }, [activeChat?.id, canSpeak, playAssistantMessage, recording, runtimeSettings?.ttsAutoPlay]);

  useEffect(() => () => stopSpeechPlayback(), [activeChat?.id, stopSpeechPlayback]);

  useEffect(() => {
    if (
      speechMessageId &&
      !activeChat?.messages.some((message) => message.id === speechMessageId)
    ) {
      stopSpeechPlayback();
    }
  }, [activeChat?.messages, speechMessageId, stopSpeechPlayback]);

  const openImageDialog = () => {
    if (!canGenerateImage) {
      openModuleModelSettings("image_generation");
      return;
    }

    setGeneratedImagePreview(null);
    setShowImageDialog(true);
  };

  const generateImagePreview = async () => {
    if (!canGenerateImage || !imagePromptDraft.trim()) {
      return;
    }

    setMediaLoading(true);
    setError(null);
    try {
      const prompt = imagePromptDraft.trim();
      const result = await api.media.image({ prompt, size: imageSize });
      const image = result.images[0];
      if (!image) {
        throw new Error(t("chat.imageEmpty"));
      }
      const src = image.b64Json ? `data:${image.mimeType};base64,${image.b64Json}` : image.url;
      if (!src) {
        throw new Error(t("chat.imageEmpty"));
      }
      setGeneratedImagePreview({ prompt, src });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.imageFailed"));
    } finally {
      setMediaLoading(false);
    }
  };

  const insertGeneratedImage = () => {
    if (!generatedImagePreview) {
      return;
    }

    const markdown = `![${generatedImagePreview.prompt.replace(/\]/g, "")}](${generatedImagePreview.src})`;
    setDraft((current) => (current.trim() ? `${current.trim()}\n\n${markdown}` : markdown));
    setShowImageDialog(false);
    setGeneratedImagePreview(null);
    setStatus(t("chat.imageInserted"));
    requestAnimationFrame(autoResizeDraftTextArea);
  };

  const resendMessage = async (message: MessageDTO) => {
    if (!activeChat || !ensureChatGenerationReady()) {
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
        type: "resend",
        requestId,
        messageId: message.id
      };
      resendRequestRef.current = { requestId, messageId: message.id };
      setActiveRequestId(requestId);
      setGenerationChatId(message.chatId);
      setStreamingContent("");
      setStreamingCharacterId(null);
      setStreamingContextCounts(null);
      streamingBufferRef.current = "";
      setIsNearBottom(true);
      sendWs(payload);
      requestAnimationFrame(() => scrollToBottom());
    } catch (caught) {
      resendRequestRef.current = null;
      setError(caught instanceof Error ? caught.message : t("chat.failedSend"));
      setLoading(false);
      setActiveRequestId(null);
      setGenerationChatId(null);
      setStreamingContextCounts(null);
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

    const message = pendingDeleteMessage;

    setMessageDeleteLoading(true);
    setError(null);
    try {
      const result = await api.messages.removeTimeline(message.id);
      setPendingDeleteMessage(null);
      await loadChat(message.chatId);
      setStatus(
        result.disabledMemoryCount > 0
          ? t("chat.messagesDeletedWithMemoriesDisabled", {
              count: result.deletedCount,
              memories: result.disabledMemoryCount
            })
          : t("chat.messagesDeleted", { count: result.deletedCount })
      );
      if (showMemoryDialog) {
        void loadChatMemories();
      }
      setIsNearBottom(true);
      requestAnimationFrame(() => scrollToBottom());
    } catch (caught) {
      setPendingDeleteMessage(null);
      await loadChat(message.chatId).catch(() => {});
      setError(
        caught instanceof Error
          ? caught.message
          : t("chat.failedDeleteMessage")
      );
    } finally {
      setMessageDeleteLoading(false);
    }
  };

  const requestResendMessage = (message: MessageDTO) => {
    if (!activeChat || loading) {
      return;
    }

    if (!ensureChatGenerationReady()) {
      return;
    }

    const targetIndex = activeChat.messages.findIndex((item) => item.id === message.id);
    if (targetIndex >= 0 && targetIndex < activeChat.messages.length - 1) {
      setPendingResendMessage(message);
      return;
    }

    void resendMessage(message);
  };

  const branchAndResendMessage = async (message: MessageDTO) => {
    if (!activeChat || loading) {
      return;
    }

    if (!ensureChatGenerationReady()) {
      return;
    }

    const sourceChat = activeChat;
    const targetIndex = sourceChat.messages.findIndex((item) => item.id === message.id);
    const latestMessage = sourceChat.messages[sourceChat.messages.length - 1];
    if (targetIndex < 0 || !latestMessage) {
      setError(t("chat.resendBranchUnavailable"));
      return;
    }

    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const branch = await api.chats.branch(sourceChat.id, {
        messageId: latestMessage.id,
        title: `${sourceChat.title} - ${t("chat.branch")}`,
        kind: "branch"
      });
      const branchTarget = branch.messages[targetIndex];
      if (!branchTarget || branchTarget.role !== "user") {
        throw new Error(t("chat.resendBranchUnavailable"));
      }

      setPendingResendMessage(null);
      setActiveChat(branch);
      setChatMemories(branch.memories ?? []);
      hasMessagesRef.current = branch.messages.length > 0;
      setMemoryDraft(String(branch.memoryTurns));
      onChatsChanged();
      onSelectChat(branch.id);
      setIsNearBottom(true);
      resendMessage(branchTarget);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.resendBranchFailed"));
      setLoading(false);
    }
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
              <div className="flex items-center gap-1">
                <Button
                  aria-label={t("chat.readinessTitle")}
                  className={`!h-8 !min-h-8 !w-8 !p-0 ${
                    readinessIssueCount > 0 ? "text-amber-300" : "text-emerald-300"
                  }`}
                  data-testid="chat-readiness-trigger"
                  title={t("chat.readinessTitle")}
                  variant="ghost"
                  onClick={() => setShowReadinessDialog(true)}
                >
                  {readinessIssueCount > 0 ? <CircleAlert size={15} /> : <ListChecks size={15} />}
                </Button>
                {activeChat ? (
                  <>
                    <Button
                      aria-label={t("chat.storyPaths")}
                      className="!h-8 !min-h-8 !w-8 !p-0"
                      data-testid="chat-story-trigger"
                      title={t("chat.storyPaths")}
                      variant="ghost"
                      onClick={openStoryNavigator}
                    >
                      <GitBranch size={15} />
                    </Button>
                  <Button
                    aria-label={t("chat.searchMessages")}
                    className="!h-8 !min-h-8 !w-8 !p-0"
                    data-testid="chat-search-trigger"
                    title={t("chat.searchMessages")}
                    variant="ghost"
                    onClick={() => {
                      setMessageSearchOpen(true);
                      setMessageSearchResult(null);
                    }}
                  >
                    <Search size={15} />
                  </Button>
                  <Button
                    aria-label={t("chat.bookmarks")}
                    className="!h-8 !min-h-8 !w-8 !p-0"
                    data-testid="chat-bookmarks-trigger"
                    title={t("chat.bookmarks")}
                    variant="ghost"
                    onClick={() => setShowBookmarksDialog(true)}
                  >
                    <Bookmark size={15} />
                  </Button>
                  <Button
                    aria-label={t("chat.titleSuggestion")}
                    className="!h-8 !min-h-8 !w-8 !p-0"
                    data-testid="chat-title-suggestion-trigger"
                    disabled={titleSuggestionLoading || activeChat.messages.length === 0}
                    title={t("chat.titleSuggestion")}
                    variant="ghost"
                    onClick={() => void generateTitleSuggestion()}
                  >
                    <Sparkles size={15} />
                  </Button>
                  <Button
                    aria-label={t("chat.agentTitle")}
                    aria-pressed={agentPanelOpen}
                    className="!h-8 !min-h-8 !w-8 !p-0"
                    data-testid="chat-agent-trigger"
                    id="chat-agent-trigger"
                    title={t("chat.agentTitle")}
                    variant={agentPanelOpen ? "secondary" : "ghost"}
                    onClick={openAgentPanel}
                  >
                    <BrainCircuit size={15} />
                  </Button>
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
                      className="custom-scrollbar absolute right-0 top-10 z-20 max-h-80 w-60 overflow-y-auto rounded-lg border border-white/[0.1] bg-ink-800 p-2 shadow-xl shadow-black/45 sm:max-h-[calc(100dvh-22rem)]"
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
                          onClick={openTranscriptExport}
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
                  </>
                ) : null}
              </div>
            }
          >
            <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-md">
              {activeBackgroundUrl ? (
                <div className="pointer-events-none absolute inset-0">
                  <img
                    alt=""
                    aria-hidden="true"
                    className="h-full w-full object-cover"
                    src={activeBackgroundUrl}
                  />
                  <div className="absolute inset-0 bg-black/35" />
                  <div className="absolute inset-0 bg-black/45" />
                </div>
              ) : !activeChat ? (
                <div className="pointer-events-none absolute inset-0 bg-ink-950/35" />
              ) : null}

              <div className="relative z-10 flex min-h-0 flex-1 flex-col">
                {!activeChat ? (
                  <div id="chat-empty-state">
                    <EmptyState>
                      <div className="flex max-w-md flex-col items-center gap-3">
                        <p className="font-medium text-ink-200">{t("chat.selectOrCreate")}</p>
                        <p className="text-xs leading-5 text-ink-400">
                          {readinessIssueCount > 0
                            ? t("chat.readinessEmptyNeedsAction", { count: readinessIssueCount })
                            : t("chat.readinessEmptyReady")}
                        </p>
                        <div className="flex flex-wrap items-center justify-center gap-2">
                          <Button
                            className="!min-h-[40px]"
                            data-testid="chat-new-empty-action"
                            onClick={
                              hasAnyCharacter ? onNewChat : () => navigateToSection("characters")
                            }
                          >
                            <Plus size={15} />
                            {hasAnyCharacter
                              ? t("chat.newChat")
                              : t("chat.readinessOpenCharacters")}
                          </Button>
                          <Button
                            className="!min-h-[40px]"
                            data-testid="chat-readiness-empty-action"
                            variant="secondary"
                            onClick={() => setShowReadinessDialog(true)}
                          >
                            <ListChecks size={15} />
                            {t("chat.readinessOpen")}
                          </Button>
                        </div>
                      </div>
                    </EmptyState>
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
                            className="mx-auto max-w-3xl space-y-4 p-2 sm:space-y-6 sm:p-5"
                          id="chat-message-list"
                        >
                          {activeChat.messages.length > MESSAGES_PER_PAGE ? (
                            <div
                              id="chat-pagination"
                              data-testid="chat-message-pagination"
                              className="sticky top-0 z-10 -mx-2 -mt-2 mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.08] bg-ink-900/95 px-2 pb-2 pt-1.5 backdrop-blur-sm sm:-mx-5 sm:-mt-5 sm:mb-5 sm:gap-3 sm:px-5 sm:pb-3 sm:pt-5"
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
                              <EmptyState>
                                <div className="flex max-w-md flex-col items-center gap-3">
                                  <p className="font-medium text-ink-200">{t("chat.noMessages")}</p>
                                  <p className="text-xs leading-5 text-ink-400">
                                    {t("chat.openingHelp")}
                                  </p>
                                  <Button
                                    className="!min-h-[40px]"
                                    data-testid="chat-generate-opening"
                                    disabled={loading || Boolean(activeRequestId)}
                                    variant="secondary"
                                    onClick={() => void generateOpeningMessage()}
                                  >
                                    <Sparkles size={15} />
                                    {loading ? t("chat.openingGenerating") : t("chat.generateOpening")}
                                  </Button>
                                </div>
                              </EmptyState>
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
                              const messageShellClassName =
                                highlightedMessageId === message.id
                                  ? "rounded-lg ring-2 ring-ember-400/70 ring-offset-2 ring-offset-ink-950 transition"
                                  : "transition";
                              if (isErrorSystem) {
                                const errorText = message.content.slice(
                                  GENERATION_ERROR_PREFIX.length
                                );
                                const lastAssistant = [...activeChat.messages]
                                  .reverse()
                                  .find((m) => m.role === "assistant");
                                return (
                                  <div
                                    key={message.id}
                                    className={messageShellClassName}
                                    data-message-id={message.id}
                                  >
                                    <ErrorBubble
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
                                  </div>
                                );
                              }
                              if (isSystem) {
                                return (
                                  <div
                                    key={message.id}
                                    className={messageShellClassName}
                                    data-message-id={message.id}
                                  >
                                    <SystemNotification content={message.content} />
                                  </div>
                                );
                              }

                              if (isUser) {
                                return (
                                  <div
                                    key={message.id}
                                    className={messageShellClassName}
                                    data-message-id={message.id}
                                  >
                                    <UserMessageBubble
                                      message={message}
                                      showAvatar={showMessageAvatars}
                                      showTimestamp={showMessageTimestamps}
                                      onCopy={() => void copyMessage(message)}
                                      onToggleBookmark={() => void toggleMessageBookmark(message)}
                                      onToggleContext={() => void toggleMessageContext(message)}
                                      onBranch={() => void branchFromMessage(message)}
                                      onCheckpoint={() => void checkpointFromMessage(message)}
                                      onEdit={() => startEditingMessage(message)}
                                      onDelete={() => setPendingDeleteMessage(message)}
                                      onResend={() => requestResendMessage(message)}
                                    />
                                  </div>
                                );
                              }

                              return (
                                <div
                                  key={message.id}
                                  className={messageShellClassName}
                                  data-message-id={message.id}
                                >
                                  <AssistantMessageBubble
                                    message={message}
                                    avatar={character?.avatar}
                                    showAvatar={showMessageAvatars}
                                    showTimestamp={showMessageTimestamps}
                                    htmlCss={character?.htmlCss}
                                    tokenUsageFormatter={formatTokenUsage}
                                    onCopy={() => void copyMessage(message)}
                                    onSpeak={() => {
                                      if (speechPlaying && speechMessageId === message.id) {
                                        stopSpeechPlayback();
                                      } else {
                                        void playAssistantMessage(message);
                                      }
                                    }}
                                    onToggleBookmark={() => void toggleMessageBookmark(message)}
                                    onBranch={() => void branchFromMessage(message)}
                                    onCheckpoint={() => void checkpointFromMessage(message)}
                                    onToggleContext={() => void toggleMessageContext(message)}
                                    onContinue={() => void continueMessage(message)}
                                    onRegenerate={() => void regenerateMessage(message)}
                                    onEdit={() => startEditingMessage(message)}
                                    onDelete={() => setPendingDeleteMessage(message)}
                                    onVariantPrev={() => void switchVariant(message, -1)}
                                    onVariantNext={() => void switchVariant(message, 1)}
                                    onDebug={setDebugMessage}
                                    disableRegenerate={Boolean(activeRequestId)}
                                    disableSpeech={mediaLoading || recording}
                                    speechAvailable={canSpeak}
                                    speechPlaying={speechPlaying && speechMessageId === message.id}
                                    canContinue={
                                      activeChat.messages[activeChat.messages.length - 1]?.id === message.id
                                    }
                                    disableContinue={Boolean(activeRequestId)}
                                  />
                                </div>
                              );
                            })
                          )}
                          {activeRequestId &&
                          generationChatId === activeChat.id &&
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
                              contextSummary={
                                streamingContextCounts
                                  ? {
                                      loreCount: streamingContextCounts.lore,
                                      memoryCount: streamingContextCounts.memory
                                    }
                                  : undefined
                              }
                            />
                          ) : null}
                        </div>
                      )}
                      {!isNearBottom ? (
                        <button
                          id="chat-scroll-bottom"
                          type="button"
                          className="sticky bottom-3 z-20 mx-auto flex items-center gap-1.5 rounded-md border border-white/[0.1] bg-ink-800 px-3 py-1.5 text-xs font-medium text-ink-300 shadow-lg shadow-black/30 transition-colors hover:bg-ink-700 hover:text-ink-50"
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
                        className="mx-auto max-w-3xl rounded-lg border border-white/[0.1] bg-ink-950/95 p-1.5 shadow-xl shadow-black/30 sm:p-2 xl:bg-ink-950/70"
                        id="chat-composer"
                      >
                        {queuedMessages.length > 0 ? (
                          <div
                            className="mb-1.5 border-b border-white/5 px-1 pb-2"
                            data-testid="chat-message-queue"
                          >
                            <div className="mb-1 flex items-center justify-between gap-2">
                              <span className="text-xs font-medium text-slate-400">
                                {t("chat.queueCount", { count: queuedMessages.length })}
                              </span>
                              <button
                                className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-ember-300 transition-colors hover:bg-ember-500/10 hover:text-ember-200"
                                data-chat-action="queue-send-now"
                                title={
                                  activeRequestId ? t("chat.queueSendNow") : t("chat.queueSend")
                                }
                                type="button"
                                onClick={sendQueuedMessagesNow}
                              >
                                <Send size={15} />
                              </button>
                            </div>
                            <div className="max-h-28 space-y-1 overflow-y-auto">
                              {queuedMessages.map((message) => (
                                <div
                                  className="flex min-w-0 items-center gap-1 rounded-md bg-white/[0.035] px-2 py-1"
                                  data-chat-queue-item=""
                                  data-queue-id={message.id}
                                  key={message.id}
                                >
                                  <p className="min-w-0 flex-1 truncate text-xs text-slate-300">
                                    {message.content}
                                  </p>
                                  <button
                                    className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-slate-500 transition-colors hover:bg-white/10 hover:text-slate-200"
                                    data-chat-action="queue-edit"
                                    title={t("chat.queueEdit")}
                                    type="button"
                                    onClick={() => editQueuedMessage(message)}
                                  >
                                    <Pencil size={13} />
                                  </button>
                                  <button
                                    className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-slate-500 transition-colors hover:bg-rose-500/10 hover:text-rose-300"
                                    data-chat-action="queue-delete"
                                    title={t("chat.queueDelete")}
                                    type="button"
                                    onClick={() => deleteQueuedMessage(message.id)}
                                  >
                                    <Trash2 size={13} />
                                  </button>
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : null}
                        <div className="mb-1 flex items-center gap-1 px-1">
                          <button
                            className={`grid h-9 w-9 place-items-center rounded-md transition-colors ${
                              recording
                                ? "bg-rose-500/15 text-rose-300"
                                : canTranscribe
                                  ? "text-slate-500 hover:bg-white/10 hover:text-slate-200"
                                  : "text-amber-300/80 hover:bg-amber-500/10 hover:text-amber-200"
                            } disabled:opacity-40`}
                            data-chat-action="voice-record"
                            disabled={mediaLoading}
                            aria-label={
                              recording
                                ? t("chat.voiceStop")
                                : canTranscribe
                                  ? t("chat.voiceRecord")
                                  : t("chat.voiceRecordSetup")
                            }
                            title={
                              recording
                                ? t("chat.voiceStop")
                                : canTranscribe
                                  ? t("chat.voiceRecord")
                                  : t("chat.voiceRecordSetup")
                            }
                            type="button"
                            onClick={() => void toggleVoiceRecording()}
                          >
                            <Mic size={16} />
                          </button>
                          <button
                            className={`grid h-9 w-9 place-items-center rounded-md transition-colors disabled:opacity-40 ${
                              speechPlaying
                                ? "bg-ember-500/15 text-ember-300 hover:bg-ember-500/20"
                                : canSpeak
                                  ? "text-slate-500 hover:bg-white/10 hover:text-slate-200"
                                  : "text-amber-300/80 hover:bg-amber-500/10 hover:text-amber-200"
                            }`}
                            data-chat-action="voice-speak"
                            disabled={mediaLoading || recording}
                            aria-label={
                              speechPlaying
                                ? t("chat.voiceStopPlayback")
                                : canSpeak
                                  ? t("chat.voiceSpeak")
                                  : t("chat.voiceSpeakSetup")
                            }
                            title={
                              speechPlaying
                                ? t("chat.voiceStopPlayback")
                                : canSpeak
                                  ? t("chat.voiceSpeak")
                                  : t("chat.voiceSpeakSetup")
                            }
                            type="button"
                            onClick={() => {
                              if (speechPlaying) {
                                stopSpeechPlayback();
                              } else {
                                void speakLatestAssistantMessage();
                              }
                            }}
                          >
                            {speechPlaying ? <VolumeX size={16} /> : <Volume2 size={16} />}
                          </button>
                          <button
                            className={`grid h-9 w-9 place-items-center rounded-md transition-colors disabled:opacity-40 ${
                              canGenerateImage
                                ? "text-ink-500 hover:bg-white/[0.06] hover:text-ink-200"
                                : "text-amber-300/80 hover:bg-amber-500/10 hover:text-amber-200"
                            }`}
                            data-chat-action="image-generate"
                            disabled={mediaLoading || recording}
                            aria-label={
                              canGenerateImage
                                ? t("chat.imageGenerate")
                                : t("chat.imageGenerateSetup")
                            }
                            title={
                              canGenerateImage
                                ? t("chat.imageGenerate")
                                : t("chat.imageGenerateSetup")
                            }
                            type="button"
                            onClick={openImageDialog}
                          >
                            <Image size={16} />
                          </button>
                          {mediaLoading ? (
                            <span className="ml-1 text-xs text-slate-500">{t("chat.mediaWorking")}</span>
                          ) : null}
                        </div>
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
                            <div className="flex items-center gap-1.5">
                              <button
                                className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-rose-600 text-white transition-colors hover:bg-rose-500 sm:h-11 sm:w-11"
                                data-chat-action="stop"
                                title={t("chat.stop")}
                                type="button"
                                onClick={stopGeneration}
                              >
                                <StopCircle size={17} />
                              </button>
                              <Button
                                className="!min-h-[40px] sm:!min-h-[44px]"
                                data-chat-action="queue"
                                disabled={
                                  !draft.trim() || queuedMessages.length >= MAX_QUEUED_MESSAGES
                                }
                                id="chat-primary-action"
                                onClick={queueDraftMessage}
                              >
                                <Send size={16} />
                                {t("chat.queue")}
                              </Button>
                            </div>
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
          {activeChat && agentPanelOpen ? (
            <>
              <button
                aria-label={t("chat.agentClose")}
                className="fixed inset-0 z-40 bg-black/45 sm:hidden"
                type="button"
                onClick={closeAgentPanel}
              />
              <aside
                aria-label={t("chat.agentTitle")}
                className="fixed inset-x-0 bottom-0 z-50 flex max-h-[82dvh] min-h-[420px] flex-col rounded-t-lg border border-white/[0.1] bg-ink-900 p-3 shadow-2xl shadow-black/60 sm:inset-x-auto sm:bottom-4 sm:right-4 sm:top-24 sm:w-[420px] sm:max-h-none sm:min-h-0 sm:rounded-lg sm:p-4"
                data-testid="chat-agent-panel"
              >
                <div className="flex items-start justify-between gap-3 border-b border-white/10 pb-3">
                  <div className="min-w-0">
                    <h4 className="text-sm font-semibold text-slate-100">
                      {t("chat.agentTitle")}
                    </h4>
                    <p className="mt-1 text-xs leading-5 text-slate-400">
                      {t("chat.agentHelp")}
                    </p>
                  </div>
                  <button
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-500 transition-colors hover:bg-white/10 hover:text-slate-200"
                    type="button"
                    aria-label={t("chat.agentClose")}
                    onClick={closeAgentPanel}
                  >
                    <X size={16} />
                  </button>
                </div>

                <div className="custom-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto py-4 pr-1">
                  <div className="grid grid-cols-2 gap-2" role="group" aria-label={t("chat.agentMode")}>
                    {agentModes.map((mode) => {
                      const selected = mode === agentMode;
                      return (
                        <button
                          key={mode}
                          className={`min-h-[72px] rounded-lg border px-3 py-2 text-left transition-colors ${
                            selected
                              ? "border-ember-500/40 bg-ember-500/15 text-ember-100"
                              : "border-white/10 bg-white/[0.03] text-slate-300 hover:border-white/20 hover:bg-white/[0.06]"
                          }`}
                          type="button"
                          onClick={() => setAgentMode(mode)}
                        >
                          <span className="block text-xs font-semibold">
                            {getAgentModeLabel(mode)}
                          </span>
                          <span className="mt-1 block text-[11px] leading-4 text-slate-500">
                            {getAgentModeDescription(mode)}
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  <div className="space-y-2">
                    <p className="text-xs font-semibold text-slate-300">{t("chat.agentFocus")}</p>
                    <TextArea
                      className="!h-24"
                      maxLength={1000}
                      placeholder={t("chat.agentFocusPlaceholder")}
                      value={agentFocus}
                      onChange={(event) => setAgentFocus(event.target.value)}
                    />
                  </div>

                  <Button
                    className="w-full"
                    data-testid="chat-agent-run"
                    disabled={agentLoading}
                    onClick={() => void runAgentDraft()}
                  >
                    <Sparkles size={16} />
                    {agentLoading ? t("chat.agentRunning") : t("chat.agentRun")}
                  </Button>

                  <div className="min-h-[180px] rounded-lg border border-white/10 bg-ink-950/50 p-3">
                    {agentDraft ? (
                      <div className="space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <p className="text-sm font-semibold text-slate-100">
                              {getAgentModeLabel(agentDraft.mode)}
                            </p>
                            <p className="mt-1 text-xs text-slate-500">
                              {t("chat.agentContextCounts", {
                                lore: agentDraft.matchedLoreEntries.length,
                                memory: agentDraft.matchedMemoryEntries.length
                              })}
                            </p>
                          </div>
                          <div className="flex gap-1">
                            <button
                              className="grid h-8 w-8 place-items-center rounded-lg text-slate-500 transition-colors hover:bg-white/10 hover:text-slate-200"
                              type="button"
                              title={t("common.copy")}
                              onClick={() => void copyAgentDraft()}
                            >
                              <Clipboard size={14} />
                            </button>
                            <button
                              className="grid h-8 w-8 place-items-center rounded-lg text-slate-500 transition-colors hover:bg-white/10 hover:text-slate-200"
                              type="button"
                              title={t("chat.agentInsert")}
                              onClick={insertAgentDraft}
                            >
                              <Send size={14} />
                            </button>
                          </div>
                        </div>
                        <div className="custom-scrollbar max-h-[34dvh] overflow-y-auto whitespace-pre-wrap break-words text-sm leading-6 text-slate-200 sm:max-h-none">
                          {agentDraft.content}
                        </div>
                      </div>
                    ) : (
                      <div className="flex h-full min-h-[150px] items-center justify-center text-center text-sm leading-6 text-slate-500">
                        {t("chat.agentEmpty")}
                      </div>
                    )}
                  </div>
                </div>
              </aside>
            </>
          ) : null}
        </div>
      </div>
      {showStoryNavigator && activeChat ? (
        <Modal
          panelClassName="max-w-2xl"
          title={t("chat.storyPaths")}
          onClose={() => setShowStoryNavigator(false)}
        >
          <ChatStoryNavigator
            activeChat={activeChat}
            chats={storyChats}
            error={storyNavigatorError}
            loading={storyNavigatorLoading}
            onNavigate={navigateToStoryChat}
            onRetry={() => void loadStoryNavigator()}
            onReturnToParent={() => void returnToParentChat()}
          />
        </Modal>
      ) : null}
      {editingMessage ? (
        <div className="animate-fade-in fixed inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-sm p-4">
          <section
            aria-labelledby="edit-message-title"
            className="animate-scale-in max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-white/10 bg-ink-900 p-6 shadow-xl shadow-black/45"
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
      {pendingCheckpointMessage ? (
        <Modal
          title={t("chat.saveCheckpoint")}
          onClose={() => {
            if (!loading) {
              setPendingCheckpointMessage(null);
              setCheckpointTitleDraft("");
            }
          }}
        >
          <div className="space-y-4">
            <TextInput
              autoFocus
              aria-label={t("chat.title")}
              value={checkpointTitleDraft}
              onChange={(event) => setCheckpointTitleDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  saveCheckpoint();
                }
              }}
            />
            <div className="flex justify-end gap-3">
              <Button
                disabled={loading}
                variant="ghost"
                onClick={() => {
                  setPendingCheckpointMessage(null);
                  setCheckpointTitleDraft("");
                }}
              >
                {t("common.cancel")}
              </Button>
              <Button disabled={loading || !checkpointTitleDraft.trim()} onClick={saveCheckpoint}>
                <Save size={15} />
                {t("chat.saveCheckpoint")}
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}
      {pendingDeleteMessage ? (
        <ConfirmDialog
          cancelLabel={t("common.cancel")}
          confirmLabel={
            (pendingDeleteImpact?.total ?? 1) > 1
              ? t("chat.deleteMessagesConfirmLabel", {
                  count: pendingDeleteImpact?.total ?? 1
                })
              : t("common.delete")
          }
          loading={messageDeleteLoading}
          message={
            <span className="block">
              <span className="block" data-testid="delete-message-impact">
                {pendingDeleteMessage.role === "user"
                  ? pendingDeleteImpact?.following === 1
                    ? t("chat.deleteUserMessageCascadeConfirmOne", {
                        total: pendingDeleteImpact?.total ?? 1
                      })
                    : (pendingDeleteImpact?.following ?? 0) > 1
                      ? t("chat.deleteUserMessageCascadeConfirmMany", {
                          following: pendingDeleteImpact?.following ?? 0,
                          total: pendingDeleteImpact?.total ?? 1
                        })
                      : t("chat.deleteUserMessageConfirm")
                  : t("chat.deleteAssistantMessageConfirm")}
              </span>
              <span
                className="mt-3 block rounded-md border border-white/[0.08] bg-ink-950/55 px-3 py-2.5"
                data-testid="delete-message-preview"
              >
                <span className="block text-[11px] font-semibold uppercase text-ink-500">
                  {pendingDeleteMessage.role === "user"
                    ? t("chat.userMessageLabel")
                    : t("chat.assistantMessageLabel")}
                </span>
                <span className="mt-1 block break-words text-sm leading-5 text-ink-200">
                  {pendingDeleteImpact?.preview || t("chat.emptyMessagePreview")}
                </span>
              </span>
            </span>
          }
          title={t("chat.deleteMessageTitle")}
          onCancel={() => setPendingDeleteMessage(null)}
          onConfirm={() => void deleteMessage()}
          variant="danger"
        />
      ) : null}
      {pendingResendMessage ? (
        <ConfirmDialog
          cancelLabel={t("common.cancel")}
          confirmLabel={t("chat.resendConfirmLabel")}
          secondaryLabel={t("chat.resendCreateBranchLabel")}
          loading={loading}
          message={
            <span className="block">
              <span className="block" data-testid="resend-message-impact">
                {pendingResendImpact?.following === 1
                  ? t("chat.resendConfirmOne")
                  : t("chat.resendConfirmMany", {
                      count: pendingResendImpact?.following ?? 0
                    })}
              </span>
              <span
                className="mt-3 block rounded-md border border-white/[0.08] bg-ink-950/55 px-3 py-2.5"
                data-testid="resend-message-preview"
              >
                <span className="block text-[11px] font-semibold uppercase text-ink-500">
                  {t("chat.userMessageLabel")}
                </span>
                <span className="mt-1 block break-words text-sm leading-5 text-ink-200">
                  {pendingResendImpact?.preview || t("chat.emptyMessagePreview")}
                </span>
              </span>
            </span>
          }
          title={t("chat.resendConfirmTitle")}
          onCancel={() => setPendingResendMessage(null)}
          onSecondary={() => void branchAndResendMessage(pendingResendMessage)}
          onConfirm={() => {
            const message = pendingResendMessage;
            setPendingResendMessage(null);
            void resendMessage(message);
          }}
          variant="danger"
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
      {messageSearchOpen ? (
        <Modal title={t("chat.searchMessages")} onClose={() => setMessageSearchOpen(false)}>
          <div className="space-y-4">
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
              <TextInput
                autoFocus
                aria-label={t("chat.searchMessages")}
                placeholder={t("chat.searchPlaceholder")}
                value={messageSearchQuery}
                onChange={(event) => setMessageSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void runMessageSearch();
                  }
                }}
              />
              <Button
                className="!min-h-[40px]"
                disabled={messageSearchLoading || !messageSearchQuery.trim()}
                type="button"
                onClick={() => void runMessageSearch()}
              >
                <Search size={15} />
                {messageSearchLoading ? t("chat.searching") : t("chat.searchRun")}
              </Button>
            </div>
            {messageSearchResult ? (
              <div className="space-y-3" data-testid="chat-search-results">
                <p className="text-xs text-slate-500">
                  {t("chat.searchSummary", {
                    total: messageSearchResult.total,
                    shown: messageSearchResult.results.length
                  })}
                </p>
                {messageSearchResult.results.length ? (
                  <div className="grid gap-2">
                    {messageSearchResult.results.map((result) => {
                      const roleLabel =
                        result.message.role === "assistant"
                          ? t("chat.searchAssistant")
                          : result.message.role === "system"
                            ? t("chat.searchSystem")
                            : t("chat.searchUser");
                      return (
                        <button
                          key={result.message.id}
                          className="rounded-lg border border-white/10 bg-ink-800/65 p-3 text-left transition hover:border-ember-400/50 hover:bg-ember-500/[0.08]"
                          data-testid="chat-search-result"
                          type="button"
                          onClick={() => jumpToMessageSearchResult(result)}
                        >
                          <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                            <span className="font-semibold text-slate-300">{roleLabel}</span>
                            <span>
                              {t("chat.searchPosition", { index: result.index + 1 })}
                            </span>
                          </div>
                          <p className="whitespace-pre-wrap break-words text-sm leading-6 text-slate-200">
                            {result.snippet}
                          </p>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-sm text-slate-500">{t("chat.searchEmpty")}</p>
                )}
              </div>
            ) : (
              <p className="text-sm text-slate-500">{t("chat.searchHelp")}</p>
            )}
          </div>
        </Modal>
      ) : null}
      {showBookmarksDialog ? (
        <Modal title={t("chat.bookmarks")} onClose={() => setShowBookmarksDialog(false)}>
          <div className="space-y-4" data-testid="chat-bookmarks-dialog">
            <p className="text-sm leading-6 text-slate-400">{t("chat.bookmarksHelp")}</p>
            {bookmarkedMessages.length ? (
              <div className="grid gap-2">
                {bookmarkedMessages.map(({ message, index }) => {
                  const roleLabel =
                    message.role === "assistant"
                      ? t("chat.searchAssistant")
                      : message.role === "system"
                        ? t("chat.searchSystem")
                        : t("chat.searchUser");
                  return (
                    <button
                      key={message.id}
                      className="rounded-lg border border-white/10 bg-ink-800/65 p-3 text-left transition hover:border-ember-400/50 hover:bg-ember-500/[0.08]"
                      data-testid="chat-bookmark-result"
                      type="button"
                      onClick={() => jumpToBookmarkedMessage(message, index)}
                    >
                      <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                        <Bookmark className="text-ember-300" fill="currentColor" size={13} />
                        <span className="font-semibold text-slate-300">{roleLabel}</span>
                        <span>{t("chat.bookmarkedAt", { index: index + 1 })}</span>
                      </div>
                      <p className="line-clamp-3 whitespace-pre-wrap break-words text-sm leading-6 text-slate-200">
                        {message.content}
                      </p>
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-slate-500">{t("chat.bookmarksEmpty")}</p>
            )}
          </div>
        </Modal>
      ) : null}
      {showExportDialog ? (
        <Modal title={t("chat.exportTranscriptTitle")} onClose={() => setShowExportDialog(false)}>
          <div className="space-y-4" data-testid="chat-export-dialog">
            <div
              aria-label={t("chat.exportFormat")}
              className="grid grid-cols-2 rounded-lg bg-white/[0.04] p-1"
              role="group"
            >
              {(["markdown", "text"] as const).map((format) => (
                <button
                  aria-pressed={transcriptFormat === format}
                  className={`min-h-9 rounded-md px-3 text-sm font-medium transition-colors ${
                    transcriptFormat === format
                      ? "bg-ember-500/15 text-ember-200"
                      : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
                  }`}
                  data-chat-export-format={format}
                  key={format}
                  type="button"
                  onClick={() => setTranscriptFormat(format)}
                >
                  {t(format === "markdown" ? "chat.exportMarkdown" : "chat.exportPlainText")}
                </button>
              ))}
            </div>
            <label className="flex min-h-10 cursor-pointer items-center gap-3 text-sm text-slate-300">
              <input
                checked={transcriptIncludeTimestamps}
                className="h-4 w-4 accent-ember-500"
                type="checkbox"
                onChange={(event) => setTranscriptIncludeTimestamps(event.target.checked)}
              />
              {t("chat.exportIncludeTimestamps")}
            </label>
            <textarea
              aria-label={t("chat.exportPreview")}
              className="custom-scrollbar h-64 w-full resize-none rounded-lg border border-white/10 bg-ink-950/70 p-3 font-mono text-xs leading-5 text-slate-300 outline-none"
              readOnly
              value={transcriptPreview}
            />
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="secondary" onClick={() => void copyCurrentTranscript()}>
                <Clipboard size={15} />
                {t("chat.exportCopy")}
              </Button>
              <Button
                data-chat-action="export-download"
                type="button"
                onClick={() => void downloadCurrentTranscript()}
              >
                <Download size={15} />
                {t("chat.exportDownload")}
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}
      {showUserConfigDialog ? (
        <Modal title={t("chat.userConfigTitle")} onClose={cancelEditingUserConfig}>
          <div className="space-y-4">
            <p className="whitespace-pre-line break-words text-xs leading-5 text-slate-400">
              {t("chat.userConfigHelp")}
            </p>
            <div
              className="space-y-3 rounded-lg border border-white/10 bg-ink-950/35 p-4"
              data-testid="persona-presets"
            >
              <div>
                <p className="text-sm font-semibold text-slate-200">
                  {t("chat.personaPresetsTitle")}
                </p>
                <p className="mt-1 text-xs leading-5 text-slate-500">
                  {t("chat.personaPresetsHelp")}
                </p>
              </div>
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                <TextInput
                  aria-label={t("chat.personaPresetName")}
                  placeholder={t("chat.personaPresetName")}
                  value={personaPresetName}
                  onChange={(event) => setPersonaPresetName(event.target.value)}
                />
                <Button
                  className="!min-h-[40px]"
                  disabled={loading}
                  type="button"
                  variant="secondary"
                  onClick={() => void savePersonaPreset()}
                >
                  <Plus size={15} />
                  {t("chat.personaPresetSave")}
                </Button>
              </div>
              {userPersonaPresets.length ? (
                <div className="grid gap-2">
                  {userPersonaPresets.map((preset) => (
                    <div
                      key={preset.id}
                      className="flex flex-col gap-3 rounded-lg border border-white/10 bg-ink-950/40 p-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-slate-100">{preset.name}</p>
                        <p className="mt-1 break-words text-xs leading-5 text-slate-500">
                          {preset.config.prompt ||
                            preset.config.prefix ||
                            preset.config.suffix ||
                            t("chat.userConfigEmpty")}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Button
                          className="!min-h-[34px] text-xs"
                          type="button"
                          variant="ghost"
                          onClick={() => applyPersonaPreset(preset)}
                        >
                          {t("chat.personaPresetApply")}
                        </Button>
                        <button
                          aria-label={t("chat.personaPresetDelete", { name: preset.name })}
                          className="grid h-8 w-8 place-items-center rounded-lg text-rose-400 transition-colors hover:bg-rose-500/15"
                          disabled={loading}
                          type="button"
                          onClick={() => void deletePersonaPreset(preset)}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-slate-500">{t("chat.personaPresetEmpty")}</p>
              )}
            </div>
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
              <div className="rounded-lg border border-white/10 bg-ink-950/40 p-4">
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
      {showImageDialog ? (
        <Modal
          title={t("chat.imageGenerate")}
          onClose={() => {
            if (!mediaLoading) {
              setShowImageDialog(false);
              setGeneratedImagePreview(null);
            }
          }}
          panelClassName="max-w-2xl"
        >
          <div className="space-y-4" data-testid="chat-image-dialog">
            <p className="text-xs leading-5 text-slate-400">{t("chat.imagePromptHelp")}</p>
            <TextArea
              className="min-h-28"
              maxLength={4000}
              placeholder={t("chat.imagePrompt")}
              value={imagePromptDraft}
              onChange={(event) => {
                setImagePromptDraft(event.target.value);
                setGeneratedImagePreview(null);
              }}
            />
            <label className="block space-y-1.5 text-sm font-medium text-slate-300">
              <span>{t("chat.imageSize")}</span>
              <select
                className="chat-input w-full"
                value={imageSize}
                onChange={(event) => {
                  setImageSize(event.target.value as "1024x1024" | "1024x1536" | "1536x1024" | "auto");
                  setGeneratedImagePreview(null);
                }}
              >
                <option value="1024x1024">1:1 (1024 x 1024)</option>
                <option value="1024x1536">2:3 (1024 x 1536)</option>
                <option value="1536x1024">3:2 (1536 x 1024)</option>
                <option value="auto">{t("common.auto")}</option>
              </select>
            </label>
            <div className="overflow-hidden rounded-lg border border-white/10 bg-ink-950/60">
              {generatedImagePreview ? (
                <img
                  alt={generatedImagePreview.prompt}
                  className="max-h-[52dvh] w-full object-contain"
                  data-testid="chat-image-preview"
                  src={generatedImagePreview.src}
                />
              ) : (
                <div className="flex min-h-48 items-center justify-center px-6 text-center text-sm text-slate-500">
                  {t("chat.imagePreviewEmpty")}
                </div>
              )}
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                className="!min-h-[36px]"
                disabled={mediaLoading}
                variant="ghost"
                onClick={() => {
                  setShowImageDialog(false);
                  setGeneratedImagePreview(null);
                }}
              >
                {t("common.cancel")}
              </Button>
              {generatedImagePreview ? (
                <Button
                  className="!min-h-[36px]"
                  data-testid="chat-image-insert"
                  disabled={mediaLoading}
                  onClick={insertGeneratedImage}
                >
                  {t("chat.imageInsert")}
                </Button>
              ) : null}
              <Button
                className="!min-h-[36px]"
                data-testid="chat-image-generate"
                disabled={mediaLoading || !imagePromptDraft.trim()}
                variant={generatedImagePreview ? "secondary" : "primary"}
                onClick={() => void generateImagePreview()}
              >
                <Image size={15} />
                {generatedImagePreview ? t("chat.imageRegenerate") : t("chat.imageGenerate")}
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}
      {showMemoryDialog ? (
        <Modal title={t("chat.memorySettings")} onClose={closeMemoryDialog}>
          <div className="space-y-6">
            <div className="rounded-lg border border-white/10 bg-ink-950/30 p-4">
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
                <div className="space-y-3 rounded-lg border border-ember-500/20 bg-ember-500/[0.04] p-4">
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
                <div className="rounded-lg border border-dashed border-white/10 bg-ink-950/25 px-4 py-6 text-center text-sm text-slate-500">
                  {t("chat.memoryEmpty")}
                </div>
              ) : (
                <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
                  {chatMemories.map((memory) => (
                    <div
                      key={memory.id}
                      className={`rounded-lg border p-3 ${
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
                            <span
                              className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                                memory.embeddingUpdatedAt
                                  ? "bg-cyan-500/15 text-cyan-300"
                                  : "bg-white/10 text-slate-400"
                              }`}
                              title={memory.embeddingModel ?? undefined}
                            >
                              {t(
                                memory.embeddingUpdatedAt
                                  ? "chat.memoryVectorReady"
                                  : "chat.memoryKeywordOnly"
                              )}
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
                            data-chat-memory-action="delete"
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
      {showReadinessDialog ? (
        <Modal
          title={t("chat.readinessTitle")}
          onClose={() => setShowReadinessDialog(false)}
          panelClassName="max-w-xl"
        >
          <div className="space-y-4" data-testid="chat-readiness-dialog">
            <p className="text-sm leading-6 text-slate-400">{t("chat.readinessHelp")}</p>
            <div className="grid gap-2">
              {readinessItems.map((item) => (
                <div
                  key={item.id}
                  className={`flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between ${
                    item.ready
                      ? "border-emerald-500/20 bg-emerald-500/[0.04]"
                      : "border-amber-500/25 bg-amber-500/[0.05]"
                  }`}
                  data-readiness-item={item.id}
                >
                  <div className="flex min-w-0 gap-3">
                    <span
                      className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg ${
                        item.ready
                          ? "bg-emerald-500/15 text-emerald-300"
                          : "bg-amber-500/15 text-amber-300"
                      }`}
                    >
                      {item.ready ? <Check size={15} /> : <CircleAlert size={15} />}
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-100">{item.title}</p>
                      <p className="mt-1 text-xs leading-5 text-slate-400">{item.detail}</p>
                    </div>
                  </div>
                  {!item.ready && item.onAction ? (
                    <Button
                      className="!min-h-[38px] shrink-0 text-xs"
                      data-readiness-action={item.id}
                      variant="secondary"
                      onClick={item.onAction}
                    >
                      {item.actionLabel}
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
            <div className="rounded-lg border border-white/10 bg-ink-950/35 p-3 text-xs leading-5 text-slate-500">
              {readinessIssueCount > 0
                ? t("chat.readinessFooterNeedsAction", { count: readinessIssueCount })
                : t("chat.readinessFooterReady")}
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
