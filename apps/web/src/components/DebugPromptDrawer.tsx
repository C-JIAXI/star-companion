import { ChevronDown, ChevronRight, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useState } from "react";
import { parseUserCustomConfig } from "@local-roleplay/shared";
import { useI18n } from "../i18n";
import type {
  CharacterDTO,
  ChatWithMessagesDTO,
  CharacterLoreEntryDTO,
  MessageDTO,
  PromptBreakdownDTO,
  PromptBreakdownSectionId
} from "../types";

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
        data-debug-section-toggle={id}
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

function LoreEntryList({ entries, triggeredIds }: { entries: CharacterLoreEntryDTO[]; triggeredIds: Set<string> }) {
  const matched = entries.filter((e) => e.enabled && triggeredIds.has(e.id));
  if (matched.length === 0) return null;
  return (
    <div className="mt-2 space-y-2 border-t border-white/5 pt-2">
      {matched.map((entry) => (
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

function PromptBreakdownPanel({ breakdown }: { breakdown: PromptBreakdownDTO }) {
  const { t } = useI18n();
  const sectionLabel = (id: PromptBreakdownSectionId) => {
    const labels: Record<PromptBreakdownSectionId, string> = {
      character: t("debug.breakdownCharacter"),
      user_persona: t("debug.breakdownPersona"),
      user_profile: t("debug.breakdownProfile"),
      lore: t("debug.breakdownLore"),
      memory: t("debug.breakdownMemory"),
      history: t("debug.breakdownHistory"),
      generation_instruction: t("debug.breakdownInstruction"),
      formatting: t("debug.breakdownFormatting")
    };
    return labels[id];
  };
  const maxTokens = Math.max(1, ...breakdown.sections.map((section) => section.tokenEstimate));

  return (
    <section className="border-b border-white/[0.06] pb-4" data-testid="prompt-breakdown">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="text-xs font-semibold text-slate-400">{t("debug.breakdownTitle")}</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-100" data-testid="prompt-breakdown-total">
            {breakdown.promptTokens.toLocaleString()}
            <span className="ml-1 text-xs font-medium text-slate-500">tokens</span>
          </p>
        </div>
        <p className="text-xs tabular-nums text-slate-500">
          {t("debug.breakdownMessages", { count: breakdown.includedMessageCount })}
        </p>
      </div>

      <div className="mt-4 space-y-3">
        {breakdown.sections.map((section) => (
          <div data-prompt-breakdown-section={section.id} key={section.id}>
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="min-w-0 truncate font-medium text-slate-300">
                {sectionLabel(section.id)}
              </span>
              <span className="shrink-0 tabular-nums text-slate-500">
                {t("debug.breakdownSectionMeta", {
                  tokens: section.tokenEstimate.toLocaleString(),
                  count: section.itemCount
                })}
              </span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
              <div
                className="h-full rounded-full bg-ember-400/80"
                style={{ width: `${Math.max(2, (section.tokenEstimate / maxTokens) * 100)}%` }}
              />
            </div>
          </div>
        ))}
      </div>

      <p className="mt-4 text-xs leading-5 text-slate-500">
        {breakdown.promptTokensEstimated
          ? t("debug.breakdownEstimatedNote")
          : t("debug.breakdownProviderNote")}
      </p>
    </section>
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
  const triggeredLoreIds = new Set(messageLoreMatches.map((e) => e.id));
  const messageMemoryMatches = debugMessage?.memoryMatches ?? [];

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
      className="animate-fade-in fixed inset-0 z-50 grid place-items-center bg-black/70 p-3 backdrop-blur-md sm:p-5"
      onClick={onClose}
    >
      <section
        className="animate-modal-enter flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-lg border border-white/[0.08] bg-ink-900 shadow-xl shadow-black/60 will-change-[transform,opacity] sm:max-h-[calc(100dvh-3rem)]"
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
          {debugMessage?.promptBreakdown ? (
            <PromptBreakdownPanel breakdown={debugMessage.promptBreakdown} />
          ) : null}
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
                    <LoreEntryList entries={character.loreEntries.filter((e) => e.scope === "prefix")} triggeredIds={triggeredLoreIds} />
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
                    <LoreEntryList entries={character.loreEntries.filter((e) => e.scope === "prompt")} triggeredIds={triggeredLoreIds} />
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
                    <LoreEntryList entries={character.loreEntries.filter((e) => e.scope === "suffix")} triggeredIds={triggeredLoreIds} />
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

          <CollapsibleSection
            id="chatMemories"
            title={t("debug.chatMemories")}
            defaultOpen={false}
            collapsed={isCollapsed("chatMemories")}
            onToggle={toggleSection}
          >
            {messageMemoryMatches.length ? (
              <div className="space-y-2">
                {messageMemoryMatches.map((memory) => (
                  <div key={memory.id} className="rounded border border-white/5 bg-white/[0.02] p-2 text-xs">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-semibold text-slate-200">{memory.title}</span>
                      <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 font-medium text-emerald-300">
                        {memory.importance}
                      </span>
                    </div>
                    {memory.keywords.length ? (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {memory.keywords.map((keyword) => (
                          <span key={keyword} className="rounded-full bg-ember-500/15 px-1.5 py-0.5 font-medium text-ember-300">
                            {keyword}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    <p className="mt-1 whitespace-pre-wrap text-slate-400">{memory.content}</p>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyHint text={t("debug.chatMemoriesEmpty")} />
            )}
          </CollapsibleSection>
        </div>
      </section>
    </div>
  );

  return createPortal(content, document.body);
}
