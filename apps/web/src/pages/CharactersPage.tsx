import { Download, FileUp, Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../i18n";
import { api } from "../lib/api";
import { downloadJson, joinTags, readFileText, splitTags } from "../lib/form";
import type { CharacterDTO, CharacterInput } from "../types";
import { Badge, Button, ConfirmDialog, EmptyState, ErrorNotice, Field, HelpLabel, Panel, TextArea, TextInput } from "../components/ui";

const blankForm = {
  name: "",
  avatar: "",
  description: "",
  personality: "",
  scenario: "",
  firstMessage: "",
  exampleDialog: "",
  systemPrompt: "",
  tags: ""
};

type CharacterForm = typeof blankForm;

const toForm = (character: CharacterDTO): CharacterForm => ({
  name: character.name,
  avatar: character.avatar ?? "",
  description: character.description,
  personality: character.personality,
  scenario: character.scenario,
  firstMessage: character.firstMessage,
  exampleDialog: character.exampleDialog,
  systemPrompt: character.systemPrompt,
  tags: joinTags(character.tags)
});

const toInput = (form: CharacterForm): CharacterInput => ({
  name: form.name,
  avatar: form.avatar || null,
  description: form.description,
  personality: form.personality,
  scenario: form.scenario,
  firstMessage: form.firstMessage,
  exampleDialog: form.exampleDialog,
  systemPrompt: form.systemPrompt,
  tags: splitTags(form.tags)
});

export function CharactersPage() {
  const { t } = useI18n();
  const [characters, setCharacters] = useState<CharacterDTO[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<CharacterForm>(blankForm);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  const selected = useMemo(
    () => characters.find((character) => character.id === selectedId) ?? null,
    [characters, selectedId]
  );

  const loadCharacters = async () => {
    const data = await api.characters.list();
    setCharacters(data);
    if (!selectedId && data[0]) {
      setSelectedId(data[0].id);
      setForm(toForm(data[0]));
    }
  };

  useEffect(() => {
    void loadCharacters().catch((caught: unknown) =>
      setError(caught instanceof Error ? caught.message : t("characters.failedLoad"))
    );
  }, [t]);

  const selectCharacter = (character: CharacterDTO) => {
    setSelectedId(character.id);
    setForm(toForm(character));
    setError(null);
  };

  const resetForm = () => {
    setSelectedId(null);
    setForm(blankForm);
    setError(null);
  };

  const saveCharacter = async () => {
    setLoading(true);
    setError(null);
    try {
      if (selected) {
        await api.characters.update(selected.id, toInput(form));
      } else {
        await api.characters.create(toInput(form));
      }
      await loadCharacters();
      if (!selected) {
        setForm(blankForm);
      }
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
    try {
      const parsed = JSON.parse(await readFileText(file)) as Partial<CharacterInput>;
      if (!parsed.name) {
        throw new Error(t("characters.importMissingName"));
      }
      await api.characters.create({
        name: parsed.name,
        avatar: parsed.avatar ?? null,
        description: parsed.description ?? "",
        personality: parsed.personality ?? "",
        scenario: parsed.scenario ?? "",
        firstMessage: parsed.firstMessage ?? "",
        exampleDialog: parsed.exampleDialog ?? "",
        systemPrompt: parsed.systemPrompt ?? "",
        tags: Array.isArray(parsed.tags) ? parsed.tags : []
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
          <Button variant="secondary" onClick={resetForm} className="h-8 px-3 text-xs">
            <Plus size={14} />
            {t("common.new")}
          </Button>
        }
      >
        <div className="space-y-2.5">
          {characters.length === 0 ? (
            <EmptyState>{t("characters.noCharacters")}</EmptyState>
          ) : (
            characters.map((character) => (
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
                    <p className="mt-1 line-clamp-2 text-xs text-slate-400">{character.description || t("common.noDescription")}</p>
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
            <Button disabled={!selected} variant="ghost" onClick={exportCharacter} className="h-9 px-3 text-xs">
              <Download size={14} />
              {t("common.export")}
            </Button>
          </div>
        }
      >
        <div className="space-y-6">
          <ErrorNotice message={error} />
          <div className="grid gap-5 md:grid-cols-2">
            <Field label={t("common.name")}><TextInput value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field>
            <Field label={t("characters.avatarUrl")}><TextInput value={form.avatar} onChange={(event) => setForm({ ...form, avatar: event.target.value })} /></Field>
          </div>
          
          <div className="space-y-3">
            <Field label={<HelpLabel label={t("characters.tags")} description={t("help.tags")} />}>
              <TextInput placeholder={t("characters.tagsPlaceholder")} value={form.tags} onChange={(event) => setForm({ ...form, tags: event.target.value })} />
            </Field>
            {form.tags && (
              <div className="flex flex-wrap gap-2 animate-fade-in">
                {splitTags(form.tags).map((tag) => <Badge key={tag}>{tag}</Badge>)}
              </div>
            )}
          </div>

          <Field label={t("common.description")}><TextArea value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} className="min-h-[80px]" /></Field>
          <Field label={t("characters.personality")}><TextArea value={form.personality} onChange={(event) => setForm({ ...form, personality: event.target.value })} className="min-h-[80px]" /></Field>
          <Field label={<HelpLabel label={t("characters.scenario")} description={t("help.scenario")} />}><TextArea value={form.scenario} onChange={(event) => setForm({ ...form, scenario: event.target.value })} className="min-h-[80px]" /></Field>
          <Field label={<HelpLabel label={t("characters.firstMessage")} description={t("help.firstMessage")} />}><TextArea value={form.firstMessage} onChange={(event) => setForm({ ...form, firstMessage: event.target.value })} className="min-h-[120px]" /></Field>
          <Field label={<HelpLabel label={t("characters.exampleDialog")} description={t("help.exampleDialog")} />}><TextArea value={form.exampleDialog} onChange={(event) => setForm({ ...form, exampleDialog: event.target.value })} className="min-h-[120px]" /></Field>
          <Field label={<HelpLabel label={t("characters.systemPrompt")} description={t("help.systemPrompt")} />}><TextArea value={form.systemPrompt} onChange={(event) => setForm({ ...form, systemPrompt: event.target.value })} className="min-h-[120px]" /></Field>
          
          <div className="flex flex-wrap justify-end gap-3 pt-4 border-t border-white/5">
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
