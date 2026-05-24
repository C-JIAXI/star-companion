import { ChevronDown, Copy, Download, FileUp, Plus, Save, Search, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { api } from "../lib/api";
import { downloadJson, readFileText } from "../lib/files";
import type { CharacterDTO, CharacterInput, CharacterLoreEntryDTO } from "../types";
import { Button, ConfirmDialog, EmptyState, ErrorNotice, Field, HelpLabel, Panel, SuccessNotice, TextArea, TextInput } from "../components/ui";

const blankLoreEntry = (): CharacterLoreEntryDTO & { _localId: string; _collapsed: boolean } => ({
  id: "",
  keys: [],
  content: "",
  priority: 0,
  triggerMode: "both",
  alwaysActive: false,
  enabled: true,
  _localId: Math.random().toString(36).slice(2),
  _collapsed: false
});

type LoreEntryForm = ReturnType<typeof blankLoreEntry>;

const blankForm = {
  name: "",
  avatar: "",
  prefix: "",
  prompt: "",
  suffix: "",
  relationship: "",
  loreEntries: [] as LoreEntryForm[]
};

type CharacterForm = typeof blankForm;

const toForm = (character: CharacterDTO): CharacterForm => ({
  name: character.name,
  avatar: character.avatar ?? "",
  prefix: character.prefix,
  prompt: character.prompt,
  suffix: character.suffix,
  relationship: character.relationship,
  loreEntries: (character.loreEntries ?? []).map((entry) => ({
      id: entry.id,
      keys: entry.keys,
      content: entry.content,
      priority: entry.priority,
      triggerMode: entry.triggerMode,
      alwaysActive: entry.alwaysActive,
      enabled: entry.enabled,
      _localId: Math.random().toString(36).slice(2),
      _collapsed: true
    }))
});

const toInput = (form: CharacterForm): CharacterInput => ({
  name: form.name,
  avatar: form.avatar || null,
  prefix: form.prefix,
  prompt: form.prompt,
  suffix: form.suffix,
  relationship: form.relationship,
  loreEntries: form.loreEntries.map(({ _localId, ...entry }) => entry)
});

type ImportedCharacter = Partial<CharacterInput> & {
  description?: string;
  scenario?: string;
  systemPrompt?: string;
  avatar?: string | null;
  loreEntries?: CharacterLoreEntryDTO[];
};

export function CharactersPage() {
  const { t } = useI18n();
  const [characters, setCharacters] = useState<CharacterDTO[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<CharacterForm>(blankForm);
  const [searchQuery, setSearchQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const creatingRef = useRef(false);

  const selected = useMemo(
    () => characters.find((character) => character.id === selectedId) ?? null,
    [characters, selectedId]
  );

  const filteredCharacters = useMemo(() => {
    const keyword = searchQuery.trim().toLowerCase();
    if (!keyword) {
      return characters;
    }

    return characters.filter((character) =>
      [character.name, character.avatar ?? "", character.prefix, character.prompt, character.suffix]
        .join("\n")
        .toLowerCase()
        .includes(keyword)
    );
  }, [characters, searchQuery]);

  const loadCharacters = async () => {
    const data = await api.characters.list();
    setCharacters(data);
    if (!selectedId && !creatingRef.current && data[0]) {
      setSelectedId(data[0].id);
      setForm(toForm(data[0]));
    }
  };

  useEffect(() => {
    void loadCharacters().catch((caught: unknown) =>
      setError(caught instanceof Error ? caught.message : t("characters.failedLoad"))
    );
  }, [t]);

  useEffect(() => {
    if (!status) {
      return;
    }

    const timeoutId = window.setTimeout(() => setStatus(null), 2200);
    return () => window.clearTimeout(timeoutId);
  }, [status]);

  const selectCharacter = (character: CharacterDTO) => {
    creatingRef.current = false;
    setSelectedId(character.id);
    setForm(toForm(character));
    setError(null);
    setStatus(null);
  };

  const resetForm = () => {
    creatingRef.current = true;
    setSelectedId(null);
    setForm(blankForm);
    setError(null);
    setStatus(null);
  };

  const saveCharacter = async () => {
    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const editingCharacter = creatingRef.current ? null : selected;
      if (editingCharacter) {
        await api.characters.update(editingCharacter.id, toInput(form));
      } else {
        await api.characters.create(toInput(form));
      }
      await loadCharacters();
      if (!editingCharacter) {
        creatingRef.current = false;
        setForm(blankForm);
      }
      setStatus(t("characters.saved"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("characters.failedSave"));
    } finally {
      setLoading(false);
    }
  };

  const deleteCharacter = async () => {
    if (!selected) {
      return;
    }

    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      await api.characters.remove(selected.id);
      setDeleteConfirmOpen(false);
      setSelectedId(null);
      setForm(blankForm);
      await loadCharacters();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("characters.failedDelete"));
    } finally {
      setLoading(false);
    }
  };

  const duplicateCharacter = async () => {
    if (!selected) {
      return;
    }

    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const duplicated = await api.characters.create({
        ...toInput(toForm(selected)),
        name: `${selected.name} ${t("characters.copySuffix")}`,
        loreEntries: (selected.loreEntries ?? []).map(({ id: _id, ...rest }) => rest)
      });
      await loadCharacters();
      setSelectedId(duplicated.id);
      setForm(toForm(duplicated));
      setStatus(t("characters.duplicated"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("characters.failedSave"));
    } finally {
      setLoading(false);
    }
  };

  const exportCharacter = () => {
    if (selected) {
      downloadJson(`${selected.name || "character"}.json`, selected);
    }
  };

  const importCharacter = async (file: File | undefined) => {
    if (!file) {
      return;
    }

    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const parsed = JSON.parse(await readFileText(file)) as ImportedCharacter;
      if (!parsed.name) {
        throw new Error(t("characters.importMissingName"));
      }
      await api.characters.create({
        name: parsed.name,
        avatar: parsed.avatar ?? null,
        prefix: parsed.prefix ?? parsed.systemPrompt ?? "",
        prompt: parsed.prompt ?? parsed.description ?? "",
        suffix: parsed.suffix ?? parsed.scenario ?? "",
        relationship: parsed.relationship ?? "",
        loreEntries: parsed.loreEntries ?? []
      });
      await loadCharacters();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("characters.failedImport"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[340px_1fr]">
      <Panel
        title={t("nav.characters")}
        action={
          <Button variant="secondary" onClick={resetForm} className="!min-h-[32px] !h-8 !px-3 text-xs">
            <Plus size={14} />
            {t("common.new")}
          </Button>
        }
      >
        <div className="space-y-2.5">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size={16} />
            <TextInput
              className="pl-9"
              placeholder={t("characters.searchPlaceholder")}
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
          </div>
          {characters.length === 0 ? (
            <EmptyState>{t("characters.noCharacters")}</EmptyState>
          ) : filteredCharacters.length === 0 ? (
            <EmptyState>{t("characters.noSearchResults")}</EmptyState>
          ) : (
            filteredCharacters.map((character) => (
              <button
                className={`group w-full rounded-xl border p-3.5 text-left text-sm transition-all duration-200 ${
                  selectedId === character.id
                    ? "border-ember-500/50 bg-ember-500/10 shadow-md shadow-ember-500/5"
                    : "border-white/5 bg-white/5 hover:border-white/10 hover:bg-white/10"
                }`}
                key={character.id}
                type="button"
                onClick={() => selectCharacter(character)}
              >
                <div className="flex items-start gap-3.5">
                  <div className={`grid h-12 w-12 shrink-0 place-items-center rounded-lg bg-ink-800 text-sm font-semibold transition-all duration-200 ${selectedId === character.id ? 'ring-2 ring-ember-500/50 ring-offset-2 ring-offset-ink-900' : 'group-hover:scale-105'}`}>
                    {character.avatar ? <img alt="" className="h-full w-full rounded-lg object-cover" src={character.avatar} /> : character.name.slice(0, 2)}
                  </div>
                  <div className="min-w-0 pt-0.5">
                    <p className={`truncate font-medium transition-colors ${selectedId === character.id ? 'text-ember-100' : 'text-slate-100 group-hover:text-white'}`}>{character.name}</p>
                    <p className="mt-1 line-clamp-2 text-xs text-slate-400">{character.prompt || character.prefix || t("common.noDescription")}</p>
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      </Panel>

      <Panel
        title={selected ? t("characters.edit") : t("characters.create")}
        action={
          <div className="flex flex-wrap gap-2">
            <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg bg-white/5 px-3 text-xs font-medium text-slate-200 transition-colors hover:bg-white/10 focus-within:ring-2 focus-within:ring-white/20">
              <FileUp size={14} />
              {t("common.import")}
              <input className="sr-only" type="file" accept="application/json" onChange={(event) => void importCharacter(event.target.files?.[0])} />
            </label>
            <Button disabled={!selected} variant="ghost" onClick={exportCharacter} className="!min-h-[36px] !h-9 !px-3 text-xs">
              <Download size={14} />
              {t("common.export")}
            </Button>
          </div>
        }
      >
        <div className="space-y-6">
          <ErrorNotice message={error} />
          <SuccessNotice message={status} />
          <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_120px]">
            <div className="grid gap-5">
            <Field label={t("common.name")}><TextInput value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field>
            <Field label={t("characters.avatarUrl")}><TextInput value={form.avatar} onChange={(event) => setForm({ ...form, avatar: event.target.value })} /></Field>
            </div>
            <div className="grid min-h-[120px] place-items-center rounded-xl border border-white/5 bg-ink-950/40 p-3">
              <div className="grid h-20 w-20 place-items-center overflow-hidden rounded-xl bg-ink-800 text-lg font-semibold text-slate-300 ring-1 ring-white/10">
                {form.avatar ? (
                  <img alt="" className="h-full w-full object-cover" src={form.avatar} />
                ) : (
                  (form.name || t("common.unknown")).slice(0, 2)
                )}
              </div>
            </div>
          </div>

          <Field label={<HelpLabel label={t("characters.relationship")} description={t("help.characterRelationship")} />}><TextInput value={form.relationship} onChange={(event) => setForm({ ...form, relationship: event.target.value })} /></Field>

          <Field label={<HelpLabel label={t("characters.prefix")} description={t("help.characterPrefix")} />}><TextArea value={form.prefix} onChange={(event) => setForm({ ...form, prefix: event.target.value })} className="min-h-[120px]" /></Field>
          <Field label={<HelpLabel label={t("characters.prompt")} description={t("help.characterPrompt")} />}><TextArea value={form.prompt} onChange={(event) => setForm({ ...form, prompt: event.target.value })} className="min-h-[180px]" /></Field>
          <Field label={<HelpLabel label={t("characters.suffix")} description={t("help.characterSuffix")} />}><TextArea value={form.suffix} onChange={(event) => setForm({ ...form, suffix: event.target.value })} className="min-h-[120px]" /></Field>

          <div className="border-t border-white/5 pt-5">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-semibold text-slate-100">{t("characters.loreEntries")}</p>
              <span className="text-xs text-slate-500">
                {t("characters.loreEntryCount", { count: form.loreEntries.filter((e) => e.enabled).length })}
                {" · "}
                {t("characters.loreEntryCount", { count: form.loreEntries.length })}
              </span>
            </div>
            {form.loreEntries.length === 0 ? (
              <div className="rounded-xl border border-dashed border-white/10 px-4 py-6 text-center">
                <p className="text-sm text-slate-400">{t("characters.loreEntryEmpty")}</p>
              </div>
            ) : (
              <div className="space-y-3">
                {form.loreEntries.map((entry, index) => (
                  <div
                    className={`rounded-xl border transition-colors ${
                      entry.enabled
                        ? "border-white/10 bg-ink-950/40"
                        : "border-white/5 bg-ink-950/20 opacity-60"
                    }`}
                    key={entry._localId}
                  >
                    <div
                      className="flex cursor-pointer items-center justify-between gap-2 px-4 py-3 select-none"
                      onClick={() => {
                        const next = [...form.loreEntries];
                        next[index] = { ...entry, _collapsed: !entry._collapsed };
                        setForm({ ...form, loreEntries: next });
                      }}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <ChevronDown
                          className={`shrink-0 text-slate-500 transition-transform duration-200 ${
                            entry._collapsed ? "-rotate-90" : ""
                          }`}
                          size={14}
                        />
                        {entry.keys.length > 0 ? (
                          <span className="truncate text-xs font-medium text-amber-200/80">
                            {entry.keys.join(", ")}
                          </span>
                        ) : (
                          <span className="whitespace-nowrap text-xs font-medium text-slate-500">
                            {t("characters.loreEntryIndex", { index: index + 1 })}
                          </span>
                        )}
                        {entry._collapsed && entry.content ? (
                          <span className="hidden truncate text-xs text-slate-500 opacity-60 sm:inline">
                            — {entry.content}
                          </span>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <label
                          className="flex cursor-pointer items-center gap-1.5 rounded-lg px-1.5 py-1 text-xs text-slate-400 transition-colors hover:bg-white/5"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <input
                            checked={entry.enabled}
                            type="checkbox"
                            className="rounded border-white/20 bg-ink-950 text-ember-500 focus:ring-ember-500/50"
                            onChange={() => {
                              const next = [...form.loreEntries];
                              next[index] = { ...entry, enabled: !entry.enabled };
                              setForm({ ...form, loreEntries: next });
                            }}
                          />
                          {t("common.enabled")}
                        </label>
                        <button
                          className="rounded-lg p-1 text-slate-500 transition-colors hover:bg-red-500/10 hover:text-red-400"
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            const next = form.loreEntries.filter((_, i) => i !== index);
                            setForm({ ...form, loreEntries: next });
                          }}
                        >
                          <X size={14} />
                        </button>
                      </div>
                    </div>
                    <div
                      className={`overflow-hidden transition-all duration-200 ease-out ${
                        entry._collapsed
                          ? "max-h-0 border-t-0 opacity-0"
                          : "max-h-[1000px] border-t border-white/5 opacity-100"
                      }`}
                    >
                      <div className="px-4 pb-4 pt-3">
                        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_140px]">
                          <div className="space-y-3">
                            <Field label={t("characters.loreEntryKeys")}>
                              <TextInput
                                placeholder={t("characters.loreEntryKeysPlaceholder")}
                                value={entry.keys.join(", ")}
                                onChange={(event) => {
                                  const keys = event.target.value
                                    .split(/[,，]/)
                                    .map((k) => k.trim())
                                    .filter(Boolean);
                                  const next = [...form.loreEntries];
                                  next[index] = { ...entry, keys };
                                  setForm({ ...form, loreEntries: next });
                                }}
                              />
                            </Field>
                            <Field label={t("characters.loreEntryContent")}>
                              <TextArea
                                className="min-h-[80px]"
                                value={entry.content}
                                onChange={(event) => {
                                  const next = [...form.loreEntries];
                                  next[index] = { ...entry, content: event.target.value };
                                  setForm({ ...form, loreEntries: next });
                                }}
                              />
                            </Field>
                          </div>
                          <div className="space-y-3">
                            <Field label={t("common.priority")}>
                              <TextInput
                                type="number"
                                value={String(entry.priority)}
                                onChange={(event) => {
                                  const next = [...form.loreEntries];
                                  next[index] = {
                                    ...entry,
                                    priority: Math.max(0, Number(event.target.value) || 0)
                                  };
                                  setForm({ ...form, loreEntries: next });
                                }}
                              />
                            </Field>
                            <Field label={t("characters.loreEntryTriggerMode")}>
                              <select
                                className="w-full rounded-lg border border-white/10 bg-ink-950 px-3 py-2 text-sm text-slate-200 focus:border-ember-500/50 focus:outline-none focus:ring-1 focus:ring-ember-500/30"
                                value={entry.triggerMode}
                                onChange={(event) => {
                                  const next = [...form.loreEntries];
                                  next[index] = {
                                    ...entry,
                                    triggerMode: event.target.value as "user" | "assistant" | "both"
                                  };
                                  setForm({ ...form, loreEntries: next });
                                }}
                              >
                                <option value="both">{t("characters.loreEntryTriggerBoth")}</option>
                                <option value="user">{t("characters.loreEntryTriggerUser")}</option>
                                <option value="assistant">{t("characters.loreEntryTriggerAssistant")}</option>
                              </select>
                            </Field>
                            <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-400">
                              <input
                                checked={entry.alwaysActive}
                                type="checkbox"
                                className="rounded border-white/20 bg-ink-950 text-ember-500 focus:ring-ember-500/50"
                                onChange={() => {
                                  const next = [...form.loreEntries];
                                  next[index] = { ...entry, alwaysActive: !entry.alwaysActive };
                                  setForm({ ...form, loreEntries: next });
                                }}
                              />
                              {t("characters.loreEntryAlwaysActive")}
                            </label>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <Button
              className="mt-3 w-full !min-h-[36px]"
              variant="secondary"
              onClick={() =>
                setForm({
                  ...form,
                  loreEntries: [...form.loreEntries, blankLoreEntry()]
                })
              }
            >
              <Plus size={14} />
              {t("characters.loreEntryAdd")}
            </Button>
          </div>

          <div className="flex flex-wrap justify-end gap-3 pt-4 border-t border-white/5">
            <Button disabled={loading || !selected} variant="secondary" onClick={() => void duplicateCharacter()}>
              <Copy size={16} />
              {t("characters.duplicate")}
            </Button>
            <Button disabled={loading || !selected} variant="danger" onClick={() => setDeleteConfirmOpen(true)}>
              <Trash2 size={16} />
              {t("common.delete")}
            </Button>
            <Button disabled={loading || !form.name.trim()} onClick={() => void saveCharacter()}>
              <Save size={16} />
              {t("common.save")}
            </Button>
          </div>
        </div>
      </Panel>
      {deleteConfirmOpen && selected ? (
        <ConfirmDialog
          cancelLabel={t("common.cancel")}
          confirmLabel={t("common.delete")}
          loading={loading}
          message={t("characters.deleteConfirm", { name: selected.name })}
          title={t("common.delete")}
          onCancel={() => setDeleteConfirmOpen(false)}
          onConfirm={() => void deleteCharacter()}
        />
      ) : null}
    </div>
  );
}
