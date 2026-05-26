import { ChevronDown, ChevronLeft, ChevronRight, Copy, Download, FileUp, Lock, Plus, Save, Search, Trash2, X } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { MarkdownEditor } from "../components/MarkdownEditor";
import { ScopedHtmlRenderer } from "../components/ScopedHtmlRenderer";
import { useI18n } from "../i18n";
import { api } from "../lib/api";
import { downloadJson, readFileText } from "../lib/files";
import type {
  CharacterCardImportInput,
  CharacterDTO,
  CharacterExportMode,
  CharacterInput,
  CharacterLoreEntryDTO
} from "../types";
import { Button, ConfirmDialog, EmptyState, ErrorNotice, Field, HelpLabel, Panel, SuccessNotice, TextArea, TextInput } from "../components/ui";

const CHARACTER_PAGE_SIZE = 40;

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
type EditorSectionId = "prompt" | "html" | "lore";
type PasswordDialogMode = "unlock" | "export-private" | "export-public";

const HTML_PREVIEW_TEMPLATES = {
  card: `<article class="character-card">
  <header class="character-card__header">
    <small class="character-card__eyebrow">Aurora Archive</small>
    <h2 class="character-card__title">遐蝶</h2>
  </header>
  <p class="character-card__body">雪停之前，先把话慢慢说完。风声会替我们守住多余的秘密。</p>
  <ul class="character-card__tags">
    <li>低语</li>
    <li>雪夜</li>
    <li>陪伴</li>
  </ul>
</article>`,
  dialogue: `<section class="dialogue-shell">
  <p class="dialogue-shell__speaker">阿格莱雅</p>
  <blockquote class="dialogue-shell__line">远道而来的贵客，风已顺着金丝带来了你的讯息。欢迎来到奥赫玛。</blockquote>
  <p class="dialogue-shell__note">适合带旁白、分段对白和角色名。</p>
</section>`,
  dossier: `<section class="dossier-panel">
  <h3>行动摘要</h3>
  <table>
    <tbody>
      <tr><th>地点</th><td>日光庭</td></tr>
      <tr><th>状态</th><td>观察中</td></tr>
      <tr><th>备注</th><td>情绪稳定，愿意继续对话。</td></tr>
    </tbody>
  </table>
</section>`
} as const;

type HtmlPreviewTemplateId = keyof typeof HTML_PREVIEW_TEMPLATES;
const DEFAULT_HTML_PREVIEW_TEMPLATE: HtmlPreviewTemplateId = "card";

const blankForm = {
  name: "",
  avatar: "",
  prefix: "",
  prompt: "",
  suffix: "",
  htmlCss: "",
  loreEntries: [] as LoreEntryForm[]
};

type CharacterForm = typeof blankForm;

function PasswordDialog({
  title,
  description,
  confirmLabel,
  value,
  loading,
  onChange,
  onCancel,
  onConfirm
}: {
  title: string;
  description: string;
  confirmLabel: string;
  value: string;
  loading: boolean;
  onChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onConfirm();
  };

  return (
    <div className="animate-fade-in fixed inset-0 z-50 grid place-items-center bg-black/60 p-3 backdrop-blur-sm sm:p-4">
      <section
        aria-labelledby="private-password-dialog-title"
        className="animate-scale-in flex w-full max-w-md flex-col overflow-hidden rounded-2xl border border-white/10 bg-ink-900 shadow-2xl shadow-black/50"
        role="dialog"
      >
        <form onSubmit={submit}>
          <div className="space-y-4 p-5 sm:p-6">
            <div>
              <h3
                className="text-lg font-semibold tracking-tight text-slate-100"
                id="private-password-dialog-title"
              >
                {title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-300">{description}</p>
            </div>
            <Field label="密码">
              <TextInput
                autoFocus
                type="password"
                value={value}
                placeholder="输入私密角色密码"
                onChange={(event) => onChange(event.target.value)}
              />
            </Field>
          </div>
          <div className="flex flex-wrap justify-end gap-3 border-t border-white/10 px-5 py-4 sm:px-6">
            <Button disabled={loading} type="button" variant="ghost" onClick={onCancel}>
              取消
            </Button>
            <Button disabled={loading || !value} type="submit">
              {confirmLabel}
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}

const toForm = (character: CharacterDTO): CharacterForm => ({
  name: character.name,
  avatar: character.avatar ?? "",
  prefix: character.prefix,
  prompt: character.prompt,
  suffix: character.suffix,
  htmlCss: character.htmlCss,
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
  htmlCss: form.htmlCss,
  loreEntries: form.loreEntries.map(({ _localId, ...entry }) => entry)
});

const emptyCharacterPage = {
  items: [] as CharacterDTO[],
  total: 0,
  page: 1,
  pageSize: CHARACTER_PAGE_SIZE,
  totalPages: 1
};

export function CharactersPage() {
  const { language, t } = useI18n();
  const [characters, setCharacters] = useState<CharacterDTO[]>([]);
  const [characterPage, setCharacterPage] = useState(1);
  const [pagination, setPagination] = useState(emptyCharacterPage);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedCharacter, setSelectedCharacter] = useState<CharacterDTO | null>(null);
  const [form, setForm] = useState<CharacterForm>(blankForm);
  const [searchQuery, setSearchQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [exportMode, setExportMode] = useState<CharacterExportMode>("public");
  const [passwordDialogMode, setPasswordDialogMode] = useState<PasswordDialogMode | null>(null);
  const [passwordValue, setPasswordValue] = useState("");
  const [activeEditorSection, setActiveEditorSection] = useState<EditorSectionId>("prompt");
  const [previewTemplateId, setPreviewTemplateId] = useState<HtmlPreviewTemplateId>(DEFAULT_HTML_PREVIEW_TEMPLATE);
  const [previewMarkup, setPreviewMarkup] = useState<string>(HTML_PREVIEW_TEMPLATES[DEFAULT_HTML_PREVIEW_TEMPLATE]);
  const creatingRef = useRef(false);
  const characterRequestRef = useRef(0);
  const unlockedPasswordRef = useRef<Record<string, string>>({});

  const htmlPreviewTemplates = useMemo(
    () => [
      { id: "card" as const, label: t("characters.htmlTemplateCard"), markup: HTML_PREVIEW_TEMPLATES.card },
      { id: "dialogue" as const, label: t("characters.htmlTemplateDialogue"), markup: HTML_PREVIEW_TEMPLATES.dialogue },
      { id: "dossier" as const, label: t("characters.htmlTemplateDossier"), markup: HTML_PREVIEW_TEMPLATES.dossier }
    ],
    [t]
  );

  const editorSections = useMemo(
    () => [
      { id: "prompt" as const, label: t("characters.editorSectionPrompt") },
      { id: "html" as const, label: t("characters.editorSectionHtml") },
      { id: "lore" as const, label: t("characters.editorSectionLore") }
    ],
    [t]
  );

  const selected = selectedCharacter;
  const isLockedPrivateCharacter = selected?.visibility === "private" && !selected.canViewPrompt;

  const privateCharacterCopy = useMemo(
    () =>
      language === "zh-CN"
        ? {
            exportPublic: "公开导出",
            exportPrivate: "私密导出",
            exportedPublic: "角色卡已公开导出。",
            exportedPrivate: "角色卡已私密导出。",
            imported: "角色卡导入完成。",
            privateOwner: "私密角色卡",
            privateLocked: "私密角色卡提示词已隐藏",
            privateLockedHelp: "当前设备不是该私密角色卡的创建者。你可以继续聊天，但无法查看或公开导出提示词内容。",
            privateSummary: "私密角色内容已隐藏",
            privatePublicExportBlocked: "只有创建者才能将私密角色卡公开导出。"
          }
        : {
            exportPublic: "Export Public",
            exportPrivate: "Export Private",
            exportedPublic: "Character card exported publicly.",
            exportedPrivate: "Character card exported privately.",
            imported: "Character card imported.",
            privateOwner: "Private character card",
            privateLocked: "Private prompt hidden",
            privateLockedHelp:
              "This device is not the creator of this private character card. Chat still works, but prompt content cannot be viewed or publicly exported.",
            privateSummary: "Private prompt hidden",
            privatePublicExportBlocked: "Only the creator can publicly export a private character card."
          },
    [language]
  );

  const privatePasswordCopy = useMemo(
    () =>
      language === "zh-CN"
        ? {
            lockedHelp: "你可以继续聊天，但提示词、HTML 和 lore 内容只有输入密码后才可查看。",
            unlockAction: "输入密码查看",
            unlockTitle: "解锁私密角色",
            unlockDescription: "输入这张私密角色卡的密码后，才能查看或编辑提示词内容。",
            unlockConfirm: "查看内容",
            unlockSuccess: "私密角色内容已解锁。",
            exportPublicBlocked: "私密角色卡公开导出前需要先验证密码。",
            exportPrivateTitle: "私密导出密码",
            exportPrivateDescription: "为这次私密导出设置密码。之后只有输入这个密码才能查看提示词内容。",
            exportPublicTitle: "公开导出密码验证",
            exportPublicDescription: "输入私密角色卡密码后，才能公开导出其提示词内容。",
            exportPublicConfirm: "验证并导出",
            exportPrivateConfirm: "加密并导出"
          }
        : {
            lockedHelp:
              "Chat still works, but prompt, HTML, and lore content stay hidden until the password is provided.",
            unlockAction: "Unlock with Password",
            unlockTitle: "Unlock Private Character",
            unlockDescription:
              "Enter the password for this private character card to reveal and edit its prompt content.",
            unlockConfirm: "Reveal Content",
            unlockSuccess: "Private character content unlocked.",
            exportPublicBlocked:
              "Private characters require password verification before public export.",
            exportPrivateTitle: "Private Export Password",
            exportPrivateDescription:
              "Set the password for this private export. Prompt content can only be viewed again with the same password.",
            exportPublicTitle: "Password Required for Public Export",
            exportPublicDescription:
              "Enter the private character password before exporting its prompt content publicly.",
            exportPublicConfirm: "Verify and Export",
            exportPrivateConfirm: "Encrypt and Export"
          },
    [language]
  );

  const characterRange = useMemo(() => {
    if (pagination.total === 0) {
      return { start: 0, end: 0 };
    }

    const start = (pagination.page - 1) * pagination.pageSize + 1;
    const end = Math.min(start + pagination.items.length - 1, pagination.total);
    return { start, end };
  }, [pagination]);

  const characterPaginationCopy =
    pagination.total === 0
      ? t("characters.noSearchResults")
      : `${characterRange.start}-${characterRange.end} / ${pagination.total}`;

  const resolveCharacterDetail = async (character: CharacterDTO) => {
    const password = unlockedPasswordRef.current[character.id];
    if (character.visibility !== "private" || character.canViewPrompt || !password) {
      return character;
    }

    try {
      return await api.characters.unlock(character.id, password);
    } catch {
      delete unlockedPasswordRef.current[character.id];
      return character;
    }
  };

  const loadCharacters = async (
    nextPage = characterPage,
    nextSearchQuery = searchQuery,
    nextSelectedId = selectedId
  ) => {
    const requestId = characterRequestRef.current + 1;
    characterRequestRef.current = requestId;
    const data = await api.characters.page({
      q: nextSearchQuery,
      page: nextPage,
      pageSize: CHARACTER_PAGE_SIZE
    });

    if (requestId !== characterRequestRef.current) {
      return;
    }

    if (data.items.length === 0 && data.total > 0 && data.page > 1) {
      setCharacterPage(data.page - 1);
      return;
    }

    setCharacters(data.items);
    setPagination(data);

    const refreshedSelected = nextSelectedId
      ? data.items.find((character) => character.id === nextSelectedId) ?? null
      : null;

    if (refreshedSelected) {
      const detail = await resolveCharacterDetail(refreshedSelected);
      if (requestId !== characterRequestRef.current) {
        return;
      }
      setSelectedCharacter(detail);
      setForm(toForm(detail));
      return;
    }

    if (!nextSelectedId && !creatingRef.current && data.items[0]) {
      const detail = await resolveCharacterDetail(data.items[0]);
      if (requestId !== characterRequestRef.current) {
        return;
      }
      setSelectedId(data.items[0].id);
      setSelectedCharacter(detail);
      setForm(toForm(detail));
    }
  };

  useEffect(() => {
    void loadCharacters().catch((caught: unknown) =>
      setError(caught instanceof Error ? caught.message : t("characters.failedLoad"))
    );
  }, [characterPage, searchQuery, t]);

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
    setError(null);
    setStatus(null);
    void resolveCharacterDetail(character).then((detail) => {
      setSelectedCharacter(detail);
      setForm(toForm(detail));
    });
  };

  const resetForm = () => {
    creatingRef.current = true;
    setSelectedId(null);
    setSelectedCharacter(null);
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
      const accessPassword =
        editingCharacter?.visibility === "private"
          ? unlockedPasswordRef.current[editingCharacter.id]
          : undefined;
      if (editingCharacter) {
        const updated = await api.characters.update(editingCharacter.id, toInput(form), accessPassword);
        setSelectedCharacter(updated);
        setForm(toForm(updated));
        await loadCharacters(characterPage, searchQuery, updated.id);
      } else {
        const created = await api.characters.create(toInput(form));
        creatingRef.current = false;
        setSearchQuery("");
        setCharacterPage(1);
        setSelectedId(created.id);
        setSelectedCharacter(created);
        setForm(toForm(created));
        await loadCharacters(1, "", created.id);
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
      setSelectedCharacter(null);
      setForm(blankForm);
      await loadCharacters();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("characters.failedDelete"));
    } finally {
      setLoading(false);
    }
  };

  const duplicateCharacter = async () => {
    if (!selected || isLockedPrivateCharacter) {
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
      setSelectedCharacter(duplicated);
      setForm(toForm(duplicated));
      setStatus(t("characters.duplicated"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("characters.failedSave"));
    } finally {
      setLoading(false);
    }
  };

  const exportCharacter = async () => {
    if (!selected) {
      return;
    }

    if (exportMode === "private") {
      setPasswordValue("");
      setPasswordDialogMode("export-private");
      return;
    }

    const exportPassword =
      selected.visibility === "private" ? unlockedPasswordRef.current[selected.id] : undefined;
    if (selected.visibility === "private" && !exportPassword) {
      setPasswordValue("");
      setPasswordDialogMode("export-public");
      return;
    }

    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const card = await api.characters.export(selected.id, exportMode, exportPassword);
      downloadJson(`${selected.name || "character"}-${exportMode}.json`, card);
      setStatus(
        exportMode === "public"
          ? privateCharacterCopy.exportedPublic
          : privateCharacterCopy.exportedPrivate
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("characters.failedSave"));
    } finally {
      setLoading(false);
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
      const parsed = JSON.parse(await readFileText(file)) as CharacterCardImportInput;
      const imported = await api.characters.import(parsed);
      creatingRef.current = false;
      delete unlockedPasswordRef.current[imported.id];
      setSearchQuery("");
      setCharacterPage(1);
      setSelectedId(imported.id);
      setSelectedCharacter(imported);
      setForm(toForm(imported));
      await loadCharacters(1, "", imported.id);
      setStatus(privateCharacterCopy.imported);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("characters.failedImport"));
    } finally {
      setLoading(false);
    }
  };

  const applyPreviewTemplate = (templateId: HtmlPreviewTemplateId) => {
    setPreviewTemplateId(templateId);
    setPreviewMarkup(HTML_PREVIEW_TEMPLATES[templateId]);
  };

  const unlockSelectedCharacter = async (password: string) => {
    if (!selected) {
      return;
    }

    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const unlocked = await api.characters.unlock(selected.id, password);
      unlockedPasswordRef.current[selected.id] = password;
      setSelectedCharacter(unlocked);
      setForm(toForm(unlocked));
      setStatus(privatePasswordCopy.unlockSuccess);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("characters.failedLoad"));
    } finally {
      setLoading(false);
    }
  };

  const submitPasswordDialog = async () => {
    const password = passwordValue;
    if (!selected || !passwordDialogMode || !password) {
      return;
    }

    if (passwordDialogMode === "unlock") {
      setPasswordDialogMode(null);
      setPasswordValue("");
      await unlockSelectedCharacter(password);
      return;
    }

    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const card = await api.characters.export(
        selected.id,
        passwordDialogMode === "export-public" ? "public" : "private",
        password
      );
      if (passwordDialogMode === "export-public") {
        unlockedPasswordRef.current[selected.id] = password;
        const unlocked = await api.characters.unlock(selected.id, password);
        setSelectedCharacter(unlocked);
        setForm(toForm(unlocked));
      }
      downloadJson(
        `${selected.name || "character"}-${
          passwordDialogMode === "export-public" ? "public" : "private"
        }.json`,
        card
      );
      setStatus(
        passwordDialogMode === "export-public"
          ? privateCharacterCopy.exportedPublic
          : privateCharacterCopy.exportedPrivate
      );
      setPasswordDialogMode(null);
      setPasswordValue("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("characters.failedSave"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="grid gap-8 xl:grid-cols-[320px_minmax(0,1fr)] 2xl:grid-cols-[360px_minmax(0,1fr)]">
      <Panel
        className="h-fit xl:sticky xl:top-24"
        title={t("nav.characters")}
        action={
          <Button variant="secondary" onClick={resetForm} className="!h-9 !min-h-[36px] !px-3 text-xs">
            <Plus size={14} />
            {t("common.new")}
          </Button>
        }
      >
        <div className="space-y-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size={16} />
            <TextInput
              className="pl-9"
              placeholder={t("characters.searchPlaceholder")}
              value={searchQuery}
              onChange={(event) => {
                setSearchQuery(event.target.value);
                setCharacterPage(1);
              }}
            />
          </div>
          {characters.length === 0 && pagination.total === 0 && !searchQuery.trim() ? (
            <EmptyState>{t("characters.noCharacters")}</EmptyState>
          ) : characters.length === 0 ? (
            <EmptyState>{t("characters.noSearchResults")}</EmptyState>
          ) : (
            <div className="custom-scrollbar max-h-[38rem] space-y-3 overflow-y-auto pr-1">
            {characters.map((character) => (
              <button
                className={`group w-full rounded-xl border p-4 text-left text-sm transition-all duration-200 ${
                  selectedId === character.id
                    ? "border-ember-500/50 bg-ember-500/10 shadow-md shadow-ember-500/5"
                    : "border-white/5 bg-white/5 hover:border-white/10 hover:bg-white/10"
                }`}
                key={character.id}
                type="button"
                onClick={() => selectCharacter(character)}
              >
                <div className="flex items-start gap-4">
                  <div className={`grid h-14 w-14 shrink-0 place-items-center rounded-xl bg-ink-800 text-sm font-semibold transition-all duration-200 ${selectedId === character.id ? 'ring-2 ring-ember-500/50 ring-offset-2 ring-offset-ink-900' : 'group-hover:scale-105'}`}>
                    {character.avatar ? <img alt="" className="h-full w-full rounded-lg object-cover" src={character.avatar} /> : character.name.slice(0, 2)}
                  </div>
                  <div className="min-w-0 flex-1 pt-0.5">
                    <div className="flex items-start justify-between gap-2">
                      <p className={`min-w-0 flex-1 text-sm font-medium leading-5 transition-colors ${selectedId === character.id ? 'text-ember-100' : 'text-slate-100 group-hover:text-white'}`}>
                        <span className="line-clamp-2 break-words">{character.name}</span>
                      </p>
                      {character.visibility === "private" ? (
                        <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-amber-400/20 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-200">
                          <Lock size={10} />
                          {language === "zh-CN" ? "私密" : "Private"}
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs text-slate-400">
                      {character.visibility === "private" && !character.canViewPrompt
                        ? privateCharacterCopy.privateSummary
                        : character.prompt || character.prefix || t("common.noDescription")}
                    </p>
                  </div>
                </div>
              </button>
            ))}
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/5 pt-3 text-xs text-slate-400">
            <span>{characterPaginationCopy}</span>
            <div className="flex items-center gap-2">
              <Button
                className="!min-h-[32px] !px-3 text-xs"
                data-testid="characters-page-prev"
                disabled={loading || pagination.page <= 1}
                variant="secondary"
                onClick={() => setCharacterPage((current) => Math.max(1, current - 1))}
              >
                <ChevronLeft size={14} />
                {language === "zh-CN" ? "上一页" : "Previous"}
              </Button>
              <Button
                className="!min-h-[32px] !px-3 text-xs"
                data-testid="characters-page-next"
                disabled={loading || pagination.page >= pagination.totalPages}
                variant="secondary"
                onClick={() => setCharacterPage((current) => Math.min(pagination.totalPages, current + 1))}
              >
                {language === "zh-CN" ? "下一页" : "Next"}
                <ChevronRight size={14} />
              </Button>
            </div>
          </div>
        </div>
      </Panel>

      <Panel
        className="p-5 sm:p-6"
        title={selected ? t("characters.edit") : t("characters.create")}
        action={
          <div className="flex flex-wrap gap-2">
            <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg bg-white/5 px-3 text-xs font-medium text-slate-200 transition-colors hover:bg-white/10 focus-within:ring-2 focus-within:ring-white/20">
              <FileUp size={14} />
              {t("common.import")}
              <input className="sr-only" type="file" accept="application/json" onChange={(event) => void importCharacter(event.target.files?.[0])} />
            </label>
            <div className="inline-flex rounded-lg border border-white/5 bg-white/5 p-1">
              {(["public", "private"] as CharacterExportMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                    exportMode === mode
                      ? "bg-ember-500 text-ink-950"
                      : "text-slate-300 hover:bg-white/10 hover:text-slate-100"
                  }`}
                  onClick={() => setExportMode(mode)}
                >
                  {mode === "public"
                    ? privateCharacterCopy.exportPublic
                    : privateCharacterCopy.exportPrivate}
                </button>
              ))}
            </div>
            <Button
              disabled={!selected}
              variant="ghost"
              onClick={() => void exportCharacter()}
              className="!min-h-[36px] !h-9 !px-3 text-xs"
            >
              <Download size={14} />
              {t("common.export")}
            </Button>
          </div>
        }
      >
        <div className="space-y-8">
          <ErrorNotice message={error} />
          <SuccessNotice message={status} />
          {selected?.visibility === "private" ? (
            <div className="rounded-xl border border-amber-400/15 bg-amber-500/8 px-4 py-3 text-sm text-amber-100">
              <div className="flex items-center gap-2 font-medium">
                <Lock size={14} />
                {selected.canViewPrompt
                  ? privateCharacterCopy.privateOwner
                  : privateCharacterCopy.privateLocked}
              </div>
              {!selected.canViewPrompt ? (
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <p className="text-xs leading-5 text-amber-100/80">
                    {privatePasswordCopy.lockedHelp}
                  </p>
                  <Button
                    className="!min-h-[32px] !px-3 text-xs"
                    variant="secondary"
                    onClick={() => {
                      setPasswordValue("");
                      setPasswordDialogMode("unlock");
                    }}
                  >
                    <Lock size={12} />
                    {privatePasswordCopy.unlockAction}
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_148px]">
            <div className="grid gap-5">
              <Field label={t("common.name")}><TextInput value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field>
              <Field label={t("characters.avatarUrl")}><TextInput value={form.avatar} onChange={(event) => setForm({ ...form, avatar: event.target.value })} /></Field>
            </div>
            <div className="grid min-h-[148px] place-items-center rounded-2xl border border-white/5 bg-ink-950/40 p-4">
              <div className="grid h-24 w-24 place-items-center overflow-hidden rounded-2xl bg-ink-800 text-lg font-semibold text-slate-300 ring-1 ring-white/10">
                {form.avatar ? (
                  <img alt="" className="h-full w-full object-cover" src={form.avatar} />
                ) : (
                  (form.name || t("common.unknown")).slice(0, 2)
                )}
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-white/5 bg-ink-950/25 p-2">
            <div className="grid grid-cols-3 gap-2.5">
              {editorSections.map((section) => (
                <button
                  key={section.id}
                  type="button"
                  className={`min-h-11 rounded-xl px-4 py-2.5 text-sm font-medium transition-colors ${
                    activeEditorSection === section.id
                      ? "bg-ember-500 text-ink-950 shadow-sm shadow-ember-500/20"
                      : "text-slate-300 hover:bg-white/5 hover:text-slate-100"
                  }`}
                  onClick={() => setActiveEditorSection(section.id)}
                >
                  {section.label}
                </button>
              ))}
            </div>
          </div>

          {activeEditorSection === "prompt" ? (
            isLockedPrivateCharacter ? (
              <EmptyState>{privatePasswordCopy.lockedHelp}</EmptyState>
            ) : (
              <div className="space-y-7">
                <Field
                  container="div"
                  label={<HelpLabel label={t("characters.prefix")} description={t("help.characterPrefix")} />}
                >
                  <MarkdownEditor
                    value={form.prefix}
                    onChange={(nextValue) => setForm({ ...form, prefix: nextValue })}
                    height={180}
                  />
                </Field>
                <Field
                  container="div"
                  label={<HelpLabel label={t("characters.prompt")} description={t("help.characterPrompt")} />}
                >
                  <MarkdownEditor
                    value={form.prompt}
                    onChange={(nextValue) => setForm({ ...form, prompt: nextValue })}
                    height={320}
                  />
                </Field>
                <Field
                  container="div"
                  label={<HelpLabel label={t("characters.suffix")} description={t("help.characterSuffix")} />}
                >
                  <MarkdownEditor
                    value={form.suffix}
                    onChange={(nextValue) => setForm({ ...form, suffix: nextValue })}
                    height={220}
                  />
                </Field>
              </div>
            )
          ) : null}

          {activeEditorSection === "html" ? (
            isLockedPrivateCharacter ? (
              <EmptyState>{privatePasswordCopy.lockedHelp}</EmptyState>
            ) : (
              <div className="space-y-5">
                <Field label={<HelpLabel label={t("characters.htmlCss")} description={t("help.characterHtmlCss")} />}>
                  <TextArea value={form.htmlCss} onChange={(event) => setForm({ ...form, htmlCss: event.target.value })} className="!h-[170px] min-h-[170px] font-mono text-xs leading-6" />
                </Field>

                <div className="rounded-xl border border-white/5 bg-ink-950/30 p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="space-y-1">
                      <h4 className="text-sm font-semibold text-slate-100">{t("characters.htmlPreview")}</h4>
                      <p className="text-xs leading-5 text-slate-500">{t("characters.htmlPreviewHelp")}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {htmlPreviewTemplates.map((template) => (
                        <Button
                          key={template.id}
                          variant={previewTemplateId === template.id ? "secondary" : "ghost"}
                          className="!h-8 !min-h-[32px] !px-3 text-xs"
                          onClick={() => applyPreviewTemplate(template.id)}
                        >
                          {template.label}
                        </Button>
                      ))}
                    </div>
                  </div>

                  <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                    <Field label={t("characters.htmlPreviewMarkup")}>
                      <TextArea
                        className="!h-[180px] min-h-[180px] font-mono text-xs leading-6"
                        spellCheck={false}
                        value={previewMarkup}
                        onChange={(event) => setPreviewMarkup(event.target.value)}
                      />
                    </Field>
                    <Field label={t("characters.htmlPreviewRendered")}>
                      <div className="custom-scrollbar min-h-[180px] overflow-y-auto rounded-xl border border-white/5 bg-ink-950/60 p-4">
                        <div className="rounded-2xl border border-white/5 bg-ink-900/70 p-4 shadow-inner shadow-black/20">
                          <div className="flex items-start gap-3">
                            <div className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-xl border border-white/10 bg-ink-800 text-sm font-semibold text-ember-100 shadow-black/20">
                              {form.avatar ? (
                                <img alt="" className="h-full w-full object-cover" src={form.avatar} />
                              ) : (
                                (form.name || t("common.unknown")).slice(0, 2)
                              )}
                            </div>
                            <article className="min-w-0 flex-1 rounded-2xl rounded-bl-sm border border-white/5 bg-ink-800/80 p-4 text-sm text-slate-100 shadow-sm backdrop-blur-sm">
                              <div className="mb-3 text-xs font-bold tracking-wide text-ember-400">
                                {form.name || t("common.unknown")}
                              </div>
                              <ScopedHtmlRenderer content={previewMarkup} htmlCss={form.htmlCss} />
                            </article>
                          </div>
                        </div>
                      </div>
                    </Field>
                  </div>
                </div>
              </div>
            )
          ) : null}

          {activeEditorSection === "lore" ? (
          isLockedPrivateCharacter ? (
            <EmptyState>{privatePasswordCopy.lockedHelp}</EmptyState>
          ) : (
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
                            <Field container="div" label={t("characters.loreEntryContent")}>
                              <MarkdownEditor
                                height={180}
                                value={entry.content}
                                onChange={(nextValue) => {
                                  const next = [...form.loreEntries];
                                  next[index] = { ...entry, content: nextValue };
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
          )
          ) : null}

          <div className="flex flex-wrap justify-end gap-3 pt-4 border-t border-white/5">
            <Button disabled={loading || !selected || isLockedPrivateCharacter} variant="secondary" onClick={() => void duplicateCharacter()}>
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
      {passwordDialogMode ? (
        <PasswordDialog
          confirmLabel={
            passwordDialogMode === "unlock"
              ? privatePasswordCopy.unlockConfirm
              : passwordDialogMode === "export-public"
                ? privatePasswordCopy.exportPublicConfirm
                : privatePasswordCopy.exportPrivateConfirm
          }
          description={
            passwordDialogMode === "unlock"
              ? privatePasswordCopy.unlockDescription
              : passwordDialogMode === "export-public"
                ? privatePasswordCopy.exportPublicDescription
                : privatePasswordCopy.exportPrivateDescription
          }
          loading={loading}
          title={
            passwordDialogMode === "unlock"
              ? privatePasswordCopy.unlockTitle
              : passwordDialogMode === "export-public"
                ? privatePasswordCopy.exportPublicTitle
                : privatePasswordCopy.exportPrivateTitle
          }
          value={passwordValue}
          onCancel={() => {
            setPasswordDialogMode(null);
            setPasswordValue("");
          }}
          onChange={setPasswordValue}
          onConfirm={() => void submitPasswordDialog()}
        />
      ) : null}
    </div>
  );
}
