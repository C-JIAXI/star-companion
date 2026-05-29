import { ChevronDown, ChevronRight, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useState } from "react";
import { parseUserCustomConfig } from "@local-roleplay/shared";
import { useI18n } from "../i18n";
import type { CharacterDTO, ChatWithMessagesDTO, CharacterLoreEntryDTO, MatchedLoreEntryDTO, MessageDTO } from "../types";

function EmptyHint({ text }: { text: string }) {
  return <span className="italic text-slate-500">{text}</span>;
}

function CollapsibleSection({
  id,
  title,
  defaultOpen,
  collapsed,
  onToggle,
  level = 1,
  children
}: {
  id: string;
  title: string;
  defaultOpen: boolean;
  collapsed: boolean;
  onToggle: (id: string) => void;
  level?: 1 | 2;
  children: React.ReactNode;
}) {
  const isOpen = defaultOpen ? !collapsed : collapsed;
  const isSub = level === 2;

  return (
    <div className={isSub ? "ml-1" : ""}>
      <button
        className={`flex min-h-[44px] w-full items-center gap-1.5 text-left transition-colors hover:text-slate-200 active:text-slate-100 ${
          isSub
            ? "text-xs font-medium text-slate-400"
            : "text-xs font-semibold uppercase tracking-wider text-slate-400"
        }`}
        type="button"
        onClick={() => onToggle(id)}
      >
        {isOpen ? <ChevronDown size={isSub ? 10 : 12} /> : <ChevronRight size={isSub ? 10 : 12} />}
        {title}
      </button>
      {isOpen && (
        <div className={`mt-1.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-300 ${
          isSub
            ? "rounded border border-white/5 bg-white/[0.02] p-2.5"
            : "mt-2 rounded-lg border border-white/5 bg-white/[0.02] p-3"
        }`}>
          {children}
        </div>
      )}
    </div>
  );
}

function LoreEntryList({ entries }: { entries: CharacterLoreEntryDTO[] }) {
  const enabled = entries.filter((e) => e.enabled);
  if (enabled.length === 0) return null;
  return (
    <div className="mt-2 space-y-2 border-t border-white/5 pt-2">
      {enabled.map((entry) => (
        <div key={entry.id} className="rounded border border-white/5 bg-white/[0.02] p-2 text-xs space-y-1">
          <div className="flex flex-wrap items-center gap-1">
            {entry.keys.map((key) => (
              <span key={key} className="inline-block rounded-full bg-ember-500/15 px-1.5 py-0.5 text-xs font-medium text-ember-300">
                {key}
              </span>
            ))}
            {entry.alwaysActive && (
              <span className="inline-block rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-xs font-medium text-emerald-300">
                always
              </span>
            )}
          </div>
          <p className="text-slate-400 whitespace-pre-wrap">{entry.content}</p>
        </div>
      ))}
    </div>
  );
}

function MatchedLoreEntryList({ entries }: { entries: MatchedLoreEntryDTO[] }) {
  if (entries.length === 0) return null;
  return (
    <div className="mt-2 space-y-2 border-t border-white/5 pt-2">
      {entries.map((entry) => (
        <div key={entry.id} className="rounded border border-white/5 bg-white/[0.02] p-2 text-xs space-y-1">
          <div className="flex flex-wrap items-center gap-1">
            {entry.keys.map((key) => (
              <span key={key} className="inline-block rounded-full bg-ember-500/15 px-1.5 py-0.5 text-xs font-medium text-ember-300">
                {key}
              </span>
            ))}
            {entry.alwaysActive && (
              <span className="inline-block rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-xs font-medium text-emerald-300">
                always
              </span>
            )}
            <span className="inline-block rounded-full bg-sky-500/15 px-1.5 py-0.5 text-xs font-medium text-sky-300">
              {entry.scope}
            </span>
          </div>
          <p className="text-slate-400 whitespace-pre-wrap">{entry.content}</p>
        </div>
      ))}
    </div>
  );
}

export function DebugPromptDrawer({
  open,
  onClose,
  activeChat,
  character,
  debugMessage
}: {
  open: boolean;
  onClose: () => void;
  activeChat: ChatWithMessagesDTO | null;
  character: CharacterDTO | undefined;
  debugMessage?: MessageDTO | null;
}) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!open) return;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => {
      document.body.style.overflow = originalOverflow;
      window.removeEventListener("keydown", handleKey);
    };
  }, [open, onClose]);

  useEffect(() => {
    if (open) setCollapsed({});
  }, [open]);

  if (!open) return null;

  const toggleSection = (id: string) => {
    setCollapsed((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const isCollapsed = (id: string) => Boolean(collapsed[id]);

  const userConfig = activeChat
    ? parseUserCustomConfig(activeChat.userPersona)
    : { prefix: "", prompt: "", suffix: "" };

  const hasUserConfig =
    userConfig.prefix.trim() || userConfig.prompt.trim() || userConfig.suffix.trim();

  const hasProfile = Boolean(activeChat?.userProfileSummary?.trim());

  const privateCharacter = character && !character.canViewPrompt;

  const messageLoreMatches = debugMessage?.loreMatches ?? [];
  const hasMessageLore = messageLoreMatches.length > 0;

  const precedingUserMessage = debugMessage && activeChat
    ? (() => {
        const messages = activeChat.messages;
        const idx = messages.findIndex((m) => m.id === debugMessage.id);
        if (idx <= 0) return null;
        for (let i = idx - 1; i >= 0; i--) {
          if (messages[i].role === "user") return messages[i];
        }
        return null;
      })()
    : null;

  const content = (
    <div
      className="animate-fade-in fixed inset-0 z-50 grid place-items-end sm:place-items-center bg-black/70 p-0 sm:p-3 backdrop-blur-md sm:p-5"
      onClick={onClose}
    >
      <section
        className="animate-modal-enter flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl sm:rounded-2xl border border-white/[0.06] bg-ink-900 shadow-2xl shadow-black/70 will-change-[transform,opacity] sm:max-h-[calc(100dvh-3rem)] safe-area-bottom"
        role="dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/[0.06] px-5 py-3.5 sm:px-6 sm:py-4">
          <h3 className="min-w-0 truncate text-base font-semibold tracking-tight text-slate-100">
            {t("debug.title")}
          </h3>
          <button
            className="grid h-[48px] w-[48px] shrink-0 place-items-center rounded-lg text-slate-500 transition-all duration-200 hover:bg-white/10 hover:text-slate-200 active:scale-90"
            type="button"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-4 sm:px-6 sm:pb-6 space-y-4">
          <p className="text-xs leading-5 text-slate-500">
            {t("debug.intro")}
          </p>
          <CollapsibleSection
            id="character"
            title={t("debug.characterPrompt")}
            defaultOpen={false}
            collapsed={isCollapsed("character")}
            onToggle={toggleSection}
          >
            {character ? (
              privateCharacter ? (
                <EmptyHint text={t("debug.characterPromptPrivate")} />
              ) : (
                <div className="space-y-3">
                  <CollapsibleSection
                    id="char-prefix"
                    title={t("debug.prefix")}
                    defaultOpen={false}
                    collapsed={isCollapsed("char-prefix")}
                    onToggle={toggleSection}
                    level={2}
                  >
                    {character.prefix.trim() ? character.prefix : <EmptyHint text="—" />}
                    <LoreEntryList entries={character.loreEntries.filter((e) => e.scope === "prefix")} />
                  </CollapsibleSection>
                  <CollapsibleSection
                    id="char-prompt"
                    title={t("debug.prompt")}
                    defaultOpen={false}
                    collapsed={isCollapsed("char-prompt")}
                    onToggle={toggleSection}
                    level={2}
                  >
                    {character.prompt.trim() ? character.prompt : <EmptyHint text="—" />}
                    <LoreEntryList entries={character.loreEntries.filter((e) => e.scope === "prompt")} />
                  </CollapsibleSection>
                  <CollapsibleSection
                    id="char-suffix"
                    title={t("debug.suffix")}
                    defaultOpen={false}
                    collapsed={isCollapsed("char-suffix")}
                    onToggle={toggleSection}
                    level={2}
                  >
                    {character.suffix.trim() ? character.suffix : <EmptyHint text="—" />}
                    <LoreEntryList entries={character.loreEntries.filter((e) => e.scope === "suffix")} />
                  </CollapsibleSection>
                </div>
              )
            ) : (
              <EmptyHint text={t("debug.noCharacter")} />
            )}
          </CollapsibleSection>

          <CollapsibleSection
            id="userMessage"
            title={t("debug.userMessage")}
            defaultOpen={false}
            collapsed={isCollapsed("userMessage")}
            onToggle={toggleSection}
          >
            {precedingUserMessage ? (
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-300">
                {precedingUserMessage.content}
              </p>
            ) : (
              <EmptyHint text={t("debug.noUserMessage")} />
            )}
          </CollapsibleSection>

          <CollapsibleSection
            id="messageLore"
            title={t("debug.messageLoreMatches")}
            defaultOpen={false}
            collapsed={isCollapsed("messageLore")}
            onToggle={toggleSection}
          >
            {hasMessageLore ? (
              <MatchedLoreEntryList entries={messageLoreMatches} />
            ) : (
              <EmptyHint text={t("debug.messageLoreNoMatches")} />
            )}
          </CollapsibleSection>

          <CollapsibleSection
            id="userConfig"
            title={t("debug.userCustomConfig")}
            defaultOpen={false}
            collapsed={isCollapsed("userConfig")}
            onToggle={toggleSection}
          >
            {hasUserConfig ? (
              <div className="space-y-3">
                <CollapsibleSection
                  id="cfg-prefix"
                  title={t("debug.configPrefix")}
                  defaultOpen={false}
                  collapsed={isCollapsed("cfg-prefix")}
                  onToggle={toggleSection}
                  level={2}
                >
                  {userConfig.prefix.trim() ? userConfig.prefix : <EmptyHint text="—" />}
                </CollapsibleSection>
                <CollapsibleSection
                  id="cfg-prompt"
                  title={t("debug.configPrompt")}
                  defaultOpen={false}
                  collapsed={isCollapsed("cfg-prompt")}
                  onToggle={toggleSection}
                  level={2}
                >
                  {userConfig.prompt.trim() ? userConfig.prompt : <EmptyHint text="—" />}
                </CollapsibleSection>
                <CollapsibleSection
                  id="cfg-suffix"
                  title={t("debug.configSuffix")}
                  defaultOpen={false}
                  collapsed={isCollapsed("cfg-suffix")}
                  onToggle={toggleSection}
                  level={2}
                >
                  {userConfig.suffix.trim() ? userConfig.suffix : <EmptyHint text="—" />}
                </CollapsibleSection>
              </div>
            ) : (
              <EmptyHint text={t("debug.userCustomConfigEmpty")} />
            )}
          </CollapsibleSection>

          <CollapsibleSection
            id="profile"
            title={t("debug.userProfileSummary")}
            defaultOpen={false}
            collapsed={isCollapsed("profile")}
            onToggle={toggleSection}
          >
            {hasProfile ? (
              activeChat!.userProfileSummary
            ) : (
              <EmptyHint text={t("debug.userProfileEmpty")} />
            )}
          </CollapsibleSection>
        </div>
      </section>
    </div>
  );

  return createPortal(content, document.body);
}
