import {
  Check,
  MessageSquarePlus,
  RefreshCw,
  Send,
  Settings,
  Sparkles,
  StopCircle,
  Trash2,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { api } from "../lib/api";
import { generateId } from "../lib/uuid";
import { useWebSocket } from "../lib/useWebSocket";
import type {
  CharacterDTO,
  ChatDTO,
  ChatWithMessagesDTO,
  GenerationClientMessage,
  GenerationServerMessage,
  MessageDTO,
  ModelPreset,
  TokenUsageDTO
} from "../types";
import { Badge, Button, ConfirmDialog, EmptyState, ErrorNotice, Field, Panel, SuccessNotice, TextArea, TextInput } from "../components/ui";
import {
  AssistantMessageBubble,
  StreamingBubble,
  SystemNotification,
  UserMessageBubble
} from "../components/messages";

export function ChatPage() {
  const { t } = useI18n();
  const [mobilePane, setMobilePane] = useState<"chats" | "messages" | "create">("messages");
  const [characters, setCharacters] = useState<CharacterDTO[]>([]);
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
  const [autoSummarizeUser, setAutoSummarizeUser] = useState(true);
  const [editingProfile, setEditingProfile] = useState(false);
  const [editingProfileDraft, setEditingProfileDraft] = useState("");
  const [pendingDeleteChat, setPendingDeleteChat] = useState<ChatDTO | null>(null);
  const [pendingDeleteMessage, setPendingDeleteMessage] = useState<MessageDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const streamingBufferRef = useRef("");

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

  const loadBase = async () => {
    const [characterData, chatData, settings] = await Promise.all([
      api.characters.list(),
      api.chats.list(),
      api.settings.get()
    ]);
    setCharacters(characterData);
    setChats(chatData);
    setSettingsModels(settings.models ?? []);
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

  const toggleCharacter = (id: string) => {
    setCharacterIds((current) =>
      current.includes(id) ? [] : [id]
    );
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

  const handleMemorySettingsPointerDownCapture = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!editingProfile || !profileEditorRef.current) {
      return;
    }

    if (!profileEditorRef.current.contains(event.target as Node)) {
      setEditingProfile(false);
      setEditingProfileDraft("");
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
      await api.chats.update(activeChat.id, { userProfileSummary: "" });
      setActiveChat({ ...activeChat, userProfileSummary: "", userProfileUpdatedAt: null });
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
      await api.chats.update(activeChat.id, {
        userProfileSummary: summary
      });
      setActiveChat({ ...activeChat, userProfileSummary: summary, userProfileUpdatedAt: new Date().toISOString() });
      setEditingProfile(false);
      setStatus(t("chat.userProfileSaved"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedUpdateUserProfile"));
    } finally {
      setLoading(false);
    }
  };

  const startEditingProfile = () => {
    setEditingProfileDraft(activeChat?.userProfileSummary ?? "");
    setEditingProfile(true);
  };

  const cancelEditingProfile = () => {
    setEditingProfile(false);
    setEditingProfileDraft("");
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
      <div className={mobilePane === "chats" ? "block xl:h-full" : "hidden xl:block xl:h-full"}>
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

      <div className={mobilePane === "messages" ? "block xl:h-full" : "hidden xl:block xl:h-full"}>
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
          <div className="flex min-h-[calc(100vh-260px)] flex-col xl:h-[calc(100%-40px)] xl:min-h-0">
            <div className="mb-5 flex shrink-0 flex-wrap items-center gap-2 border-b border-white/5 pb-5">
              {activeChat.characterIds.map((id) => (
                <Badge key={id}>{characterMap.get(id)?.name ?? t("common.unknown")}</Badge>
              ))}
            </div>

            <div className="custom-scrollbar min-h-0 flex-1 space-y-5 overflow-y-auto rounded-2xl border border-white/5 bg-ink-950/30 p-5">
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
                    return <SystemNotification key={message.id} content={message.content} />;
                  }

                  if (isUser) {
                    return (
                      <UserMessageBubble
                        key={message.id}
                        message={message}
                        senderName={senderName}
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
                      senderName={senderName}
                      avatar={character?.avatar}
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
              {activeRequestId && streamingCharacterId ? (
                <StreamingBubble
                  key="streaming"
                  characterName={
                    streamingCharacterId
                      ? characterMap.get(streamingCharacterId)?.name ?? t("common.unknown")
                      : t("chat.streaming")
                  }
                  characterAvatar={
                    streamingCharacterId ? characterMap.get(streamingCharacterId)?.avatar : null
                  }
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

      <div className={mobilePane === "create" ? "block xl:h-full" : "hidden xl:block xl:h-full"}>
      <Panel
        title={t("chat.createChat")}
        action={<MessageSquarePlus size={16} className="text-slate-400" />}
      >
        <div className="space-y-5">
          <Field label={t("chat.title")}><TextInput value={title} onChange={(event) => setTitle(event.target.value)} /></Field>
          <div className="space-y-3">
            <p className="text-sm font-medium text-slate-300">{t("nav.characters")}</p>
            {characters.length === 0 ? (
              <EmptyState>{t("chat.createCharactersFirst")}</EmptyState>
            ) : (
              <div className="custom-scrollbar max-h-[420px] space-y-3 overflow-y-auto pr-1">
                {characters.map((character) => (
                  <label className={`flex cursor-pointer items-center gap-4 rounded-xl border p-4 text-sm transition-all duration-200 hover:bg-white/10 ${characterIds.includes(character.id) ? 'border-ember-500/30 bg-ember-500/5' : 'border-white/5 bg-white/5'}`} key={character.id}>
                    <input checked={characterIds.includes(character.id)} type="radio" name="character-select" onChange={() => toggleCharacter(character.id)} className="rounded-full border-white/20 bg-ink-950 text-ember-500 focus:ring-ember-500/50" />
                    <span className={`grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-xl border text-xs font-semibold ${
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
