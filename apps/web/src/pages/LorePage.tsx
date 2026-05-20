import { Check, Plus, Save, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { api } from "../lib/api";
import { joinTags, splitTags } from "../lib/form";
import type { LoreEntryDTO, LorebookDTO, LorebookWithEntriesDTO } from "../types";
import { Badge, Button, ConfirmDialog, EmptyState, ErrorNotice, Field, HelpLabel, Panel, TextArea, TextInput } from "../components/ui";

export function LorePage() {
  const { t } = useI18n();
  const [lorebooks, setLorebooks] = useState<LorebookDTO[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<LorebookWithEntriesDTO | null>(null);
  const [bookName, setBookName] = useState("");
  const [bookDescription, setBookDescription] = useState("");
  const [entryKeys, setEntryKeys] = useState("");
  const [entryContent, setEntryContent] = useState("");
  const [entryPriority, setEntryPriority] = useState(0);
  const [entryEnabled, setEntryEnabled] = useState(true);
  const [editingEntry, setEditingEntry] = useState<LoreEntryDTO | null>(null);
  const [editingEntryContent, setEditingEntryContent] = useState("");
  const [deleteBookOpen, setDeleteBookOpen] = useState(false);
  const [pendingDeleteEntryId, setPendingDeleteEntryId] = useState<string | null>(null);
  const [editingEntryKeys, setEditingEntryKeys] = useState("");
  const [editingEntryPriority, setEditingEntryPriority] = useState(0);
  const [editingEntryEnabled, setEditingEntryEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const loadLorebooks = async () => {
    const data = await api.lorebooks.list();
    setLorebooks(data);
    if (!selectedId && data[0]) {
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

  const createLorebook = async () => {
    setLoading(true);
    setError(null);
    try {
      const lorebook = await api.lorebooks.create({
        name: bookName.trim() || t("lore.create"),
        description: bookDescription
      });
      setSelectedId(lorebook.id);
      await loadLorebooks();
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
    try {
      await api.lorebooks.update(selected.id, { name: bookName, description: bookDescription });
      await loadLorebooks();
      await loadSelected(selected.id);
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
    try {
      await api.lorebooks.remove(selected.id);
      setDeleteBookOpen(false);
      setSelectedId(null);
      setSelected(null);
      setBookName("");
      setBookDescription("");
      await loadLorebooks();
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
    try {
      await api.lorebooks.createEntry(selected.id, {
        keys: splitTags(entryKeys),
        content: entryContent,
        priority: entryPriority,
        enabled: entryEnabled
      });
      setEntryKeys("");
      setEntryContent("");
      setEntryPriority(0);
      setEntryEnabled(true);
      await loadSelected(selected.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("lore.failedCreateEntry"));
    } finally {
      setLoading(false);
    }
  };

  const startEditingEntry = (entry: LoreEntryDTO) => {
    setEditingEntry(entry);
    setEditingEntryContent(entry.content);
    setEditingEntryKeys(joinTags(entry.keys));
    setEditingEntryPriority(entry.priority);
    setEditingEntryEnabled(entry.enabled);
  };

  const cancelEditingEntry = () => {
    setEditingEntry(null);
    setEditingEntryContent("");
    setEditingEntryKeys("");
    setEditingEntryPriority(0);
    setEditingEntryEnabled(true);
  };

  const saveEditingEntry = async () => {
    if (!editingEntry || !selected) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await api.lorebooks.updateEntry(editingEntry.id, {
        keys: splitTags(editingEntryKeys),
        content: editingEntryContent,
        priority: editingEntryPriority,
        enabled: editingEntryEnabled
      });
      cancelEditingEntry();
      await loadSelected(selected.id);
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
    <div className="grid gap-6 lg:grid-cols-[340px_1fr]">
      <Panel
        title={<HelpLabel label={t("nav.lore")} description={t("help.lorebook")} />}
        action={
          <Button
            variant="secondary"
            className="!min-h-[32px] !h-8 !px-3 text-xs"
            onClick={() => {
              setSelectedId(null);
              setSelected(null);
              setBookName("");
              setBookDescription("");
            }}
          >
            <Plus size={14} />
            {t("common.new")}
          </Button>
        }
      >
        <div className="space-y-2.5">
          {lorebooks.length === 0 ? (
            <EmptyState>{t("lore.noLorebooks")}</EmptyState>
          ) : (
            lorebooks.map((lorebook) => (
              <button
                className={`group w-full rounded-xl border p-3.5 text-left text-sm transition-all duration-200 ${
                  selectedId === lorebook.id
                    ? "border-ember-500/50 bg-ember-500/10 shadow-md shadow-ember-500/5"
                    : "border-white/5 bg-white/5 hover:border-white/10 hover:bg-white/10"
                }`}
                key={lorebook.id}
                type="button"
                onClick={() => setSelectedId(lorebook.id)}
              >
                <p className={`font-medium transition-colors ${selectedId === lorebook.id ? 'text-ember-100' : 'text-slate-100 group-hover:text-white'}`}>{lorebook.name}</p>
                <p className="mt-1 line-clamp-2 text-xs text-slate-400">{lorebook.description || t("common.noDescription")}</p>
              </button>
            ))
          )}
        </div>
      </Panel>

      <div className="space-y-6">
        <Panel title={selected ? t("lore.edit") : t("lore.create")}>
          <div className="space-y-4">
            <ErrorNotice message={error} />
            <Field label={t("common.name")}><TextInput value={bookName} onChange={(event) => setBookName(event.target.value)} /></Field>
            <Field label={t("common.description")}><TextArea className="min-h-[80px]" value={bookDescription} onChange={(event) => setBookDescription(event.target.value)} /></Field>
            <div className="flex flex-wrap justify-end gap-3 pt-2 border-t border-white/5">
              <Button disabled={loading || !selected} variant="danger" onClick={() => setDeleteBookOpen(true)}><Trash2 size={16} />{t("common.delete")}</Button>
              <Button disabled={loading || !bookName.trim()} onClick={() => void (selected ? updateLorebook() : createLorebook())}><Save size={16} />{t("common.save")}</Button>
            </div>
          </div>
        </Panel>

        <Panel title={t("lore.entries")}>
          {!selected ? (
            <EmptyState>{t("lore.selectBeforeEntries")}</EmptyState>
          ) : (
            <div className="space-y-6">
              <div className="space-y-4 p-4 rounded-xl bg-ink-950/50 border border-white/5">
                <div className="grid gap-4 md:grid-cols-[1fr_120px]">
                  <Field label={<HelpLabel label={t("lore.keys")} description={t("help.loreKeys")} />}><TextInput placeholder={t("lore.keysPlaceholder")} value={entryKeys} onChange={(event) => setEntryKeys(event.target.value)} /></Field>
                  <Field label={<HelpLabel label={t("common.priority")} description={t("help.lorePriority")} />}><TextInput type="number" value={entryPriority} onChange={(event) => setEntryPriority(Number(event.target.value))} /></Field>
                </div>
                <Field label={<HelpLabel label={t("lore.content")} description={t("help.loreContent")} />}><TextArea className="min-h-[80px]" value={entryContent} onChange={(event) => setEntryContent(event.target.value)} /></Field>
                <div className="flex items-center justify-between gap-4 pt-2">
                  <label className="flex cursor-pointer items-center gap-2.5 text-sm font-medium text-slate-300 transition-colors hover:text-slate-200">
                    <input checked={entryEnabled} type="checkbox" onChange={(event) => setEntryEnabled(event.target.checked)} className="rounded border-white/20 bg-ink-950 text-ember-500 focus:ring-ember-500/50" />
                    {t("common.enabled")}
                  </label>
                  <Button disabled={loading || !entryContent.trim()} onClick={() => void createEntry()}><Plus size={16} />{t("lore.addEntry")}</Button>
                </div>
              </div>

              <div className="space-y-3">
                {selected.entries.length === 0 ? (
                  <EmptyState>{t("lore.noEntries")}</EmptyState>
                ) : (
                  selected.entries.map((entry) => (
                    <article className={`group rounded-xl border p-4 text-sm transition-all duration-200 ${entry.enabled ? 'border-white/10 bg-white/5' : 'border-white/5 bg-white/[0.02] opacity-70'}`} key={entry.id}>
                      <div className="flex flex-wrap items-center justify-between gap-4 mb-3">
                        <div className="flex flex-wrap gap-1.5">
                          {entry.keys.map((key) => <Badge key={key}>{key}</Badge>)}
                          <Badge>{t("common.priority")} {entry.priority}</Badge>
                          <Badge>{entry.enabled ? t("common.enabled") : t("common.disabled")}</Badge>
                        </div>
                        <div className="flex gap-2 transition-opacity">
                          <Button className="!min-h-[32px] !h-8 !px-3 text-xs" variant="secondary" onClick={() => void toggleEntry(entry.id, entry.enabled)}>{entry.enabled ? t("lore.disable") : t("lore.enable")}</Button>
                          <Button className="!min-h-[32px] !h-8 !px-3 text-xs" variant="secondary" onClick={() => startEditingEntry(entry)}>{t("common.edit")}</Button>
                          <Button className="!min-h-[32px] !h-8 !w-8 !p-0" variant="danger" onClick={() => setPendingDeleteEntryId(entry.id)}><Trash2 size={14} /></Button>
                        </div>
                      </div>
                      <p className="whitespace-pre-wrap leading-relaxed text-slate-200">{entry.content}</p>
                    </article>
                  ))
                )}
              </div>
            </div>
          )}
        </Panel>
      </div>
    </div>
    {editingEntry ? (
      <div className="animate-fade-in fixed inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-sm p-4">
        <section
          aria-labelledby="edit-lore-entry-title"
          className="animate-scale-in w-full max-w-2xl rounded-2xl border border-white/10 bg-ink-900 p-6 shadow-2xl shadow-black/50"
          role="dialog"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-lg font-semibold tracking-tight text-slate-100" id="edit-lore-entry-title">
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
          <div className="mt-6 space-y-4">
            <div className="grid gap-4 md:grid-cols-[1fr_140px]">
              <Field label={<HelpLabel label={t("lore.keys")} description={t("help.loreKeys")} />}>
                <TextInput
                  autoFocus
                  placeholder={t("lore.keysPlaceholder")}
                  value={editingEntryKeys}
                  onChange={(event) => setEditingEntryKeys(event.target.value)}
                />
              </Field>
              <Field label={<HelpLabel label={t("common.priority")} description={t("help.lorePriority")} />}>
                <TextInput
                  type="number"
                  value={editingEntryPriority}
                  onChange={(event) => setEditingEntryPriority(Number(event.target.value))}
                />
              </Field>
            </div>
            <Field label={<HelpLabel label={t("lore.content")} description={t("help.loreContent")} />}>
              <TextArea
                className="min-h-[200px] text-base leading-relaxed"
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
              <input checked={editingEntryEnabled} type="checkbox" onChange={(event) => setEditingEntryEnabled(event.target.checked)} className="rounded border-white/20 bg-ink-950 text-ember-500 focus:ring-ember-500/50" />
              {t("common.enabled")}
            </label>
          </div>
          <div className="mt-6 flex flex-wrap justify-end gap-3 pt-4 border-t border-white/5">
            <Button disabled={loading} variant="ghost" onClick={cancelEditingEntry}>
              <X size={16} />
              {t("common.cancel")}
            </Button>
            <Button disabled={loading || !editingEntryContent.trim()} onClick={() => void saveEditingEntry()}>
              <Check size={16} />
              {t("lore.saveEntry")}
            </Button>
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
