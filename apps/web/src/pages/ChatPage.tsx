import {
  ChevronLeft,
  ChevronRight,
  Copy,
  MessageSquarePlus,
  RefreshCw,
  RotateCcw,
  Send,
  StopCircle,
  Trash2
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { api } from "../lib/api";
import type {
  CharacterDTO,
  ChatDTO,
  ChatMode,
  ChatWithMessagesDTO,
  GenerationClientMessage,
  GenerationServerMessage,
  LoreEntryDTO,
  MessageDTO
} from "../types";
import { Badge, Button, EmptyState, ErrorNotice, Field, Panel, TextArea, TextInput } from "../components/ui";

export function ChatPage() {
  const { t } = useI18n();
  const [characters, setCharacters] = useState<CharacterDTO[]>([]);
  const [chats, setChats] = useState<ChatDTO[]>([]);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [activeChat, setActiveChat] = useState<ChatWithMessagesDTO | null>(null);
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<ChatMode>("single");
  const [characterIds, setCharacterIds] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [streamingContent, setStreamingContent] = useState("");
  const [matchedLoreEntries, setMatchedLoreEntries] = useState<LoreEntryDTO[]>([]);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);

  const characterMap = useMemo(
    () => new Map(characters.map((character) => [character.id, character])),
    [characters]
  );

  const loadBase = async () => {
    const [characterData, chatData] = await Promise.all([api.characters.list(), api.chats.list()]);
    setCharacters(characterData);
    setChats(chatData);
    if (!selectedChatId && chatData[0]) {
      setSelectedChatId(chatData[0].id);
    }
  };

  const loadChat = async (id: string | null) => {
    if (!id) {
      setActiveChat(null);
      return;
    }
    setActiveChat(await api.chats.get(id));
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

  const toggleCharacter = (id: string) => {
    setCharacterIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    );
  };

  const createChat = async () => {
    setLoading(true);
    setError(null);
    setMatchedLoreEntries([]);
    try {
      const chat = await api.chats.create({
        title: title.trim(),
        mode,
        characterIds
      });
      setTitle("");
      setCharacterIds([]);
      setSelectedChatId(chat.id);
      await loadBase();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedCreate"));
    } finally {
      setLoading(false);
    }
  };

  const deleteChat = async (chat: ChatDTO) => {
    if (!window.confirm(t("chat.deleteChatConfirm", { title: chat.title }))) {
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await api.chats.remove(chat.id);
      setSelectedChatId(null);
      setActiveChat(null);
      await loadBase();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedDelete"));
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

        if (message.type === "lore_matches") {
          setMatchedLoreEntries(message.entries);
          return;
        }

        if (message.type === "assistant_message") {
          upsertMessage(message.message);
          setStreamingContent("");
          return;
        }

        if (message.type === "generation_done" || message.type === "generation_stopped") {
          setLoading(false);
          setActiveRequestId(null);
          setStreamingContent("");
          void loadChat(selectedChatId);
          void loadBase();
          return;
        }

        if (message.type === "error") {
          setError(message.error);
          setLoading(false);
          setActiveRequestId(null);
          setStreamingContent("");
        }
      };
    });

  const sendMessage = async () => {
    if (!activeChat || !draft.trim()) {
      return;
    }

    setLoading(true);
    setError(null);
    setMatchedLoreEntries([]);
    try {
      const socket = await getSocket();
      const requestId = crypto.randomUUID();
      const payload: GenerationClientMessage = {
        type: "generate",
        requestId,
        chatId: activeChat.id,
        content: draft.trim()
      };
      setActiveRequestId(requestId);
      setStreamingContent("");
      setDraft("");
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
      const requestId = crypto.randomUUID();
      const payload: GenerationClientMessage = {
        type: "regenerate",
        requestId,
        messageId: message.id
      };
      setActiveRequestId(requestId);
      setStreamingContent("");
      socket.send(JSON.stringify(payload));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedRegenerate"));
      setLoading(false);
      setActiveRequestId(null);
    }
  };

  const copyMessage = async (message: MessageDTO) => {
    await navigator.clipboard.writeText(message.content);
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

  const updateMessage = async (message: MessageDTO) => {
    const nextContent = window.prompt(t("chat.editMessagePrompt"), message.content);
    if (nextContent === null) {
      return;
    }

    await api.messages.update(message.id, { content: nextContent });
    await loadChat(message.chatId);
  };

  const deleteMessage = async (message: MessageDTO) => {
    if (!window.confirm(t("chat.deleteMessageConfirm"))) {
      return;
    }

    await api.messages.remove(message.id);
    await loadChat(message.chatId);
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[300px_1fr_300px]">
      <Panel title={t("chat.chats")} action={<Button variant="ghost" onClick={() => void loadBase()}><RefreshCw size={16} />{t("common.refresh")}</Button>}>
        <div className="space-y-3">
          <ErrorNotice message={error} />
          {chats.length === 0 ? (
            <EmptyState>{t("chat.noChats")}</EmptyState>
          ) : (
            chats.map((chat) => (
              <button
                className={`w-full rounded-md border p-3 text-left text-sm transition ${
                  selectedChatId === chat.id
                    ? "border-ember-500 bg-ember-500/10"
                    : "border-white/10 bg-white/5 hover:bg-white/10"
                }`}
                key={chat.id}
                type="button"
                onClick={() => setSelectedChatId(chat.id)}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-medium text-slate-100">{chat.title}</p>
                    <p className="mt-1 text-xs text-slate-400">{chat.mode} · {t("chat.boundCharacters", { count: chat.characterIds.length })}</p>
                  </div>
                  <Button className="min-h-8 px-2" variant="ghost" onClick={(event) => { event.stopPropagation(); void deleteChat(chat); }}>
                    <Trash2 size={14} />
                  </Button>
                </div>
              </button>
            ))
          )}
        </div>
      </Panel>

      <Panel title={activeChat?.title ?? t("chat.messageStream")}>
        {!activeChat ? (
          <EmptyState>{t("chat.selectOrCreate")}</EmptyState>
        ) : (
          <div className="flex min-h-[520px] flex-col">
            <div className="flex flex-wrap gap-2 pb-3">
              <Badge>{activeChat.mode}</Badge>
              {activeChat.characterIds.map((id) => (
                <Badge key={id}>{characterMap.get(id)?.name ?? t("common.unknown")}</Badge>
              ))}
            </div>

            {matchedLoreEntries.length > 0 ? (
              <div className="mb-3 rounded-md border border-ember-500/30 bg-ember-500/10 p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-ember-100">{t("chat.loreMatches")}</p>
                  <Badge>{matchedLoreEntries.length}</Badge>
                </div>
                <div className="space-y-2">
                  {matchedLoreEntries.map((entry) => (
                    <article className="rounded-md bg-ink-950/80 p-2 text-xs text-slate-300" key={entry.id}>
                      <div className="mb-1 flex flex-wrap gap-1">
                        {entry.keys.map((key) => (
                          <Badge key={key}>{key}</Badge>
                        ))}
                        <Badge>{t("common.priority")} {entry.priority}</Badge>
                      </div>
                      <p className="line-clamp-2 whitespace-pre-wrap">{entry.content}</p>
                    </article>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="flex-1 space-y-3 overflow-y-auto rounded-md bg-ink-950 p-3">
              {activeChat.messages.length === 0 ? (
                <EmptyState>{t("chat.noMessages")}</EmptyState>
              ) : (
                activeChat.messages.map((message) => (
                  <article
                    className={`rounded-md p-3 text-sm ${
                      message.role === "user" ? "ml-auto max-w-[85%] bg-ember-500 text-ink-950" : "mr-auto max-w-[85%] bg-white/10 text-slate-100"
                    }`}
                    key={message.id}
                  >
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <span className="text-xs font-semibold opacity-80">
                        {message.characterId ? characterMap.get(message.characterId)?.name : message.role}
                      </span>
                      <span className="flex flex-wrap justify-end gap-1">
                        {message.role === "assistant" && message.variants.length > 1 ? (
                          <span className="mr-1 inline-flex items-center gap-1 text-xs opacity-80">
                            <button className="rounded bg-white/10 p-0.5" type="button" onClick={() => void switchVariant(message, -1)}><ChevronLeft size={13} /></button>
                            {message.activeVariantIndex + 1}/{message.variants.length}
                            <button className="rounded bg-white/10 p-0.5" type="button" onClick={() => void switchVariant(message, 1)}><ChevronRight size={13} /></button>
                          </span>
                        ) : null}
                        <button className="inline-flex items-center gap-1 text-xs underline opacity-80" type="button" onClick={() => void copyMessage(message)}><Copy size={12} />{t("common.copy")}</button>
                        {message.role === "assistant" ? (
                          <button disabled={Boolean(activeRequestId)} className="inline-flex items-center gap-1 text-xs underline opacity-80 disabled:opacity-40" type="button" onClick={() => void regenerateMessage(message)}><RotateCcw size={12} />{t("chat.regenerate")}</button>
                        ) : null}
                        <button className="text-xs underline opacity-80" type="button" onClick={() => void updateMessage(message)}>{t("common.edit")}</button>
                        <button className="text-xs underline opacity-80" type="button" onClick={() => void deleteMessage(message)}>{t("common.delete")}</button>
                      </span>
                    </div>
                    <p className="whitespace-pre-wrap">{message.content}</p>
                  </article>
                ))
              )}
              {streamingContent ? (
                <article className="mr-auto max-w-[85%] rounded-md bg-white/10 p-3 text-sm text-slate-100">
                  <div className="mb-2 text-xs font-semibold opacity-80">{t("chat.streaming")}</div>
                  <p className="whitespace-pre-wrap">{streamingContent}</p>
                </article>
              ) : null}
            </div>

            <div className="mt-3 flex gap-2">
              <TextInput
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
                <Button variant="danger" onClick={stopGeneration}><StopCircle size={16} />{t("chat.stop")}</Button>
              ) : (
                <Button disabled={loading || !draft.trim()} onClick={() => void sendMessage()}><Send size={16} />{t("chat.send")}</Button>
              )}
            </div>
          </div>
        )}
      </Panel>

      <Panel title={t("chat.createChat")} action={<MessageSquarePlus size={18} className="text-ember-400" />}>
        <div className="space-y-3">
          <Field label={t("chat.title")}><TextInput value={title} onChange={(event) => setTitle(event.target.value)} /></Field>
          <Field label={t("chat.mode")}>
            <select className="min-h-10 rounded-md border border-white/10 bg-ink-950 px-3 text-sm" value={mode} onChange={(event) => setMode(event.target.value as ChatMode)}>
              <option value="single">single</option>
              <option value="group">group</option>
            </select>
          </Field>
          <div className="space-y-2">
            <p className="text-sm text-slate-300">{t("nav.characters")}</p>
            {characters.length === 0 ? (
              <EmptyState>{t("chat.createCharactersFirst")}</EmptyState>
            ) : (
              characters.map((character) => (
                <label className="flex cursor-pointer items-center gap-2 rounded-md bg-white/5 px-3 py-2 text-sm" key={character.id}>
                  <input checked={characterIds.includes(character.id)} type="checkbox" onChange={() => toggleCharacter(character.id)} />
                  {character.name}
                </label>
              ))
            )}
          </div>
          <Button disabled={loading || !title.trim()} onClick={() => void createChat()}><MessageSquarePlus size={16} />{t("chat.createChat")}</Button>
          <Field label={t("chat.draftNotes")}><TextArea disabled placeholder={t("chat.stage4Placeholder")} /></Field>
        </div>
      </Panel>
    </div>
  );
}
