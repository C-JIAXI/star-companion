import { BookPlus, Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { api } from "../lib/api";
import { joinTags, splitTags } from "../lib/form";
import type { LorebookDTO, LorebookWithEntriesDTO } from "../types";
import { Badge, Button, EmptyState, ErrorNotice, Field, HelpLabel, Panel, TextArea, TextInput } from "../components/ui";

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
    if (!selected || !window.confirm(t("lore.deleteBookConfirm", { name: selected.name }))) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await api.lorebooks.remove(selected.id);
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

  const editEntry = async (entryId: string, currentContent: string) => {
    const nextContent = window.prompt(t("lore.editEntryPrompt"), currentContent);
    if (nextContent === null || !selected) {
      return;
    }
    await api.lorebooks.updateEntry(entryId, { content: nextContent });
    await loadSelected(selected.id);
  };

  const toggleEntry = async (entryId: string, enabled: boolean) => {
    if (!selected) {
      return;
    }
    await api.lorebooks.updateEntry(entryId, { enabled: !enabled });
    await loadSelected(selected.id);
  };

  const deleteEntry = async (entryId: string) => {
    if (!selected || !window.confirm(t("lore.deleteEntryConfirm"))) {
      return;
    }
    await api.lorebooks.removeEntry(entryId);
    await loadSelected(selected.id);
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
      <Panel title={<HelpLabel label={t("nav.lore")} description={t("help.lorebook")} />} action={<BookPlus size={18} className="text-ember-400" />}>
        <div className="space-y-2">
          {lorebooks.length === 0 ? (
            <EmptyState>{t("lore.noLorebooks")}</EmptyState>
          ) : (
            lorebooks.map((lorebook) => (
              <button
                className={`w-full rounded-md border p-3 text-left text-sm ${
                  selectedId === lorebook.id
                    ? "border-ember-500 bg-ember-500/10"
                    : "border-white/10 bg-white/5 hover:bg-white/10"
                }`}
                key={lorebook.id}
                type="button"
                onClick={() => setSelectedId(lorebook.id)}
              >
                <p className="font-medium">{lorebook.name}</p>
                <p className="line-clamp-2 text-xs text-slate-400">{lorebook.description || t("common.noDescription")}</p>
              </button>
            ))
          )}
        </div>
      </Panel>

      <div className="space-y-4">
        <Panel
          title={selected ? t("lore.edit") : t("lore.create")}
          action={<Button variant="ghost" onClick={() => { setSelectedId(null); setSelected(null); setBookName(""); setBookDescription(""); }}><Plus size={16} />{t("common.new")}</Button>}
        >
          <div className="space-y-3">
            <ErrorNotice message={error} />
            <Field label={t("common.name")}><TextInput value={bookName} onChange={(event) => setBookName(event.target.value)} /></Field>
            <Field label={t("common.description")}><TextArea value={bookDescription} onChange={(event) => setBookDescription(event.target.value)} /></Field>
            <div className="flex flex-wrap gap-2">
              <Button disabled={loading || !bookName.trim()} onClick={() => void (selected ? updateLorebook() : createLorebook())}><Save size={16} />{t("common.save")}</Button>
              <Button disabled={loading || !selected} variant="danger" onClick={() => void deleteLorebook()}><Trash2 size={16} />{t("common.delete")}</Button>
            </div>
          </div>
        </Panel>

        <Panel title={t("lore.entries")}>
          {!selected ? (
            <EmptyState>{t("lore.selectBeforeEntries")}</EmptyState>
          ) : (
            <div className="space-y-4">
              <div className="grid gap-3 md:grid-cols-[1fr_120px]">
                <Field label={<HelpLabel label={t("lore.keys")} description={t("help.loreKeys")} />}><TextInput placeholder={t("lore.keysPlaceholder")} value={entryKeys} onChange={(event) => setEntryKeys(event.target.value)} /></Field>
                <Field label={<HelpLabel label={t("common.priority")} description={t("help.lorePriority")} />}><TextInput type="number" value={entryPriority} onChange={(event) => setEntryPriority(Number(event.target.value))} /></Field>
              </div>
              <Field label={<HelpLabel label={t("lore.content")} description={t("help.loreContent")} />}><TextArea value={entryContent} onChange={(event) => setEntryContent(event.target.value)} /></Field>
              <label className="flex items-center gap-2 text-sm text-slate-300">
                <input checked={entryEnabled} type="checkbox" onChange={(event) => setEntryEnabled(event.target.checked)} />
                {t("common.enabled")}
              </label>
              <Button disabled={loading || !entryContent.trim()} onClick={() => void createEntry()}><Plus size={16} />{t("lore.addEntry")}</Button>

              <div className="space-y-3">
                {selected.entries.length === 0 ? (
                  <EmptyState>{t("lore.noEntries")}</EmptyState>
                ) : (
                  selected.entries.map((entry) => (
                    <article className="rounded-md border border-white/10 bg-white/5 p-3 text-sm" key={entry.id}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap gap-2">
                          {entry.keys.map((key) => <Badge key={key}>{key}</Badge>)}
                          <Badge>{t("common.priority")} {entry.priority}</Badge>
                          <Badge>{entry.enabled ? t("common.enabled") : t("common.disabled")}</Badge>
                        </div>
                        <div className="flex gap-2">
                          <Button className="min-h-8 px-2" variant="ghost" onClick={() => void toggleEntry(entry.id, entry.enabled)}>{entry.enabled ? t("lore.disable") : t("lore.enable")}</Button>
                          <Button className="min-h-8 px-2" variant="ghost" onClick={() => void editEntry(entry.id, entry.content)}>{t("common.edit")}</Button>
                          <Button className="min-h-8 px-2" variant="danger" onClick={() => void deleteEntry(entry.id)}><Trash2 size={14} /></Button>
                        </div>
                      </div>
                      <p className="mt-3 whitespace-pre-wrap text-slate-200">{entry.content}</p>
                      <p className="mt-2 text-xs text-slate-500">{t("lore.keysDisplay", { keys: joinTags(entry.keys) })}</p>
                    </article>
                  ))
                )}
              </div>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
