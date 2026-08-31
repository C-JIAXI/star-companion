import {
  ChevronLeft,
  ChevronRight,
  Lock,
  LoaderCircle,
  MessageSquarePlus,
  Search,
  Star,
  UserPlus,
  Users
} from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { api } from "../lib/api";
import { usePlaceholderSrc } from "../placeholderImages";
import type { CharacterDTO, PaginatedCharactersDTO } from "../types";
import { Button, EmptyState, ErrorNotice, Field, Modal, TextArea, TextInput } from "./ui";

const PAGE_SIZE = 8;
type NewChatMode = "choose" | "quick-create";

function CharacterChoice({
  character,
  disabled,
  creating,
  onSelect
}: {
  character: CharacterDTO;
  disabled: boolean;
  creating: boolean;
  onSelect: () => void;
}) {
  const { t } = useI18n();
  const avatar = usePlaceholderSrc(character.avatar, character.id);

  return (
    <button
      className="group flex min-h-[84px] w-full min-w-0 items-center gap-3 overflow-hidden rounded-md border border-white/[0.08] bg-ink-950/45 p-3 text-left transition-colors hover:border-ember-400/30 hover:bg-ink-800 disabled:pointer-events-none disabled:opacity-50"
      data-character-id={character.id}
      disabled={disabled}
      type="button"
      onClick={onSelect}
    >
      <img
        alt=""
        className="h-14 w-14 shrink-0 rounded-md object-cover ring-1 ring-white/10"
        loading="lazy"
        src={avatar}
      />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="block min-w-0 flex-1 truncate text-sm font-semibold text-ink-50">
            {character.name}
          </span>
          {character.isFavorite ? (
            <Star
              aria-hidden="true"
              className="shrink-0 text-amber-300"
              fill="currentColor"
              size={12}
            />
          ) : null}
          {character.visibility === "private" ? (
            <Lock aria-hidden="true" className="shrink-0 text-amber-400" size={12} />
          ) : null}
        </span>
        <span className="mt-1 line-clamp-2 text-xs leading-5 text-ink-400">
          {character.description || t("common.noDescription")}
        </span>
      </span>
      <span className="grid h-8 w-8 shrink-0 place-items-center text-ember-300">
        {creating ? (
          <LoaderCircle className="animate-spin" size={16} />
        ) : (
          <MessageSquarePlus size={16} />
        )}
      </span>
    </button>
  );
}

export function NewChatDialog({
  open,
  onClose,
  onCreate,
  onOpenCharacters
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (characterId: string) => Promise<void>;
  onOpenCharacters: () => void;
}) {
  const { t, language } = useI18n();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<PaginatedCharactersDTO | null>(null);
  const [loading, setLoading] = useState(false);
  const [creatingId, setCreatingId] = useState<string | null>(null);
  const [mode, setMode] = useState<NewChatMode>("choose");
  const [quickName, setQuickName] = useState("");
  const [quickPrompt, setQuickPrompt] = useState("");
  const [quickCreating, setQuickCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || mode !== "choose") {
      return;
    }

    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      void api.characters
        .page({
          q: query,
          sort: "recently_chatted",
          page,
          pageSize: PAGE_SIZE
        })
        .then((nextResult) => {
          if (cancelled) {
            return;
          }
          setResult(nextResult);
          if (page > nextResult.totalPages && nextResult.totalPages > 0) {
            setPage(nextResult.totalPages);
          }
        })
        .catch((caught) => {
          if (!cancelled) {
            setError(caught instanceof Error ? caught.message : t("chat.newChatLoadFailed"));
          }
        })
        .finally(() => {
          if (!cancelled) {
            setLoading(false);
          }
        });
    }, 180);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [mode, open, page, query, t]);

  useEffect(() => {
    if (open) {
      setMode("choose");
      setQuery("");
      setPage(1);
      setResult(null);
      setQuickName("");
      setQuickPrompt("");
      setQuickCreating(false);
      setError(null);
    }
  }, [open]);

  if (!open) {
    return null;
  }

  const createChat = async (characterId: string) => {
    setCreatingId(characterId);
    setError(null);
    try {
      await onCreate(characterId);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("chat.failedCreate"));
    } finally {
      setCreatingId(null);
    }
  };

  const quickCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = quickName.trim();
    const prompt = quickPrompt.trim();
    if (!name || !prompt || quickCreating) {
      return;
    }

    setQuickCreating(true);
    setError(null);
    let createdCharacter: CharacterDTO | null = null;
    try {
      createdCharacter = await api.characters.create({
        name,
        description: prompt,
        prompt
      });
      await onCreate(createdCharacter.id);
      onClose();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : t("chat.failedCreate");
      if (createdCharacter) {
        setMode("choose");
        setQuery(createdCharacter.name);
        setPage(1);
        setResult(null);
        setError(t("chat.newChatQuickChatFailed", { error: message }));
      } else {
        setError(message || t("chat.newChatQuickFailed"));
      }
    } finally {
      setQuickCreating(false);
    }
  };

  const items = result?.items ?? [];
  const totalPages = Math.max(1, result?.totalPages ?? 1);

  return (
    <>
      <ErrorNotice message={error} />
      <Modal
        bodyClassName="flex min-h-0 flex-col"
        panelClassName="!max-w-2xl"
        title={t("chat.newChatTitle")}
        onClose={onClose}
      >
        <div className="flex min-h-0 flex-1 flex-col gap-4" data-testid="new-chat-dialog">
          <div
            aria-label={t("chat.newChatMode")}
            className="grid grid-cols-2 rounded-md border border-white/[0.08] bg-ink-950/45 p-1"
            role="group"
          >
            <button
              aria-pressed={mode === "choose"}
              className={`flex min-h-10 items-center justify-center gap-2 rounded px-3 text-sm font-medium transition-colors ${
                mode === "choose"
                  ? "bg-ink-700 text-ink-50 shadow-sm"
                  : "text-ink-400 hover:bg-white/[0.04] hover:text-ink-200"
              }`}
              data-testid="new-chat-choose-tab"
              type="button"
              onClick={() => {
                setMode("choose");
                setError(null);
              }}
            >
              <Users aria-hidden="true" size={16} />
              {t("chat.newChatChooseExisting")}
            </button>
            <button
              aria-pressed={mode === "quick-create"}
              className={`flex min-h-10 items-center justify-center gap-2 rounded px-3 text-sm font-medium transition-colors ${
                mode === "quick-create"
                  ? "bg-ink-700 text-ink-50 shadow-sm"
                  : "text-ink-400 hover:bg-white/[0.04] hover:text-ink-200"
              }`}
              data-testid="new-chat-quick-create-tab"
              type="button"
              onClick={() => {
                setMode("quick-create");
                setError(null);
              }}
            >
              <UserPlus aria-hidden="true" size={16} />
              {t("chat.newChatQuickCreate")}
            </button>
          </div>

          {mode === "quick-create" ? (
            <form className="flex min-h-0 flex-1 flex-col gap-4" onSubmit={quickCreate}>
              <div>
                <p className="text-sm leading-6 text-ink-300">{t("chat.newChatQuickHelp")}</p>
                <p className="mt-1 text-xs leading-5 text-ink-500">
                  {t("chat.newChatQuickAdvancedHelp")}
                </p>
              </div>
              <Field label={t("chat.newChatQuickName")}>
                <TextInput
                  autoFocus
                  data-testid="new-chat-quick-name"
                  maxLength={120}
                  placeholder={t("chat.newChatQuickNamePlaceholder")}
                  value={quickName}
                  onChange={(event) => setQuickName(event.target.value)}
                />
              </Field>
              <Field container="div" label={t("chat.newChatQuickPrompt")}>
                <TextArea
                  className="!h-40 min-h-40"
                  data-testid="new-chat-quick-prompt"
                  placeholder={t("chat.newChatQuickPromptPlaceholder")}
                  value={quickPrompt}
                  onChange={(event) => setQuickPrompt(event.target.value)}
                />
              </Field>
              <div className="mt-auto flex flex-col-reverse gap-2 border-t border-white/[0.08] pt-4 sm:flex-row sm:justify-between">
                <Button
                  data-testid="new-chat-open-characters"
                  disabled={quickCreating}
                  type="button"
                  variant="ghost"
                  onClick={onOpenCharacters}
                >
                  {t("chat.newChatAdvancedEditor")}
                </Button>
                <Button
                  data-testid="new-chat-quick-submit"
                  disabled={quickCreating || !quickName.trim() || !quickPrompt.trim()}
                  type="submit"
                >
                  {quickCreating ? (
                    <LoaderCircle aria-hidden="true" className="animate-spin" size={16} />
                  ) : (
                    <MessageSquarePlus aria-hidden="true" size={16} />
                  )}
                  {t(quickCreating ? "chat.newChatQuickCreating" : "chat.newChatQuickSubmit")}
                </Button>
              </div>
            </form>
          ) : (
            <>
              <div>
                <p className="text-sm leading-6 text-ink-400">{t("chat.newChatHelp")}</p>
                <div className="relative mt-3">
                  <Search
                    aria-hidden="true"
                    className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-500"
                    size={16}
                  />
                  <TextInput
                    autoFocus
                    className="pl-9"
                    data-testid="new-chat-search"
                    placeholder={t("chat.newChatSearch")}
                    value={query}
                    onChange={(event) => {
                      setQuery(event.target.value);
                      setPage(1);
                    }}
                  />
                </div>
              </div>

              {loading && !result ? (
                <div className="grid min-h-52 place-items-center text-sm text-ink-400">
                  {t("chat.newChatLoading")}
                </div>
              ) : items.length === 0 ? (
                <EmptyState>
                  <div className="flex max-w-sm flex-col items-center gap-3">
                    <Users className="text-ink-500" size={24} />
                    <p className="font-medium text-ink-200">
                      {query ? t("chat.newChatNoResults") : t("chat.newChatNoCharacters")}
                    </p>
                    {!query ? (
                      <div className="flex flex-col gap-2 sm:flex-row">
                        <Button
                          data-testid="new-chat-empty-quick-create"
                          onClick={() => setMode("quick-create")}
                        >
                          <UserPlus aria-hidden="true" size={16} />
                          {t("chat.newChatQuickCreate")}
                        </Button>
                        <Button
                          data-testid="new-chat-open-characters"
                          variant="secondary"
                          onClick={onOpenCharacters}
                        >
                          {t("chat.newChatAdvancedEditor")}
                        </Button>
                      </div>
                    ) : (
                      <Button variant="secondary" onClick={() => { setQuery(""); setPage(1); }}>
                        {language === "zh-CN" ? "清除搜索" : "Clear search"}
                      </Button>
                    )}
                  </div>
                </EmptyState>
              ) : (
                <div
                  className="grid min-w-0 gap-2 sm:grid-cols-2"
                  data-testid="new-chat-character-list"
                >
                  {items.map((character) => (
                    <CharacterChoice
                      character={character}
                      disabled={Boolean(creatingId)}
                      creating={creatingId === character.id}
                      key={character.id}
                      onSelect={() => void createChat(character.id)}
                    />
                  ))}
                </div>
              )}

              {result && result.totalPages > 1 ? (
                <div className="flex items-center justify-between gap-3 border-t border-white/[0.08] pt-3">
                  <p className="text-xs text-ink-500">
                    {t("chat.newChatPage", {
                      current: result.page,
                      total: result.totalPages,
                      count: result.total
                    })}
                  </p>
                  <div className="flex items-center gap-1">
                    <Button
                      aria-label={t("chat.newChatPrevious")}
                      className="!h-9 !min-h-9 !w-9 !p-0"
                      disabled={loading || page <= 1}
                      variant="ghost"
                      onClick={() => setPage((current) => Math.max(1, current - 1))}
                    >
                      <ChevronLeft size={16} />
                    </Button>
                    <Button
                      aria-label={t("chat.newChatNext")}
                      className="!h-9 !min-h-9 !w-9 !p-0"
                      disabled={loading || page >= totalPages}
                      variant="ghost"
                      onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                    >
                      <ChevronRight size={16} />
                    </Button>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>
      </Modal>
    </>
  );
}
