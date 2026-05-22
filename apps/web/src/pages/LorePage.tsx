import { BookOpenText, Check, Filter, Plus, Save, Search, Sparkles, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useI18n } from "../i18n";
import { api } from "../lib/api";
import { joinTags, splitTags } from "../lib/form";
import type { LoreEntryDTO, LoreTriggerMode, LorebookDTO, LorebookWithEntriesDTO } from "../types";
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorNotice,
  Field,
  HelpLabel,
  Panel,
  SuccessNotice,
  TextArea,
  TextInput
} from "../components/ui";

function StatCard({
  label,
  value,
  helper,
  emphasis = false,
  compact = false
}: {
  label: string;
  value: string | number;
  helper?: string;
  emphasis?: boolean;
  compact?: boolean;
}) {
  return (
    <div
      className={`rounded-2xl border px-4 ${compact ? "py-3" : "py-4"} shadow-inner shadow-black/10 ${
        emphasis ? "border-slate-800/70 bg-ember-500/[0.08]" : "border-slate-800/75 bg-ink-950/60"
      }`}
    >
      <p
        className={`text-[11px] font-medium uppercase tracking-[0.18em] ${
          emphasis ? "text-ember-300/75" : "text-slate-500"
        }`}
      >
        {label}
      </p>
      <p
        className={`${compact ? "mt-2 text-2xl" : "mt-3 text-3xl"} font-semibold tracking-tight text-slate-50`}
      >
        {value}
      </p>
      {helper ? <p className="mt-1 text-xs text-slate-400">{helper}</p> : null}
    </div>
  );
}

function EntryMetaBadge({
  children,
  tone = "neutral"
}: {
  children: ReactNode;
  tone?: "neutral" | "accent" | "success";
}) {
  const tones = {
    neutral: "border-slate-800/70 bg-white/[0.04] text-slate-300",
    accent: "border-ember-500/20 bg-ember-500/[0.10] text-ember-100",
    success: "border-emerald-500/18 bg-emerald-500/[0.10] text-emerald-100"
  } as const;

  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  size = "md",
  fullWidth = false,
  mobileColumns = 1,
  desktopColumns,
  disabled = false
}: {
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: string }>;
  size?: "sm" | "md";
  fullWidth?: boolean;
  mobileColumns?: 1 | 2 | 3 | 4;
  desktopColumns?: 1 | 2 | 3 | 4;
  disabled?: boolean;
}) {
  const sizeClasses =
    size === "sm"
      ? "min-h-[32px] rounded-lg px-3 text-xs"
      : "min-h-[40px] rounded-xl px-3.5 text-sm";
  const gridColumns = {
    1: "grid-cols-1",
    2: "grid-cols-2",
    3: "grid-cols-3",
    4: "grid-cols-4"
  } as const;
  const responsiveColumns = {
    1: "sm:grid-cols-1",
    2: "sm:grid-cols-2",
    3: "sm:grid-cols-3",
    4: "sm:grid-cols-4"
  } as const;

  return (
    <div
      aria-disabled={disabled}
      className={`gap-1 rounded-xl border border-slate-800/70 bg-ink-950/55 p-1 shadow-inner shadow-black/10 ${
        fullWidth
          ? `grid w-full ${gridColumns[mobileColumns]} ${
              desktopColumns ? responsiveColumns[desktopColumns] : ""
            }`
          : "inline-flex flex-wrap"
      } ${disabled ? "opacity-70" : ""}`}
    >
      {options.map((option) => {
        const active = option.value === value;
        if (disabled) {
          return (
            <span
              key={option.value}
              aria-disabled="true"
              className={`${sizeClasses} ${
                fullWidth ? "w-full min-w-0" : "min-w-[88px]"
              } grid cursor-not-allowed place-items-center border border-transparent text-slate-600`}
            >
              {option.label}
            </span>
          );
        }

        return (
          <button
            key={option.value}
            aria-pressed={active}
            className={`${sizeClasses} ${
              fullWidth ? "w-full min-w-0" : "min-w-[88px]"
            } border transition-all duration-200 ${
              active
                ? "border-ember-500/30 bg-ember-500/15 text-ember-50 shadow-sm shadow-ember-500/10"
                : "border-transparent bg-transparent text-slate-400 hover:bg-white/6 hover:text-slate-200"
            }`}
            type="button"
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function SideDrawer({
  open,
  title,
  description,
  badge,
  children,
  footer,
  onClose
}: {
  open: boolean;
  title: string;
  description?: string;
  badge?: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
}) {
  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50">
      <button
        aria-label="Close drawer"
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        type="button"
        onClick={onClose}
      />
      <aside
        aria-modal="true"
        className="absolute right-0 top-0 flex h-full w-full max-w-[520px] flex-col border-l border-slate-800/75 bg-ink-900 shadow-2xl shadow-black/50"
        role="dialog"
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-800/70 px-5 py-5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-lg font-semibold tracking-tight text-slate-100">{title}</h3>
              {badge ? <EntryMetaBadge tone="accent">{badge}</EntryMetaBadge> : null}
            </div>
            {description ? (
              <p className="mt-2 text-sm leading-6 text-slate-400">{description}</p>
            ) : null}
          </div>
          <button
            aria-label="Close drawer"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white/5 text-slate-400 transition-colors hover:bg-white/10 hover:text-slate-200"
            type="button"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <div className="custom-scrollbar flex-1 overflow-y-auto px-5 py-5">{children}</div>
        {footer ? <div className="border-t border-slate-800/70 px-5 py-4">{footer}</div> : null}
      </aside>
    </div>
  );
}

export function LorePage() {
  const { t } = useI18n();
  const [lorebooks, setLorebooks] = useState<LorebookDTO[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<LorebookWithEntriesDTO | null>(null);
  const [bookQuery, setBookQuery] = useState("");
  const [bookName, setBookName] = useState("");
  const [bookDescription, setBookDescription] = useState("");
  const [entryKeys, setEntryKeys] = useState("");
  const [entryContent, setEntryContent] = useState("");
  const [entryPriority, setEntryPriority] = useState(0);
  const [entryTriggerMode, setEntryTriggerMode] = useState<LoreTriggerMode>("both");
  const [entryAlwaysActive, setEntryAlwaysActive] = useState(false);
  const [entryEnabled, setEntryEnabled] = useState(true);
  const [entryQuery, setEntryQuery] = useState("");
  const [entryStatusFilter, setEntryStatusFilter] = useState<"all" | "enabled" | "disabled">("all");
  const [entryTriggerFilter, setEntryTriggerFilter] = useState<"all" | LoreTriggerMode>("all");
  const [editingEntry, setEditingEntry] = useState<LoreEntryDTO | null>(null);
  const [editingEntryContent, setEditingEntryContent] = useState("");
  const [editingEntryKeys, setEditingEntryKeys] = useState("");
  const [editingEntryPriority, setEditingEntryPriority] = useState(0);
  const [editingEntryTriggerMode, setEditingEntryTriggerMode] = useState<LoreTriggerMode>("both");
  const [editingEntryAlwaysActive, setEditingEntryAlwaysActive] = useState(false);
  const [editingEntryEnabled, setEditingEntryEnabled] = useState(true);
  const [bookEditorOpen, setBookEditorOpen] = useState(false);
  const [bookEditorMode, setBookEditorMode] = useState<"create" | "edit">("edit");
  const [entryComposerOpen, setEntryComposerOpen] = useState(false);
  const [deleteBookOpen, setDeleteBookOpen] = useState(false);
  const [pendingDeleteEntryId, setPendingDeleteEntryId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const triggerModeOptions: Array<{ value: LoreTriggerMode; label: string }> = [
    { value: "user", label: t("lore.triggerMode.user") },
    { value: "assistant", label: t("lore.triggerMode.assistant") },
    { value: "both", label: t("lore.triggerMode.both") }
  ];

  const getTriggerModeLabel = (value: LoreTriggerMode) =>
    triggerModeOptions.find((option) => option.value === value)?.label ??
    t("lore.triggerMode.both");

  const statusFilterOptions: Array<{ value: "all" | "enabled" | "disabled"; label: string }> = [
    { value: "all", label: t("lore.filterAll") },
    { value: "enabled", label: t("lore.filterEnabled") },
    { value: "disabled", label: t("lore.filterDisabled") }
  ];

  const triggerFilterOptions: Array<{ value: "all" | LoreTriggerMode; label: string }> = [
    { value: "all", label: t("lore.filterAll") },
    { value: "user", label: t("lore.triggerMode.user") },
    { value: "assistant", label: t("lore.triggerMode.assistant") },
    { value: "both", label: t("lore.triggerMode.both") }
  ];

  const clearSelectedBook = () => {
    setSelectedId(null);
    setSelected(null);
    setBookName("");
    setBookDescription("");
    setEntryQuery("");
  };

  const resetEntryComposer = () => {
    setEntryKeys("");
    setEntryContent("");
    setEntryPriority(0);
    setEntryTriggerMode("both");
    setEntryAlwaysActive(false);
    setEntryEnabled(true);
  };

  const loadLorebooks = async (preferredSelection?: null | string) => {
    const data = await api.lorebooks.list();
    setLorebooks(data);

    const activeSelection = preferredSelection === undefined ? selectedId : preferredSelection;
    if (!activeSelection && data[0]) {
      setSelectedId(data[0].id);
    }
  };

  const loadSelected = async (id: string | null) => {
    if (!id) {
      setSelected(null);
      return;
    }
    const data = await api.lorebooks.get(id);
    setSelected(data);
    setBookName(data.name);
    setBookDescription(data.description);
  };

  useEffect(() => {
    void loadLorebooks().catch((caught: unknown) =>
      setError(caught instanceof Error ? caught.message : t("lore.failedLoad"))
    );
  }, [t]);

  useEffect(() => {
    void loadSelected(selectedId).catch((caught: unknown) =>
      setError(caught instanceof Error ? caught.message : t("lore.failedLoadBook"))
    );
  }, [selectedId, t]);

  useEffect(() => {
    if (!status) {
      return;
    }

    const timeoutId = window.setTimeout(() => setStatus(null), 2200);
    return () => window.clearTimeout(timeoutId);
  }, [status]);

  const selectedStats = useMemo(() => {
    if (!selected) {
      return null;
    }

    const entries = selected.entries;
    const enabledCount = entries.filter((entry) => entry.enabled).length;
    const highestPriority = entries.length
      ? Math.max(...entries.map((entry) => entry.priority))
      : 0;

    return {
      total: entries.length,
      enabled: enabledCount,
      highestPriority,
      userTriggers: entries.filter((entry) => !entry.alwaysActive && entry.triggerMode === "user").length,
      assistantTriggers: entries.filter((entry) => !entry.alwaysActive && entry.triggerMode === "assistant").length,
      sharedTriggers: entries.filter((entry) => !entry.alwaysActive && entry.triggerMode === "both").length,
      alwaysActive: entries.filter((entry) => entry.alwaysActive).length
    };
  }, [selected]);

  const filteredLorebooks = useMemo(() => {
    const normalizedQuery = bookQuery.trim().toLowerCase();
    if (!normalizedQuery) {
      return lorebooks;
    }

    return lorebooks.filter(
      (lorebook) =>
        lorebook.name.toLowerCase().includes(normalizedQuery) ||
        lorebook.description.toLowerCase().includes(normalizedQuery)
    );
  }, [bookQuery, lorebooks]);

  const filteredEntries = useMemo(() => {
    if (!selected) {
      return [];
    }

    const normalizedQuery = entryQuery.trim().toLowerCase();
    return selected.entries.filter((entry) => {
      const keysMatch = entry.keys.some((key) => key.toLowerCase().includes(normalizedQuery));
      const contentMatch = entry.content.toLowerCase().includes(normalizedQuery);
      const queryMatch = !normalizedQuery || keysMatch || contentMatch;
      const statusMatch =
        entryStatusFilter === "all" ||
        (entryStatusFilter === "enabled" && entry.enabled) ||
        (entryStatusFilter === "disabled" && !entry.enabled);
      const triggerMatch =
        entryTriggerFilter === "all" ||
        (!entry.alwaysActive && entry.triggerMode === entryTriggerFilter);

      return queryMatch && statusMatch && triggerMatch;
    });
  }, [entryQuery, entryStatusFilter, entryTriggerFilter, selected]);

  const openCreateBookEditor = () => {
    setBookEditorMode("create");
    setBookName("");
    setBookDescription("");
    setBookEditorOpen(true);
    setError(null);
  };

  const openEditBookEditor = () => {
    if (!selected) {
      return;
    }
    setBookEditorMode("edit");
    setBookName(selected.name);
    setBookDescription(selected.description);
    setBookEditorOpen(true);
    setError(null);
  };

  const closeBookEditor = () => {
    setBookEditorOpen(false);
    if (selected) {
      setBookName(selected.name);
      setBookDescription(selected.description);
    } else {
      setBookName("");
      setBookDescription("");
    }
  };

  const openEntryComposer = () => {
    if (!selected) {
      return;
    }
    resetEntryComposer();
    setEntryComposerOpen(true);
    setError(null);
  };

  const closeEntryComposer = () => {
    setEntryComposerOpen(false);
    resetEntryComposer();
  };

  const createLorebook = async () => {
    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const lorebook = await api.lorebooks.create({
        name: bookName.trim() || t("lore.create"),
        description: bookDescription
      });
      setSelectedId(lorebook.id);
      setBookEditorOpen(false);
      await loadLorebooks(lorebook.id);
      setStatus(t("lore.saved"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("lore.failedSave"));
    } finally {
      setLoading(false);
    }
  };

  const updateLorebook = async () => {
    if (!selected) {
      return;
    }
    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      await api.lorebooks.update(selected.id, { name: bookName, description: bookDescription });
      await loadLorebooks(selected.id);
      await loadSelected(selected.id);
      setBookEditorOpen(false);
      setStatus(t("lore.saved"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("lore.failedUpdate"));
    } finally {
      setLoading(false);
    }
  };

  const deleteLorebook = async () => {
    if (!selected) {
      return;
    }
    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      await api.lorebooks.remove(selected.id);
      setDeleteBookOpen(false);
      setBookEditorOpen(false);
      clearSelectedBook();
      await loadLorebooks(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("lore.failedDeleteBook"));
    } finally {
      setLoading(false);
    }
  };

  const createEntry = async () => {
    if (!selected) {
      return;
    }
    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      await api.lorebooks.createEntry(selected.id, {
        keys: splitTags(entryKeys),
        content: entryContent,
        priority: entryPriority,
        triggerMode: entryTriggerMode,
        alwaysActive: entryAlwaysActive,
        enabled: entryEnabled
      });
      closeEntryComposer();
      await loadSelected(selected.id);
      setStatus(t("lore.entrySaved"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("lore.failedCreateEntry"));
    } finally {
      setLoading(false);
    }
  };

  const startEditingEntry = (entry: LoreEntryDTO) => {
    setEditingEntry(entry);
    setStatus(null);
    setEditingEntryContent(entry.content);
    setEditingEntryKeys(joinTags(entry.keys));
    setEditingEntryPriority(entry.priority);
    setEditingEntryTriggerMode(entry.triggerMode);
    setEditingEntryAlwaysActive(entry.alwaysActive);
    setEditingEntryEnabled(entry.enabled);
  };

  const cancelEditingEntry = () => {
    setEditingEntry(null);
    setEditingEntryContent("");
    setEditingEntryKeys("");
    setEditingEntryPriority(0);
    setEditingEntryTriggerMode("both");
    setEditingEntryAlwaysActive(false);
    setEditingEntryEnabled(true);
  };

  const saveEditingEntry = async () => {
    if (!editingEntry || !selected) {
      return;
    }
    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      await api.lorebooks.updateEntry(editingEntry.id, {
        keys: splitTags(editingEntryKeys),
        content: editingEntryContent,
        priority: editingEntryPriority,
        triggerMode: editingEntryTriggerMode,
        alwaysActive: editingEntryAlwaysActive,
        enabled: editingEntryEnabled
      });
      cancelEditingEntry();
      await loadSelected(selected.id);
      setStatus(t("lore.entrySaved"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("lore.failedEditEntry"));
    } finally {
      setLoading(false);
    }
  };

  const toggleEntry = async (entryId: string, enabled: boolean) => {
    if (!selected) {
      return;
    }
    await api.lorebooks.updateEntry(entryId, { enabled: !enabled });
    await loadSelected(selected.id);
  };

  const deleteEntry = async (entryId: string) => {
    if (!selected) {
      return;
    }
    await api.lorebooks.removeEntry(entryId);
    setPendingDeleteEntryId(null);
    await loadSelected(selected.id);
  };

  return (
    <>
      <div className="space-y-6">
        <ErrorNotice message={error} />
        <SuccessNotice message={status} />

        <div className="grid gap-6 xl:grid-cols-[320px_minmax(0,1fr)]">
          <Panel
            className="h-auto xl:sticky xl:top-4 xl:max-h-[calc(100vh-2rem)] xl:overflow-hidden"
            title={<HelpLabel label={t("nav.lore")} description={t("help.lorebook")} />}
            action={
              <Button
                variant="secondary"
                className="!min-h-[32px] !h-8 !px-3 text-xs"
                onClick={openCreateBookEditor}
              >
                <Plus size={14} />
                {t("common.new")}
              </Button>
            }
          >
            <div className="flex h-full min-h-0 flex-col">
              <div className="mb-4 grid grid-cols-2 gap-2">
                <StatCard compact label={t("lore.statsBooks")} value={lorebooks.length} />
                <StatCard
                  compact
                  label={t("lore.statsEntries")}
                  value={selected?.entries.length ?? 0}
                />
              </div>

              <div className="relative mb-4">
                <Search
                  size={15}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"
                />
                <TextInput
                  className="!h-10 pl-9"
                  placeholder={t("lore.bookSearchPlaceholder")}
                  value={bookQuery}
                  onChange={(event) => setBookQuery(event.target.value)}
                />
              </div>

              <div className="custom-scrollbar min-h-0 flex-1 space-y-2.5 overflow-y-auto pr-1">
                {filteredLorebooks.length === 0 ? (
                  <EmptyState>{t("lore.noLorebooks")}</EmptyState>
                ) : (
                  filteredLorebooks.map((lorebook) => (
                    <button
                      className={`group w-full rounded-xl border px-3.5 py-3 text-left text-sm transition-all duration-200 ${
                        selectedId === lorebook.id
                          ? "border-ember-500/50 bg-ember-500/10 shadow-md shadow-ember-500/5"
                          : "border-slate-800/65 bg-white/5 hover:border-slate-700/75 hover:bg-white/10"
                      }`}
                      key={lorebook.id}
                      type="button"
                      onClick={() => setSelectedId(lorebook.id)}
                    >
                      <div className="flex items-start gap-3">
                        <div
                          className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl border text-sm font-semibold ${
                            selectedId === lorebook.id
                              ? "border-ember-500/30 bg-ember-500/12 text-ember-100"
                              : "border-slate-800/70 bg-ink-950/55 text-slate-300"
                          }`}
                        >
                          {lorebook.name.slice(0, 1).toUpperCase()}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p
                            className={`font-medium transition-colors ${
                              selectedId === lorebook.id
                                ? "text-ember-100"
                                : "text-slate-100 group-hover:text-white"
                            }`}
                          >
                            {lorebook.name}
                          </p>
                          <p className="mt-1 line-clamp-2 text-xs text-slate-400">
                            {lorebook.description || t("common.noDescription")}
                          </p>
                        </div>
                        <div className="mt-0.5 shrink-0">
                          {selectedId === lorebook.id ? (
                            <Sparkles size={14} className="text-ember-300" />
                          ) : (
                            <span className="inline-flex rounded-full border border-slate-800/70 px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-slate-500">
                              {t("common.select")}
                            </span>
                          )}
                        </div>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>
          </Panel>

          <div className="min-w-0 space-y-6">
            <Panel
              className="h-auto"
              title={selected ? t("lore.currentBook") : t("nav.lore")}
              action={
                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={!selected}
                    variant="secondary"
                    className="!min-h-[34px] !h-8 !px-3 text-xs"
                    onClick={openEditBookEditor}
                  >
                    {t("common.edit")}
                  </Button>
                  <Button
                    disabled={!selected}
                    className="!min-h-[34px] !h-8 !px-3 text-xs"
                    onClick={openEntryComposer}
                  >
                    <Plus size={14} />
                    {t("lore.addEntry")}
                  </Button>
                </div>
              }
            >
              <div className="space-y-5">
                <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(260px,360px)] lg:items-start">
                  <div className="flex min-w-0 gap-4">
                    <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl border border-slate-800/70 bg-white/[0.04] text-ember-300 shadow-inner shadow-black/10">
                      <BookOpenText size={20} />
                    </div>
                    <div className="min-w-0">
                      <h2 className="text-2xl font-semibold tracking-tight text-slate-50">
                        {selected ? selected.name : t("lore.create")}
                      </h2>
                      <p className="mt-2 max-w-3xl text-sm leading-7 text-slate-300">
                        {selected
                          ? selected.description || t("common.noDescription")
                          : t("lore.selectBeforeEntries")}
                      </p>
                    </div>
                  </div>

                  {selected && selectedStats ? (
                    <div className="grid grid-cols-3 gap-2">
                      <StatCard
                        compact
                        emphasis
                        label={t("lore.statsEntries")}
                        value={selectedStats.total}
                      />
                      <StatCard
                        compact
                        label={t("lore.statsEnabled")}
                        value={selectedStats.enabled}
                      />
                      <StatCard
                        compact
                        label={t("lore.statsPriority")}
                        value={selectedStats.highestPriority}
                      />
                    </div>
                  ) : null}
                </div>

                {selected && selectedStats ? (
                  <div className="flex flex-wrap gap-2 border-y border-slate-800/60 py-3">
                    <EntryMetaBadge tone="accent">
                      {t("lore.triggerMode.user")} {selectedStats.userTriggers}
                    </EntryMetaBadge>
                    <EntryMetaBadge tone="accent">
                      {t("lore.triggerMode.assistant")} {selectedStats.assistantTriggers}
                    </EntryMetaBadge>
                    <EntryMetaBadge tone="accent">
                      {t("lore.triggerMode.both")} {selectedStats.sharedTriggers}
                    </EntryMetaBadge>
                    <EntryMetaBadge tone="success">
                      {t("lore.alwaysActive")} {selectedStats.alwaysActive}
                    </EntryMetaBadge>
                    <EntryMetaBadge>
                      {t("lore.filteredResults", {
                        count: filteredEntries.length,
                        total: selected.entries.length
                      })}
                    </EntryMetaBadge>
                  </div>
                ) : null}

                {!selected ? (
                  <EmptyState>{t("lore.selectBeforeEntries")}</EmptyState>
                ) : (
                  <div className="space-y-4">
                    <div className="rounded-xl border border-slate-800/70 bg-ink-950/50 p-4 shadow-inner shadow-black/10">
                      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
                        <div className="relative">
                          <Search
                            size={15}
                            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"
                          />
                          <TextInput
                            className="!h-10 pl-9"
                            placeholder={t("lore.entrySearchPlaceholder")}
                            value={entryQuery}
                            onChange={(event) => setEntryQuery(event.target.value)}
                          />
                        </div>
                        <div className="flex items-center gap-2 text-sm text-slate-400">
                          <Filter size={15} />
                          <span>
                            {t("lore.filteredResults", {
                              count: filteredEntries.length,
                              total: selected.entries.length
                            })}
                          </span>
                        </div>
                      </div>

                      <div className="mt-4 grid gap-3 border-t border-slate-800/65 pt-4 lg:grid-cols-2">
                        <div className="space-y-2">
                          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">
                            {t("lore.filterStatus")}
                          </p>
                          <SegmentedControl
                            fullWidth
                            desktopColumns={3}
                            mobileColumns={3}
                            options={statusFilterOptions}
                            size="sm"
                            value={entryStatusFilter}
                            onChange={setEntryStatusFilter}
                          />
                        </div>
                        <div className="space-y-2">
                          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">
                            {t("lore.filterTrigger")}
                          </p>
                          <SegmentedControl
                            fullWidth
                            desktopColumns={4}
                            mobileColumns={2}
                            options={triggerFilterOptions}
                            size="sm"
                            value={entryTriggerFilter}
                            onChange={setEntryTriggerFilter}
                          />
                        </div>
                      </div>
                    </div>

                    {filteredEntries.length === 0 ? (
                      <EmptyState>
                        {entryQuery.trim() ? t("lore.filteredEmpty") : t("lore.noEntries")}
                      </EmptyState>
                    ) : (
                      <div className="space-y-3">
                        {filteredEntries.map((entry) => (
                          <article
                            className={`rounded-xl border p-4 text-sm transition-all duration-200 ${
                              entry.enabled
                                ? "border-slate-700/60 bg-white/[0.05] shadow-sm shadow-black/10 hover:border-slate-600/70 hover:bg-white/[0.065]"
                                : "border-slate-800/55 bg-white/[0.025] opacity-80"
                            }`}
                            key={entry.id}
                          >
                            <div className="flex gap-4">
                              <div
                                className={`mt-1.5 h-12 w-1.5 shrink-0 rounded-full ${
                                  entry.enabled
                                    ? "bg-ember-400 shadow-[0_0_18px_rgba(251,146,60,0.32)]"
                                    : "bg-slate-700"
                                }`}
                              />
                              <div className="min-w-0 flex-1 space-y-4">
                                <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                                  <div className="min-w-0">
                                    <div className="flex flex-wrap gap-2">
                                      {entry.keys.map((key) => (
                                        <Badge key={key}>{key}</Badge>
                                      ))}
                                    </div>
                                    <p className="mt-3 whitespace-pre-wrap text-[15px] leading-7 text-slate-100">
                                      {entry.content}
                                    </p>
                                  </div>

                                  <div className="flex flex-wrap gap-2 xl:justify-end">
                                    <Button
                                      className="!min-h-[32px] !h-8 !px-3 text-xs"
                                      variant="secondary"
                                      onClick={() => void toggleEntry(entry.id, entry.enabled)}
                                    >
                                      {entry.enabled ? t("lore.disable") : t("lore.enable")}
                                    </Button>
                                    <Button
                                      className="!min-h-[32px] !h-8 !px-3 text-xs"
                                      variant="secondary"
                                      onClick={() => startEditingEntry(entry)}
                                    >
                                      {t("common.edit")}
                                    </Button>
                                    <Button
                                      className="!min-h-[32px] !h-8 !w-8 !p-0"
                                      variant="danger"
                                      onClick={() => setPendingDeleteEntryId(entry.id)}
                                    >
                                      <Trash2 size={14} />
                                    </Button>
                                  </div>
                                </div>

                                <div className="flex flex-wrap gap-2 border-t border-slate-800/65 pt-3">
                                  <EntryMetaBadge>
                                    {t("common.priority")} {entry.priority}
                                  </EntryMetaBadge>
                                  {entry.alwaysActive ? (
                                    <EntryMetaBadge tone="success">
                                      {t("lore.alwaysActive")}
                                    </EntryMetaBadge>
                                  ) : (
                                    <EntryMetaBadge tone="accent">
                                      {getTriggerModeLabel(entry.triggerMode)}
                                    </EntryMetaBadge>
                                  )}
                                  <EntryMetaBadge tone={entry.enabled ? "success" : "neutral"}>
                                    {entry.enabled ? t("common.enabled") : t("common.disabled")}
                                  </EntryMetaBadge>
                                </div>
                              </div>
                            </div>
                          </article>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </Panel>
          </div>
        </div>
      </div>

      <SideDrawer
        badge={bookEditorMode === "edit" && selected ? selected.name : undefined}
        description={
          bookEditorMode === "create"
            ? t("help.lorebook")
            : selected?.description || t("common.noDescription")
        }
        footer={
          <div className={`grid gap-3 ${bookEditorMode === "edit" ? "sm:grid-cols-2" : ""}`}>
            {bookEditorMode === "edit" && selected ? (
              <Button disabled={loading} variant="danger" onClick={() => setDeleteBookOpen(true)}>
                <Trash2 size={16} />
                {t("common.delete")}
              </Button>
            ) : null}
            <Button
              disabled={loading || !bookName.trim()}
              onClick={() =>
                void (bookEditorMode === "create" ? createLorebook() : updateLorebook())
              }
            >
              <Save size={16} />
              {t("common.save")}
            </Button>
          </div>
        }
        open={bookEditorOpen}
        title={bookEditorMode === "create" ? t("lore.create") : t("lore.edit")}
        onClose={closeBookEditor}
      >
        <div className="space-y-4">
          <Field label={t("common.name")}>
            <TextInput value={bookName} onChange={(event) => setBookName(event.target.value)} />
          </Field>
          <Field label={t("common.description")}>
            <TextArea
              className="!h-32 min-h-[128px]"
              value={bookDescription}
              onChange={(event) => setBookDescription(event.target.value)}
            />
          </Field>
        </div>
      </SideDrawer>

      <SideDrawer
        badge={selected?.name}
        description={selected ? t("lore.composerSubtitle", { name: selected.name }) : undefined}
        footer={
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <label className="flex cursor-pointer items-center gap-2.5 text-sm font-medium text-slate-300 transition-colors hover:text-slate-200">
              <input
                checked={entryEnabled}
                type="checkbox"
                onChange={(event) => setEntryEnabled(event.target.checked)}
                className="rounded border-slate-700/70 bg-ink-950 text-ember-500 focus:ring-ember-500/50"
              />
              {t("common.enabled")}
            </label>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Button variant="ghost" onClick={closeEntryComposer}>
                {t("common.cancel")}
              </Button>
              <Button disabled={loading || !entryContent.trim()} onClick={() => void createEntry()}>
                <Plus size={16} />
                {t("lore.addEntry")}
              </Button>
            </div>
          </div>
        }
        open={entryComposerOpen && Boolean(selected)}
        title={t("lore.composerTitle")}
        onClose={closeEntryComposer}
      >
        <div className="space-y-4">
          <Field label={<HelpLabel label={t("lore.keys")} description={t("help.loreKeys")} />}>
            <TextInput
              placeholder={t("lore.keysPlaceholder")}
              value={entryKeys}
              onChange={(event) => setEntryKeys(event.target.value)}
            />
          </Field>
          <Field
            label={<HelpLabel label={t("common.priority")} description={t("help.lorePriority")} />}
          >
            <TextInput
              type="number"
              value={entryPriority}
              onChange={(event) => setEntryPriority(Number(event.target.value))}
            />
          </Field>
          <Field
            label={
              <HelpLabel label={t("lore.triggerMode")} description={t("help.loreTriggerMode")} />
            }
          >
            <SegmentedControl
              fullWidth
              desktopColumns={3}
              disabled={entryAlwaysActive}
              mobileColumns={1}
              options={triggerModeOptions}
              value={entryTriggerMode}
              onChange={setEntryTriggerMode}
            />
          </Field>
          <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-slate-800/70 bg-ink-950/45 p-3 text-sm font-medium text-slate-300 transition-colors hover:text-slate-200">
            <input
              checked={entryAlwaysActive}
              type="checkbox"
              onChange={(event) => setEntryAlwaysActive(event.target.checked)}
              className="mt-1 rounded border-slate-700/70 bg-ink-950 text-ember-500 focus:ring-ember-500/50"
            />
            <span className="min-w-0">
              <HelpLabel label={t("lore.alwaysActive")} description={t("help.loreAlwaysActive")} />
            </span>
          </label>
          <Field
            label={<HelpLabel label={t("lore.content")} description={t("help.loreContent")} />}
          >
            <TextArea
              className="!h-56 min-h-[224px]"
              value={entryContent}
              onChange={(event) => setEntryContent(event.target.value)}
            />
          </Field>
        </div>
      </SideDrawer>

      {editingEntry ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-3 backdrop-blur-sm sm:p-4">
          <section
            aria-labelledby="edit-lore-entry-title"
            className="animate-scale-in flex max-h-[calc(100dvh-1.5rem)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-slate-800/75 bg-ink-900 shadow-2xl shadow-black/50 sm:max-h-[calc(100dvh-2rem)]"
            role="dialog"
          >
            <div className="shrink-0 border-b border-slate-800/70 px-5 py-5 sm:px-6">
              <div className="flex items-start justify-between gap-4">
              <div>
                <h3
                  className="text-lg font-semibold tracking-tight text-slate-100"
                  id="edit-lore-entry-title"
                >
                  {t("lore.editEntryTitle")}
                </h3>
                <p className="mt-1 text-sm text-slate-400">{t("lore.editEntryHelp")}</p>
              </div>
              <button
                aria-label={t("common.cancel")}
                className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white/5 text-slate-400 transition-colors hover:bg-white/10 hover:text-slate-200"
                type="button"
                onClick={cancelEditingEntry}
              >
                <X size={18} />
              </button>
              </div>
            </div>
            <div className="custom-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-5 sm:px-6">
              <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_140px]">
                <Field
                  label={<HelpLabel label={t("lore.keys")} description={t("help.loreKeys")} />}
                >
                  <TextInput
                    autoFocus
                    placeholder={t("lore.keysPlaceholder")}
                    value={editingEntryKeys}
                    onChange={(event) => setEditingEntryKeys(event.target.value)}
                  />
                </Field>
                <Field
                  label={
                    <HelpLabel label={t("common.priority")} description={t("help.lorePriority")} />
                  }
                >
                  <TextInput
                    type="number"
                    value={editingEntryPriority}
                    onChange={(event) => setEditingEntryPriority(Number(event.target.value))}
                  />
                </Field>
              </div>
              <Field
                label={
                  <HelpLabel
                    label={t("lore.triggerMode")}
                    description={t("help.loreTriggerMode")}
                  />
                }
              >
                <SegmentedControl
                  fullWidth
                  desktopColumns={3}
                  disabled={editingEntryAlwaysActive}
                  mobileColumns={1}
                  options={triggerModeOptions}
                  value={editingEntryTriggerMode}
                  onChange={setEditingEntryTriggerMode}
                />
              </Field>
              <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-slate-800/70 bg-ink-950/45 p-3 text-sm font-medium text-slate-300 transition-colors hover:text-slate-200">
                <input
                  checked={editingEntryAlwaysActive}
                  type="checkbox"
                  onChange={(event) => setEditingEntryAlwaysActive(event.target.checked)}
                  className="mt-1 rounded border-slate-700/70 bg-ink-950 text-ember-500 focus:ring-ember-500/50"
                />
                <span className="min-w-0">
                  <HelpLabel
                    label={t("lore.alwaysActive")}
                    description={t("help.loreAlwaysActive")}
                  />
                </span>
              </label>
              <Field
                label={<HelpLabel label={t("lore.content")} description={t("help.loreContent")} />}
              >
                <TextArea
                  className="!h-64 min-h-[256px] text-base leading-relaxed"
                  placeholder={t("lore.editEntryPlaceholder")}
                  value={editingEntryContent}
                  onChange={(event) => setEditingEntryContent(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      cancelEditingEntry();
                    }

                    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                      event.preventDefault();
                      void saveEditingEntry();
                    }
                  }}
                />
              </Field>
              <label className="flex cursor-pointer items-center gap-2.5 text-sm font-medium text-slate-300 transition-colors hover:text-slate-200">
                <input
                  checked={editingEntryEnabled}
                  type="checkbox"
                  onChange={(event) => setEditingEntryEnabled(event.target.checked)}
                  className="rounded border-slate-700/70 bg-ink-950 text-ember-500 focus:ring-ember-500/50"
                />
                {t("common.enabled")}
              </label>
            </div>
            <div className="shrink-0 border-t border-slate-800/60 px-5 py-4 sm:px-6">
              <div className="flex flex-wrap justify-end gap-3">
              <Button disabled={loading} variant="ghost" onClick={cancelEditingEntry}>
                <X size={16} />
                {t("common.cancel")}
              </Button>
              <Button
                disabled={loading || !editingEntryContent.trim()}
                onClick={() => void saveEditingEntry()}
              >
                <Check size={16} />
                {t("lore.saveEntry")}
              </Button>
              </div>
            </div>
          </section>
        </div>
      ) : null}

      {deleteBookOpen && selected ? (
        <ConfirmDialog
          cancelLabel={t("common.cancel")}
          confirmLabel={t("common.delete")}
          loading={loading}
          message={t("lore.deleteBookConfirm", { name: selected.name })}
          title={t("lore.deleteBookTitle")}
          onCancel={() => setDeleteBookOpen(false)}
          onConfirm={() => void deleteLorebook()}
        />
      ) : null}

      {pendingDeleteEntryId ? (
        <ConfirmDialog
          cancelLabel={t("common.cancel")}
          confirmLabel={t("common.delete")}
          loading={loading}
          message={t("lore.deleteEntryConfirm")}
          title={t("lore.deleteEntryTitle")}
          onCancel={() => setPendingDeleteEntryId(null)}
          onConfirm={() => void deleteEntry(pendingDeleteEntryId)}
        />
      ) : null}
    </>
  );
}
