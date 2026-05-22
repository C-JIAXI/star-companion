import {
  ChevronLeft,
  ChevronRight,
  Check,
  Copy,
  MessageSquarePlus,
  RefreshCw,
  RotateCcw,
  Send,
  Settings,
  Sparkles,
  StopCircle,
  Trash2,
  UserRound,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { api } from "../lib/api";
import { generateId } from "../lib/uuid";
import type {
  CharacterDTO,
  ChatDTO,
  ChatMode,
  ChatWithMessagesDTO,
  GenerationClientMessage,
  GenerationServerMessage,
  LorebookDTO,
  MessageDTO,
  ModelPreset,
  TokenUsageDTO
} from "../types";
import { Badge, Button, ConfirmDialog, EmptyState, ErrorNotice, Field, Panel, SuccessNotice, TextArea, TextInput } from "../components/ui";

export function ChatPage() {
  const { t } = useI18n();
  const [mobilePane, setMobilePane] = useState<"chats" | "messages" | "create">("messages");
  const [characters, setCharacters] = useState<CharacterDTO[]>([]);
  const [lorebooks, setLorebooks] = useState<LorebookDTO[]>([]);
  const [chats, setChats] = useState<ChatDTO[]>([]);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [activeChat, setActiveChat] = useState<ChatWithMessagesDTO | null>(null);
  const [title, setTitle] = useState("");
  const [characterIds, setCharacterIds] = useState<string[]>([]);
  const mode: ChatMode = characterIds.length > 1 ? "group" : "single";
  const [lorebookIds, setLorebookIds] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [targetCharacterId, setTargetCharacterId] = useState<string | null>(null);
  const [streamingContent, setStreamingContent] = useState("");
  const [streamingCharacterId, setStreamingCharacterId] = useState<string | null>(null);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [editingMessage, setEditingMessage] = useState<MessageDTO | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [memorySettingsOpen, setMemorySettingsOpen] = useState(false);
  const [memoryDraft, setMemoryDraft] = useState("12");
  const [chatLorebookIdsDraft, setChatLorebookIdsDraft] = useState<string[]>([]);
  const [showAddCharacter, setShowAddCharacter] = useState(false);
  const autoCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  useEffect(() => {
    if (showAddCharacter) {
      autoCloseTimer.current = setTimeout(() => setShowAddCharacter(false), 1500);
    }
    return () => {
      if (autoCloseTimer.current) {
        clearTimeout(autoCloseTimer.current);
      }
    };
  }, [showAddCharacter]);

  const [settingsModels, setSettingsModels] = useState<ModelPreset[]>([]);
  const [activeModelId, setActiveModelId] = useState<string | null>(null);
  const [userProfileSummary, setUserProfileSummary] = useState("");
  const [userProfileUpdatedAt, setUserProfileUpdatedAt] = useState<string | null>(null);
  const [autoSummarizeUser, setAutoSummarizeUser] = useState(true);
  const [editingProfile, setEditingProfile] = useState(false);
  const [editingProfileDraft, setEditingProfileDraft] = useState("");
  const [pendingDeleteChat, setPendingDeleteChat] = useState<ChatDTO | null>(null);
  const [pendingDeleteMessage, setPendingDeleteMessage] = useState<MessageDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);

  const characterMap = useMemo(
    () => new Map(characters.map((character) => [character.id, character])),
    [characters]
  );

  const getModeLabel = (chatMode: ChatMode) =>
    chatMode === "group" ? t("chat.mode.group") : t("chat.mode.single");

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
      const id = entry.lorebookId;
      const existing = books.get(id);
      const name = entry.lorebookName?.trim() || entry.keys[0] || t("nav.lore");

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

  const renderMessageAvatar = ({
    align = "left",
    avatar,
    name,
    user = false
  }: {
    align?: "left" | "right";
    avatar?: string | null;
    name?: string;
    user?: boolean;
  }) => (
    <div
      className={`grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-xl border text-xs font-bold shadow-md ${
        user
          ? "border-ember-300/40 bg-ink-950/20 text-ink-950 shadow-ember-500/10"
          : "border-white/10 bg-ink-800 text-ember-100 shadow-black/20"
      } ${align === "right" ? "order-2" : "order-1"}`}
      title={name}
    >
      {avatar ? (
        <img alt="" className="h-full w-full object-cover" src={avatar} />
      ) : user ? (
        <UserRound size={18} />
      ) : (
        getCharacterInitials(name)
      )}
    </div>
  );

  const loadBase = async () => {
    const [characterData, lorebookData, chatData, settings] = await Promise.all([
      api.characters.list(),
      api.lorebooks.list(),
      api.chats.list(),
      api.settings.get()
    ]);
    setCharacters(characterData);
    setLorebooks(lorebookData);
    setChats(chatData);
    setSettingsModels(settings.models ?? []);
    setUserProfileSummary(settings.userProfileSummary ?? "");
    setUserProfileUpdatedAt(settings.userProfileUpdatedAt ?? null);
    setAutoSummarizeUser(settings.autoSummarizeUser);
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
    setChatLorebookIdsDraft(chat.lorebookIds ?? []);
    setTargetCharacterId((current) =>
      chat.mode === "group" && current && chat.characterIds.includes(current) ? current : null
    );
  };

  useEffect(() => {
    void loadBase().catch((caught: unknown) =>
      setError(caught instanceof Error ? caught.message : t("chat.failedLoad"))
    );
  }, [t]);

  useEffect(() => {
    void loadChat(selectedChatId).catch((caught: unknown) =>
      setError(caught instanceof Error ? caught.message : t("chat.failedLoadChat"))
    );
  }, [selectedChatId, t]);

  useEffect(
    () => () => {
      socketRef.current?.close();
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

  const toggleCharacter = (id: string) => {
    setCharacterIds((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id]
    );
  };

  const toggleLorebook = (id: string) => {
    setLorebookIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    );
  };

  const toggleChatLorebookDraft = (id: string) => {
    setChatLorebookIdsDraft((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    );
  };

  const createChat = async () => {
    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const chat = await api.chats.create({
        title: title.trim(),
        mode,
        characterIds,
        lorebookIds
      });
      setTitle("");
      setCharacterIds([]);
      setLorebookIds([]);
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

    setShowAddCharacter(false);
    setMemoryDraft(String(activeChat.memoryTurns));
    setChatLorebookIdsDraft(activeChat.lorebookIds ?? []);
    setMemorySettingsOpen((current) => {
      if (!current) {
        void api.settings.get().then((settings) => {
          const models = settings.models ?? [];
          setSettingsModels(models);
          setUserProfileSummary(settings.userProfileSummary ?? "");
          setUserProfileUpdatedAt(settings.userProfileUpdatedAt ?? null);
          setAutoSummarizeUser(settings.autoSummarizeUser);
          if (models.length > 0) {
            const active = models.find(
              (m) => m.provider === settings.activeProvider && m.model === settings.model
            );
            setActiveModelId(active?.id ?? models[0].id);
          } else {
            setActiveModelId(null);
          }
        });
      }
      return !current;
    });
  };

  const clearUserProfileSummary = async () => {
    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const settings = await api.settings.updateUserProfile({
        userProfileSummary: "",
        autoSummarizeUser
      });
      setUserProfileSummary(settings.userProfileSummary);
      setUserProfileUpdatedAt(settings.userProfileUpdatedAt);
      setAutoSummarizeUser(settings.autoSummarizeUser);
      setEditingProfile(false);
      setStatus(t("chat.userProfileCleared"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedUpdateUserProfile"));
    } finally {
      setLoading(false);
    }
  };

  const saveUserProfileSummary = async () => {
    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const settings = await api.settings.updateUserProfile({
        userProfileSummary: editingProfileDraft.trim(),
        autoSummarizeUser
      });
      setUserProfileSummary(settings.userProfileSummary);
      setUserProfileUpdatedAt(settings.userProfileUpdatedAt);
      setAutoSummarizeUser(settings.autoSummarizeUser);
      setEditingProfile(false);
      setStatus(t("chat.userProfileSaved"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedUpdateUserProfile"));
    } finally {
      setLoading(false);
    }
  };

  const startEditingProfile = () => {
    setEditingProfileDraft(userProfileSummary);
    setEditingProfile(true);
  };

  const cancelEditingProfile = () => {
    setEditingProfile(false);
    setEditingProfileDraft("");
  };

  const updateAutoSummarizeUser = async (enabled: boolean) => {
    setAutoSummarizeUser(enabled);
    try {
      const settings = await api.settings.updateUserProfile({
        userProfileSummary,
        autoSummarizeUser: enabled
      });
      setUserProfileSummary(settings.userProfileSummary);
      setUserProfileUpdatedAt(settings.userProfileUpdatedAt);
      setAutoSummarizeUser(settings.autoSummarizeUser);
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
        memoryTurns,
        lorebookIds: chatLorebookIdsDraft
      });
      setActiveChat((current) =>
        current
          ? {
              ...current,
              memoryTurns: updated.memoryTurns,
              lorebookIds: updated.lorebookIds
            }
          : current
      );
      setChats((current) =>
        current.map((chat) =>
          chat.id === updated.id
            ? { ...chat, memoryTurns: updated.memoryTurns, lorebookIds: updated.lorebookIds }
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

  const addCharacterToChat = async (character: CharacterDTO) => {
    if (!activeChat) {
      return;
    }

    setShowAddCharacter(false);
    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const updatedChat = await api.chats.update(activeChat.id, {
        characterIds: [...activeChat.characterIds, character.id],
        mode: "group"
      });

      await api.messages.create({
        chatId: activeChat.id,
        role: "system",
        content: `${t("chat.joinedGroup", { name: character.name })}`
      });

      const reloaded = await api.chats.get(activeChat.id);
      setActiveChat(reloaded);
      setChats((current) =>
        current.map((c) => (c.id === updatedChat.id ? updatedChat : c))
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedAddCharacter"));
    } finally {
      setLoading(false);
    }
  };

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

  const getSocket = () =>
    new Promise<WebSocket>((resolve, reject) => {
      const existing = socketRef.current;
      if (existing?.readyState === WebSocket.OPEN) {
        resolve(existing);
        return;
      }

      existing?.close();
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
      socketRef.current = socket;

      socket.onopen = () => resolve(socket);
      socket.onerror = () => reject(new Error(t("chat.websocketFailed")));
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as GenerationServerMessage;

        if (message.type === "ready") {
          return;
        }

        if (message.type === "user_message") {
          upsertMessage(message.message);
          return;
        }

        if (message.type === "token") {
          setStreamingContent((current) => current + message.content);
          return;
        }

        if (message.type === "generation_character_started") {
          setStreamingCharacterId(message.characterId);
          setStreamingContent("");
          return;
        }

        if (message.type === "lore_matches") {
          return;
        }

        if (message.type === "assistant_message") {
          upsertMessage(message.message);
          setStreamingContent("");
          setStreamingCharacterId(null);
          return;
        }

        if (message.type === "user_profile_updated") {
          setUserProfileSummary(message.summary);
          setUserProfileUpdatedAt(message.updatedAt);
          return;
        }

        if (message.type === "generation_done" || message.type === "generation_stopped") {
          setLoading(false);
          setActiveRequestId(null);
          setStreamingContent("");
          setStreamingCharacterId(null);
          void loadChat(selectedChatId);
          void loadBase();
          return;
        }

        if (message.type === "error") {
          setError(message.error);
          setLoading(false);
          setActiveRequestId(null);
          setStreamingContent("");
          setStreamingCharacterId(null);
        }
      };
    });

  const sendMessage = async () => {
    if (!activeChat || !draft.trim()) {
      return;
    }

    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const socket = await getSocket();
      const requestId = generateId();
      const payload: GenerationClientMessage = {
        type: "generate",
        requestId,
        chatId: activeChat.id,
        content: draft.trim(),
        targetCharacterId: activeChat.mode === "group" ? targetCharacterId : null
      };
      setActiveRequestId(requestId);
      setStreamingContent("");
      setStreamingCharacterId(null);
      setDraft("");
      setTargetCharacterId(null);
      socket.send(JSON.stringify(payload));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedSend"));
      setLoading(false);
      setActiveRequestId(null);
    } finally {
      // Loading ends when the WebSocket sends generation_done, generation_stopped, or error.
    }
  };

  const stopGeneration = () => {
    if (!activeRequestId || socketRef.current?.readyState !== WebSocket.OPEN) {
      return;
    }

    const payload: GenerationClientMessage = {
      type: "stop",
      requestId: activeRequestId
    };
    socketRef.current.send(JSON.stringify(payload));
  };

  const regenerateMessage = async (message: MessageDTO) => {
    if (message.role !== "assistant") {
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const socket = await getSocket();
      const requestId = generateId();
      const payload: GenerationClientMessage = {
        type: "regenerate",
        requestId,
        messageId: message.id
      };
      setActiveRequestId(requestId);
      setStreamingContent("");
      setStreamingCharacterId(message.characterId);
      socket.send(JSON.stringify(payload));
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
    <div className="mb-4 grid grid-cols-3 gap-1 rounded-xl border border-white/10 bg-ink-900/80 p-1 lg:hidden">
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
    <div className="grid min-w-0 gap-6 lg:h-[calc(100vh-112px)] lg:min-h-0 lg:grid-cols-[340px_minmax(0,1fr)_300px]">
      <div className={mobilePane === "chats" ? "block lg:h-full" : "hidden lg:block lg:h-full"}>
      <Panel
        title={t("chat.chats")}
        action={
          <Button variant="secondary" onClick={() => void loadBase()} className="!min-h-[32px] !h-8 !px-3 text-xs">
            <RefreshCw size={14} />
            {t("common.refresh")}
          </Button>
        }
      >
        <div className="max-h-[calc(100vh-220px)] space-y-2 overflow-y-auto pr-1 lg:h-[calc(100%-40px)] lg:max-h-none">
          <ErrorNotice message={error} />
          <SuccessNotice message={status} />
          {chats.length === 0 ? (
            <EmptyState>{t("chat.noChats")}</EmptyState>
          ) : (
            chats.map((chat) => (
              <div
                className={`group w-full cursor-pointer rounded-lg border p-3 text-left text-sm transition-all duration-200 ${
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
                      <span className={`inline-block h-1.5 w-1.5 rounded-full ${chat.mode === 'group' ? 'bg-indigo-400' : 'bg-emerald-400'}`}></span>
                      {getModeLabel(chat.mode)} <span className="opacity-50">·</span> {t("chat.boundCharacters", { count: chat.characterIds.length })}
                    </p>
                    {chat.lorebookIds.length > 0 ? (
                      <p className="mt-1 truncate text-xs text-slate-500">
                        {t("chat.boundLorebooks", { count: chat.lorebookIds.length })}
                      </p>
                    ) : null}
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

      <div className={mobilePane === "messages" ? "block lg:h-full" : "hidden lg:block lg:h-full"}>
      <Panel
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
                <div className="custom-scrollbar absolute right-0 top-10 z-20 max-h-80 w-72 overflow-y-auto rounded-xl border border-white/10 bg-ink-900/95 p-3.5 shadow-xl shadow-black/30 backdrop-blur-md sm:max-h-[calc(100dvh-22rem)]">
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
                            key={model.id}
                            type="button"
                            onClick={() => {
                              setActiveModelId(model.id);
                              setMemorySettingsOpen(false);
                              void api.settings.update({
                                activeProvider: model.provider,
                                apiBaseUrl: model.apiBaseUrl,
                                model: model.model,
                                apiKey: model.key ?? "",
                                temperature: 0.8,
                                maxTokens: 800,
                                topP: 1,
                                language: "zh-CN",
                                models: settingsModels
                              });
                              setStatus(t("chat.modelSwitched", { label: model.label || model.model }));
                            }}
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
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <p className="text-sm font-semibold text-slate-100">
                          {t("chat.userProfileMemory")}
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
                        <div className="space-y-2">
                          <textarea
                            className="min-h-[100px] w-full min-w-0 rounded-lg border border-white/10 bg-ink-950/50 px-3 py-2.5 text-xs leading-5 text-slate-100 outline-none transition-all placeholder:text-slate-500 hover:border-white/20 focus:border-ember-500 focus:bg-ink-950 focus:ring-1 focus:ring-ember-500/50 resize-y"
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
                            {userProfileSummary.trim() ? (
                              <p className="custom-scrollbar max-h-28 overflow-y-auto whitespace-pre-wrap pr-1">
                                {userProfileSummary}
                              </p>
                            ) : (
                              <p>{t("chat.userProfileEmpty")}</p>
                            )}
                            {userProfileUpdatedAt ? (
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
                            {userProfileSummary.trim() ? (
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
                    <div className="border-t border-white/10 pt-3">
                      <p className="mb-2 text-sm font-semibold text-slate-100">{t("chat.lorebooks")}</p>
                      {lorebooks.length === 0 ? (
                        <p className="rounded-lg border border-white/5 bg-white/5 px-3 py-2 text-xs text-slate-400">
                          {t("chat.noLorebooks")}
                        </p>
                      ) : (
                        <div className="custom-scrollbar max-h-40 space-y-1.5 overflow-y-auto pr-1">
                          {lorebooks.map((lorebook) => (
                            <label
                              className={`flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-sm transition-colors ${
                                chatLorebookIdsDraft.includes(lorebook.id)
                                  ? "border-ember-500/30 bg-ember-500/10 text-ember-100"
                                  : "border-white/5 bg-white/5 text-slate-300 hover:bg-white/10"
                              }`}
                              key={lorebook.id}
                            >
                              <input
                                checked={chatLorebookIdsDraft.includes(lorebook.id)}
                                type="checkbox"
                                className="rounded border-white/20 bg-ink-950 text-ember-500 focus:ring-ember-500/50"
                                onChange={() => toggleChatLorebookDraft(lorebook.id)}
                              />
                              <span className="min-w-0 truncate">{lorebook.name}</span>
                            </label>
                          ))}
                        </div>
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
          <div className="flex min-h-[calc(100vh-260px)] flex-col lg:h-[calc(100%-40px)] lg:min-h-0">
            <div className="mb-4 flex shrink-0 flex-wrap items-center gap-2 border-b border-white/5 pb-4">
              <Badge>{getModeLabel(activeChat.mode)}</Badge>
              {activeChat.characterIds.map((id) => (
                <Badge key={id}>{characterMap.get(id)?.name ?? t("common.unknown")}</Badge>
              ))}
              {activeChat.mode === "group" ? (
                <div className="relative">
                  <button
                    className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-dashed border-white/20 text-xs text-slate-400 transition-colors hover:border-ember-400/40 hover:text-ember-300"
                    type="button"
                    onClick={() => { setMemorySettingsOpen(false); setShowAddCharacter(!showAddCharacter); }}
                  >
                    +
                  </button>
                  {showAddCharacter ? (
                    <div className="absolute left-0 top-8 z-30 w-48 rounded-lg border border-white/10 bg-ink-900 p-1.5 shadow-xl shadow-black/30">
                      {characters
                        .filter((c) => !activeChat.characterIds.includes(c.id))
                        .map((character) => (
                          <button
                            className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-200"
                            key={character.id}
                            type="button"
                            onClick={() => void addCharacterToChat(character)}
                          >
                            <span className="grid h-6 w-6 shrink-0 place-items-center overflow-hidden rounded border border-white/10 bg-ink-800 text-[9px] font-semibold text-slate-300">
                              {character.avatar ? (
                                <img alt="" className="h-full w-full object-cover" src={character.avatar} />
                              ) : (
                                character.name.slice(0, 2)
                              )}
                            </span>
                            {character.name}
                          </button>
                        ))}
                      {characters.filter((c) => !activeChat.characterIds.includes(c.id)).length === 0 ? (
                        <p className="px-2.5 py-2 text-xs text-slate-500">{t("chat.noMoreCharacters")}</p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className="custom-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto rounded-xl border border-white/5 bg-ink-950/30 p-4">
              {activeChat.messages.length === 0 ? (
                <div className="h-full flex items-center justify-center">
                  <EmptyState>{t("chat.noMessages")}</EmptyState>
                </div>
              ) : (
                activeChat.messages.map((message) => {
                  const isUser = message.role === "user";
                  const isSystem = message.role === "system";
                  const character = message.characterId ? characterMap.get(message.characterId) : undefined;
                  const senderName = character?.name ?? (isUser ? "You" : isSystem ? "" : message.role);

                  if (isSystem) {
                    return (
                      <div className="flex justify-center" key={message.id}>
                        <div className="shrink-0 rounded-full bg-white/5 px-4 py-1.5 text-xs text-slate-500 select-none">
                          {message.content}
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div
                      className={`group flex items-start gap-3 ${isUser ? "justify-end" : "justify-start"}`}
                      key={message.id}
                    >
                      {!isUser
                        ? renderMessageAvatar({
                            avatar: character?.avatar,
                            name: senderName
                          })
                        : null}
                      <article
                        className={`order-1 relative max-w-[calc(100%-3.25rem)] rounded-2xl p-4 text-sm shadow-sm transition-all hover:shadow-md sm:max-w-[85%] ${
                          isUser
                            ? "bg-gradient-to-br from-ember-400 to-ember-500 text-ink-950 rounded-br-sm"
                            : "bg-ink-800/80 border border-white/5 text-slate-100 rounded-bl-sm backdrop-blur-sm"
                        }`}
                      >
                        <div
                          className={`mb-3 flex flex-col gap-2 ${
                            isUser ? "items-end" : "items-start"
                          } sm:mb-2 sm:flex-row sm:items-center sm:justify-between`}
                        >
                          <span
                            className={`shrink-0 text-xs font-bold tracking-wide sm:max-w-[45%] sm:truncate ${
                              isUser ? "sm:order-2 sm:text-right" : "sm:order-1"
                            } ${
                              isUser ? "text-ink-900/70" : "text-ember-400"
                            }`}
                          >
                            {senderName}
                          </span>
                          <span
                            className={`flex w-full flex-wrap items-center gap-1.5 text-[11px] opacity-100 sm:w-auto sm:flex-nowrap sm:text-xs sm:opacity-0 sm:transition-opacity sm:duration-200 sm:group-hover:opacity-100 ${
                              isUser
                                ? "justify-end sm:order-1 sm:justify-start"
                                : "justify-start sm:order-2 sm:justify-end"
                            }`}
                          >
                            {message.role === "assistant" && message.variants.length > 1 ? (
                              <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-ink-950/40 px-2 py-0.5 text-[11px] sm:text-xs">
                                <button className="rounded-full p-0.5 transition-colors hover:bg-white/20" type="button" onClick={() => void switchVariant(message, -1)}><ChevronLeft size={13} /></button>
                                <span className="font-medium">{message.activeVariantIndex + 1}/{message.variants.length}</span>
                                <button className="rounded-full p-0.5 transition-colors hover:bg-white/20" type="button" onClick={() => void switchVariant(message, 1)}><ChevronRight size={13} /></button>
                              </span>
                            ) : null}
                            <button className={`inline-flex items-center gap-1 whitespace-nowrap font-medium hover:underline ${isUser ? "text-ink-900/70" : "text-slate-400 hover:text-slate-200"}`} type="button" onClick={() => void copyMessage(message)}><Copy size={12} />{t("common.copy")}</button>
                            {message.role === "assistant" ? (
                              <button disabled={Boolean(activeRequestId)} className="inline-flex items-center gap-1 whitespace-nowrap font-medium text-slate-400 hover:text-slate-200 hover:underline disabled:opacity-40" type="button" onClick={() => void regenerateMessage(message)}><RotateCcw size={12} />{t("chat.regenerate")}</button>
                            ) : null}
                            <button className={`whitespace-nowrap font-medium hover:underline ${isUser ? "text-ink-900/70" : "text-slate-400 hover:text-slate-200"}`} type="button" onClick={() => startEditingMessage(message)}>{t("common.edit")}</button>
                            <button className={`whitespace-nowrap font-medium hover:underline ${isUser ? "text-ink-900/70" : "text-rose-400 hover:text-rose-300"}`} type="button" onClick={() => setPendingDeleteMessage(message)}>{t("common.delete")}</button>
                          </span>
                        </div>
                        <p
                          className={`whitespace-pre-wrap leading-relaxed ${
                            isUser ? "text-right" : "text-left"
                          }`}
                        >
                          {message.content}
                        </p>
                        {message.role === "assistant" ? (
                          <div className="mt-3 border-t border-white/5 pt-2">
                            <p className="text-[11px] font-medium text-slate-500">
                              {formatTokenUsage(message.tokenUsage)}
                            </p>
                            {message.loreMatches.length > 0 ? (
                              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                                <span className="text-[11px] font-medium text-slate-500">{t("chat.triggeredLore")}</span>
                                {getTriggeredLorebooks(message).map((book) => (
                                  <span
                                    className="inline-flex max-w-full items-center rounded-full border border-ember-500/20 bg-ember-500/10 px-2 py-0.5 text-[11px] font-medium text-ember-200"
                                    key={book.id}
                                  >
                                    <span className="truncate">{book.name}</span>
                                    {book.count > 1 ? <span className="ml-1 text-ember-200/70">x{book.count}</span> : null}
                                  </span>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </article>
                      {isUser
                        ? renderMessageAvatar({
                            align: "right",
                            name: senderName,
                            user: true
                          })
                        : null}
                    </div>
                  );
                })
              )}
              {activeRequestId ? (
                <div className="flex items-start justify-start gap-3">
                  {renderMessageAvatar({
                    avatar: streamingCharacterId ? characterMap.get(streamingCharacterId)?.avatar : null,
                    name: streamingCharacterId
                      ? characterMap.get(streamingCharacterId)?.name ?? t("common.unknown")
                      : t("chat.streaming")
                  })}
                  <article className="order-1 max-w-[calc(100%-3.25rem)] rounded-2xl rounded-bl-sm border border-ember-500/20 bg-ink-800/80 p-4 text-sm text-slate-100 shadow-md animate-fade-in backdrop-blur-sm sm:max-w-[85%]">
                    <div className="mb-2 text-xs font-bold tracking-wide text-ember-400 flex items-center gap-2">
                      <span className="relative flex h-2 w-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-ember-400 opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-ember-500"></span>
                      </span>
                      {streamingCharacterId
                        ? t("chat.streamingAs", {
                            name: characterMap.get(streamingCharacterId)?.name ?? t("common.unknown")
                          })
                        : t("chat.streaming")}
                    </div>
                    {streamingContent ? (
                      <p className="whitespace-pre-wrap leading-relaxed">{streamingContent}</p>
                    ) : (
                      <div className="flex items-center gap-1 py-1">
                        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-ember-400/60 [animation-delay:0ms]"></span>
                        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-ember-400/60 [animation-delay:150ms]"></span>
                        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-ember-400/60 [animation-delay:300ms]"></span>
                      </div>
                    )}
                  </article>
                </div>
              ) : null}
            </div>

            <div className="sticky bottom-3 mt-3 grid min-w-0 shrink-0 grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-lg border border-white/5 bg-ink-950/95 p-1.5 shadow-xl shadow-black/30 backdrop-blur-sm lg:static lg:bg-ink-950/40 lg:shadow-none">
              {activeChat?.mode === "group" && activeChat?.characterIds?.length > 1 ? (
                <div className="col-span-full flex flex-wrap items-center gap-1.5 pb-1">
                  <button
                    className={`rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors ${
                      targetCharacterId === null
                        ? "bg-ember-500/20 text-ember-200"
                        : "bg-white/5 text-slate-400 hover:bg-white/10 hover:text-slate-200"
                    }`}
                    type="button"
                    onClick={() => setTargetCharacterId(null)}
                  >
                    {t("chat.targetAll")}
                  </button>
                  {Array.from(characterMap.entries())
                    .filter(([id]) => activeChat?.characterIds?.includes(id))
                    .map(([id, character]) => (
                      <button
                        className={`rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors ${
                          targetCharacterId === id
                            ? "bg-ember-500/20 text-ember-200"
                            : "bg-white/5 text-slate-400 hover:bg-white/10 hover:text-slate-200"
                        }`}
                        key={id}
                        type="button"
                        onClick={() => setTargetCharacterId(id === targetCharacterId ? null : id)}
                      >
                        {character.name}
                      </button>
                    ))}
                </div>
              ) : null}
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

      <div className={mobilePane === "create" ? "block lg:h-full" : "hidden lg:block lg:h-full"}>
      <Panel
        title={t("chat.createChat")}
        action={<MessageSquarePlus size={16} className="text-slate-400" />}
      >
        <div className="space-y-3">
          <Field label={t("chat.title")}><TextInput value={title} onChange={(event) => setTitle(event.target.value)} /></Field>
          <div className="space-y-2.5">
            <p className="text-sm font-medium text-slate-300">{t("nav.characters")}</p>
            {characters.length === 0 ? (
              <EmptyState>{t("chat.createCharactersFirst")}</EmptyState>
            ) : (
              <div className="space-y-2 max-h-[300px] overflow-y-auto custom-scrollbar pr-1">
                {characters.map((character) => (
                  <label className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 text-sm transition-all duration-200 hover:bg-white/10 ${characterIds.includes(character.id) ? 'border-ember-500/30 bg-ember-500/5' : 'border-white/5 bg-white/5'}`} key={character.id}>
                    <input checked={characterIds.includes(character.id)} type="checkbox" onChange={() => toggleCharacter(character.id)} className="rounded border-white/20 bg-ink-950 text-ember-500 focus:ring-ember-500/50" />
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
                    <span className={`min-w-0 truncate ${characterIds.includes(character.id) ? 'font-medium text-ember-100' : 'text-slate-200'}`}>
                      {character.name}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
          <div className="space-y-2.5">
            <p className="text-sm font-medium text-slate-300">{t("chat.lorebooks")}</p>
            {lorebooks.length === 0 ? (
              <EmptyState>{t("chat.noLorebooks")}</EmptyState>
            ) : (
              <div className="custom-scrollbar max-h-[220px] space-y-2 overflow-y-auto pr-1">
                {lorebooks.map((lorebook) => (
                  <label
                    className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 text-sm transition-all duration-200 hover:bg-white/10 ${
                      lorebookIds.includes(lorebook.id)
                        ? "border-ember-500/30 bg-ember-500/5"
                        : "border-white/5 bg-white/5"
                    }`}
                    key={lorebook.id}
                  >
                    <input
                      checked={lorebookIds.includes(lorebook.id)}
                      type="checkbox"
                      className="rounded border-white/20 bg-ink-950 text-ember-500 focus:ring-ember-500/50"
                      onChange={() => toggleLorebook(lorebook.id)}
                    />
                    <span
                      className={`min-w-0 truncate ${
                        lorebookIds.includes(lorebook.id)
                          ? "font-medium text-ember-100"
                          : "text-slate-200"
                      }`}
                    >
                      {lorebook.name}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
          <Button disabled={loading || !title.trim()} onClick={() => void createChat()} className="w-full">
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
