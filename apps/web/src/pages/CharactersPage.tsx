import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  FileUp,
  Lock,
  Plus,
  Save,
  Search,
  Trash2,
  X
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { CharacterCard } from "../components/CharacterCard";
import { MarkdownEditor } from "../components/MarkdownEditor";
import { ScopedHtmlRenderer } from "../components/ScopedHtmlRenderer";
import { useI18n } from "../i18n";
import { api } from "../lib/api";
import { downloadJson, readFileText } from "../lib/files";
import { usePlaceholderSrc } from "../placeholderImages";
import type {
  CharacterCardImportInput,
  CharacterDTO,
  CharacterExportMode,
  CharacterInput,
  CharacterLoreEntryDTO,
  QuickReplyDTO
} from "../types";
import {
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

const CHARACTER_PAGE_SIZE = 40;

const blankLoreEntry = (): CharacterLoreEntryDTO & { _localId: string; _collapsed: boolean } => ({
  id: "",
  keys: [],
  content: "",
  priority: 0,
  scope: "prompt",
  triggerMode: "both",
  alwaysActive: false,
  enabled: true,
  _localId: Math.random().toString(36).slice(2),
  _collapsed: false
});

type LoreEntryForm = ReturnType<typeof blankLoreEntry>;

const blankQuickReply = (): QuickReplyDTO & { _localId: string; _collapsed: boolean } => ({
  id: "",
  label: "",
  content: "",
  _localId: Math.random().toString(36).slice(2),
  _collapsed: false
});

type QuickReplyForm = ReturnType<typeof blankQuickReply>;
type EditorSectionId = "prompt" | "html" | "opening" | "lore" | "quickReplies";
type PasswordDialogMode = "unlock" | "export-private" | "export-public";

const HTML_PREVIEW_TEMPLATES = {
  card: `<article class="character-card">
  <header class="character-card__header">
    <small class="character-card__eyebrow">Profile</small>
    <h2 class="character-card__title">Character Name</h2>
  </header>
  <p class="character-card__body">A short character description or introduction that sets the tone and context for interactions.</p>
  <ul class="character-card__meta">
    <li>Calm voice</li>
    <li>Night archive</li>
    <li>Field notes</li>
  </ul>
</article>`,
  dialogue: `<section class="dialogue-shell">
  <p class="dialogue-shell__speaker">Character Name</p>
  <blockquote class="dialogue-shell__line">A spoken line or quote from the character, wrapped in a blockquote for emphasis.</blockquote>
  <p class="dialogue-shell__note">Narration or stage direction shown after the dialogue.</p>
</section>`,
  dossier: `<section class="dossier-panel">
  <h3>Summary</h3>
  <table>
    <tbody>
      <tr><th>Field</th><td>Value or description</td></tr>
      <tr><th>Status</th><td>Active</td></tr>
      <tr><th>Notes</th><td>Additional context or remarks.</td></tr>
    </tbody>
  </table>
 </section>`,
  chatUi: `<section id="chat-page-root" class="chat-ui-preview">
  <div id="chat-panel" class="chat-ui-preview__panel">
    <div id="chat-title">Preview Chat</div>
    <div id="chat-message-viewport">
      <div id="chat-pagination">Page 1 / 3</div>
      <div id="chat-message-list">
        <div data-chat-message="assistant" class="chat-ui-preview__row">
          <article data-chat-bubble class="chat-ui-preview__bubble">
            <p>Assistant bubble preview for current built-in CSS.</p>
            <div data-chat-actions class="chat-ui-preview__actions">
              <button data-chat-action="copy">Copy</button>
              <button data-chat-action="regenerate">Redo</button>
            </div>
          </article>
          <div data-chat-avatar class="chat-ui-preview__avatar">A</div>
        </div>
      </div>
    </div>
    <div id="chat-quick-replies">
      <button id="chat-quick-replies-toggle">Quick Commands</button>
      <div class="chat-ui-preview__chips">
        <button data-chat-quick-reply="">Greeting</button>
        <button data-chat-quick-reply="">Status</button>
      </div>
    </div>
    <div id="chat-composer" class="chat-ui-preview__composer">
      <div id="chat-message-input">Write a user message</div>
      <button id="chat-primary-action" data-chat-action="send">Send</button>
    </div>
  </div>
</section>`
} as const;

type HtmlPreviewTemplateId = keyof typeof HTML_PREVIEW_TEMPLATES;
const DEFAULT_HTML_PREVIEW_TEMPLATE: HtmlPreviewTemplateId = "card";

const blankForm = {
  name: "",
  avatar: "",
  description: "",
  prefix: "",
  prompt: "",
  suffix: "",
  htmlCss: "",
  openingHtml: "",
  loreEntries: [] as LoreEntryForm[],
  quickReplies: [] as QuickReplyForm[]
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
  description: character.description,
  prefix: character.prefix,
  prompt: character.prompt,
  suffix: character.suffix,
  htmlCss: character.htmlCss,
  openingHtml: character.openingHtml,
  loreEntries: (character.loreEntries ?? []).map((entry) => ({
    id: entry.id,
    keys: entry.keys,
    content: entry.content,
    priority: entry.priority,
    scope: entry.scope,
    triggerMode: entry.triggerMode,
    alwaysActive: entry.alwaysActive,
    enabled: entry.enabled,
    _localId: Math.random().toString(36).slice(2),
    _collapsed: true
  })),
  quickReplies: (character.quickReplies ?? []).map((qr) => ({
    id: qr.id,
    label: qr.label,
    content: qr.content,
    _localId: Math.random().toString(36).slice(2),
    _collapsed: true
  }))
});

const toInput = (form: CharacterForm): CharacterInput => ({
  name: form.name,
  avatar: form.avatar || null,
  description: form.description,
  prefix: form.prefix,
  prompt: form.prompt,
  suffix: form.suffix,
  htmlCss: form.htmlCss,
  openingHtml: form.openingHtml,
  loreEntries: form.loreEntries.map(({ _localId, ...entry }) => ({
    ...entry,
    id: entry.id || crypto.randomUUID()
  })),
  quickReplies: form.quickReplies.map(({ _localId, ...qr }) => ({
    ...qr,
    id: qr.id || crypto.randomUUID()
  }))
});

const emptyCharacterPage = {
  items: [] as CharacterDTO[],
  total: 0,
  page: 1,
  pageSize: CHARACTER_PAGE_SIZE,
  totalPages: 1
};

export function CharactersPage({ onPlay }: { onPlay: (characterId: string) => void }) {
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
  const [previewTemplateId, setPreviewTemplateId] = useState<HtmlPreviewTemplateId>(
    DEFAULT_HTML_PREVIEW_TEMPLATE
  );
  const [previewMarkup, setPreviewMarkup] = useState<string>(
    HTML_PREVIEW_TEMPLATES[DEFAULT_HTML_PREVIEW_TEMPLATE]
  );
  const [isCreating, setIsCreating] = useState(false);
  const characterRequestRef = useRef(0);
  const unlockedPasswordRef = useRef<Record<string, string>>({});
  const editorCoverSrc = usePlaceholderSrc(form.avatar, selectedId ?? undefined);

  const htmlPreviewTemplates = useMemo(
    () => [
      {
        id: "card" as const,
        label: t("characters.htmlTemplateCard"),
        markup: HTML_PREVIEW_TEMPLATES.card
      },
      {
        id: "dialogue" as const,
        label: t("characters.htmlTemplateDialogue"),
        markup: HTML_PREVIEW_TEMPLATES.dialogue
      },
      {
        id: "dossier" as const,
        label: t("characters.htmlTemplateDossier"),
        markup: HTML_PREVIEW_TEMPLATES.dossier
      },
      {
        id: "chatUi" as const,
        label: t("characters.htmlTemplateChatUi"),
        markup: HTML_PREVIEW_TEMPLATES.chatUi
      }
    ],
    [t]
  );

  const editorSections = useMemo(
    () => [
      { id: "prompt" as const, label: t("characters.editorSectionPrompt") },
      { id: "html" as const, label: t("characters.editorSectionHtml") },
      { id: "opening" as const, label: t("characters.editorSectionOpening") },
      { id: "lore" as const, label: t("characters.editorSectionLore") },
      { id: "quickReplies" as const, label: t("characters.editorSectionQuickReplies") }
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
            privateLockedHelp:
              "当前设备不是该私密角色卡的创建者。你可以继续聊天，但无法查看或公开导出提示词内容。",
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
            privatePublicExportBlocked:
              "Only the creator can publicly export a private character card."
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
            exportPrivateDescription:
              "为这次私密导出设置密码。之后只有输入这个密码才能查看提示词内容。",
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
      ? (data.items.find((character) => character.id === nextSelectedId) ?? null)
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

    if (!nextSelectedId && !isCreating) {
      return;
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
    setIsCreating(false);
    setSelectedId(character.id);
    setError(null);
    setStatus(null);
    void resolveCharacterDetail(character).then((detail) => {
      setSelectedCharacter(detail);
      setForm(toForm(detail));
    });
  };

  const resetForm = () => {
    setIsCreating(true);
    setSelectedId(null);
    setSelectedCharacter(null);
    setForm({ ...blankForm });
    setError(null);
    setStatus(null);
  };

  const saveCharacter = async () => {
    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const editingCharacter = isCreating ? null : selected;
      const accessPassword =
        editingCharacter?.visibility === "private"
          ? unlockedPasswordRef.current[editingCharacter.id]
          : undefined;
      if (editingCharacter) {
        const updated = await api.characters.update(
          editingCharacter.id,
          toInput(form),
          accessPassword
        );
        setSelectedCharacter(updated);
        setForm(toForm(updated));
        await loadCharacters(characterPage, searchQuery, updated.id);
      } else {
        const created = await api.characters.create(toInput(form));
        setIsCreating(false);
        setSearchQuery("");
        setCharacterPage(1);
        setSelectedId(created.id);
        setSelectedCharacter(created);
        setForm(toForm(created));
        await loadCharacters(1, "", created.id);
      }
      setStatus(t("characters.saved"));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "";
      if (message.includes("password is required")) {
        setError(t("characters.privatePasswordRequired"));
      } else {
        setError(message || t("characters.failedSave"));
      }
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
      setIsCreating(false);
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
    <>
      <div className="mb-4 flex items-center gap-3">
        <h2 className="min-w-0 truncate text-sm font-semibold text-slate-100">
          {selectedId ? (selectedCharacter?.name ?? t("characters.edit")) : t("characters.create")}
        </h2>
        <Button
          variant="secondary"
          onClick={resetForm}
          className="!h-9 !min-h-[36px] !px-3 text-xs ml-auto"
        >
          <Plus size={14} />
          {t("common.new")}
        </Button>
        <label className="inline-flex h-9 min-h-[36px] cursor-pointer items-center gap-2 rounded-lg bg-white/5 px-3 text-xs font-medium text-slate-200 transition-colors hover:bg-white/10 focus-within:ring-2 focus-within:ring-white/20">
          <FileUp size={14} />
          {t("common.import")}
          <input
            className="sr-only"
            type="file"
            accept="application/json"
            onChange={(event) => void importCharacter(event.target.files?.[0])}
          />
        </label>
      </div>

      {isCreating || (selectedId && selectedCharacter) ? (
        <div className="space-y-4">
          <button
            className="flex items-center gap-1.5 text-xs font-medium text-slate-400 transition-colors hover:text-slate-200"
            type="button"
            onClick={() => {
              setSelectedId(null);
              setSelectedCharacter(null);
              setForm({ ...blankForm });
              setIsCreating(false);
            }}
          >
            <ChevronLeft size={14} />
            {language === "zh-CN" ? "返回角色列表" : "Back to characters"}
          </button>

          <Panel
            className="p-5 sm:p-6"
            title={t("characters.edit")}
            action={
              <>
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
              </>
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
              <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
                <div className="grid gap-5">
                  <Field label={t("common.name")}>
                    <TextInput
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                    />
                  </Field>
                  <Field label={t("characters.avatarUrl")}>
                    <TextInput
                      value={form.avatar}
                      onChange={(event) => setForm({ ...form, avatar: event.target.value })}
                    />
                  </Field>
                  <Field label={t("characters.description")}>
                    <TextArea
                      value={form.description}
                      onChange={(event) => setForm({ ...form, description: event.target.value })}
                      className="chat-input !h-[100px] min-h-[100px] !text-sm"
                    />
                  </Field>
                </div>
                <div className="group overflow-hidden rounded-xl border border-white/5 bg-white/5 p-0 text-sm transition-all duration-200 hover:border-white/10 hover:bg-white/10">
                  <div className="relative aspect-video w-full overflow-hidden bg-ink-800 ring-1 ring-white/5 transition-all duration-200 group-hover:ring-ember-500/30">
                    <img
                      alt=""
                      className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                      src={editorCoverSrc}
                    />
                    <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />
                    <p className="absolute bottom-2 left-3 right-3 truncate text-sm font-semibold text-white drop-shadow-md">
                      {form.name || t("common.name")}
                    </p>
                  </div>
                  <div className="min-w-0 w-full p-4">
                    <p className="line-clamp-2 text-xs leading-5 text-slate-400">
                      {form.description || t("common.noDescription")}
                    </p>
                  </div>
                </div>
              </div>

              <div className="flex rounded-xl border border-white/5 bg-ink-900/80 p-1">
                {editorSections.map((section) => (
                  <button
                    key={section.id}
                    type="button"
                    className={`min-h-[48px] flex-1 whitespace-nowrap rounded-lg px-2 text-xs font-medium transition-colors sm:px-4 sm:text-sm ${
                      activeEditorSection === section.id
                        ? "bg-ember-500 text-ink-950 shadow-sm shadow-ember-500/20"
                        : "text-slate-300 hover:bg-ink-800/75 active:bg-ink-800/90"
                    }`}
                    onClick={() => setActiveEditorSection(section.id)}
                  >
                    {section.label}
                  </button>
                ))}
              </div>

              {activeEditorSection === "prompt" ? (
                isLockedPrivateCharacter ? (
                  <EmptyState>{privatePasswordCopy.lockedHelp}</EmptyState>
                ) : (
                  <div className="space-y-7">
                    <Field
                      container="div"
                      label={
                        <HelpLabel
                          label={t("characters.prefix")}
                          description={t("help.characterPrefix")}
                        />
                      }
                    >
                      <MarkdownEditor
                        value={form.prefix}
                        onChange={(nextValue) => setForm({ ...form, prefix: nextValue })}
                        height={180}
                      />
                    </Field>
                    <Field
                      container="div"
                      label={
                        <HelpLabel
                          label={t("characters.prompt")}
                          description={t("help.characterPrompt")}
                        />
                      }
                    >
                      <MarkdownEditor
                        value={form.prompt}
                        onChange={(nextValue) => setForm({ ...form, prompt: nextValue })}
                        height={320}
                      />
                    </Field>
                    <Field
                      container="div"
                      label={
                        <HelpLabel
                          label={t("characters.suffix")}
                          description={t("help.characterSuffix")}
                        />
                      }
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
                    <Field
                      label={
                        <HelpLabel
                          label={t("characters.htmlCss")}
                          description={t("help.characterHtmlCss")}
                        />
                      }
                    >
                      <TextArea
                        value={form.htmlCss}
                        onChange={(event) => setForm({ ...form, htmlCss: event.target.value })}
                        className="!h-[170px] min-h-[170px] font-mono text-xs leading-6"
                      />
                    </Field>

                    <div className="rounded-xl border border-white/5 bg-ink-950/30 p-4">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="space-y-1">
                          <h4 className="text-sm font-semibold text-slate-100">
                            {t("characters.htmlPreview")}
                          </h4>
                          <p className="text-xs leading-5 text-slate-500">
                            {t("characters.htmlPreviewHelp")}
                          </p>
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
                          <div className="custom-scrollbar flex min-h-[180px] items-start justify-end gap-3 overflow-y-auto rounded-xl border border-white/5 bg-ink-950/60 p-4">
                            <article className="order-1 relative self-start max-w-[calc(100%-3.25rem)] overflow-hidden rounded-2xl rounded-br-sm border border-white/5 bg-ink-800/80 p-3 sm:p-4 text-sm text-slate-100 shadow-sm backdrop-blur-sm">
                              <ScopedHtmlRenderer content={previewMarkup} htmlCss={form.htmlCss} />
                            </article>
                            <div
                              className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-xl border text-xs font-bold shadow-md order-2 border-ember-300/40 bg-ink-950/20 text-ink-950 shadow-ember-500/10"
                              title={form.name || t("common.unknown")}
                            >
                              {form.avatar ? (
                                <img
                                  alt=""
                                  className="h-full w-full object-cover"
                                  src={form.avatar}
                                />
                              ) : (
                                <span className="truncate px-1">
                                  {(form.name || t("common.unknown")).slice(0, 2)}
                                </span>
                              )}
                            </div>
                          </div>
                        </Field>
                      </div>
                    </div>
                  </div>
                )
              ) : null}

              {activeEditorSection === "opening" ? (
                isLockedPrivateCharacter ? (
                  <EmptyState>{privatePasswordCopy.lockedHelp}</EmptyState>
                ) : (
                  <div className="space-y-5">
                    <Field
                      label={
                        <HelpLabel
                          label={t("characters.openingHtml")}
                          description={t("help.characterOpeningHtml")}
                        />
                      }
                    >
                      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                        <TextArea
                          value={form.openingHtml}
                          onChange={(event) =>
                            setForm({ ...form, openingHtml: event.target.value })
                          }
                          className="!h-[300px] min-h-[300px] font-mono text-xs leading-6"
                          placeholder={t("characters.openingHtmlPlaceholder")}
                        />
                        {form.openingHtml.trim() ? (
                          <div
                            className="rounded-lg overflow-hidden border border-white/10 bg-white"
                            style={{ height: 300 }}
                          >
                            <iframe
                              title={t("characters.openingHtmlPreview")}
                              srcDoc={form.openingHtml}
                              sandbox="allow-scripts"
                              className="w-full h-full border-0"
                            />
                          </div>
                        ) : (
                          <div
                            className="flex items-center justify-center rounded-lg border border-dashed border-white/10 bg-ink-950/30"
                            style={{ height: 300 }}
                          >
                            <p className="text-sm text-slate-500">
                              {t("characters.openingHtmlPlaceholder")}
                            </p>
                          </div>
                        )}
                      </div>
                    </Field>
                  </div>
                )
              ) : null}

              {activeEditorSection === "lore" ? (
                isLockedPrivateCharacter ? (
                  <EmptyState>{privatePasswordCopy.lockedHelp}</EmptyState>
                ) : (
                  <div className="border-t border-white/5 pt-5">
                    <div className="mb-3 flex items-center justify-between">
                      <p className="text-sm font-semibold text-slate-100">
                        {t("characters.loreEntries")}
                      </p>
                      <span className="text-xs text-slate-500">
                        {t("characters.loreEntryCount", {
                          count: form.loreEntries.filter((e) => e.enabled).length
                        })}
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
                                            triggerMode: event.target.value as
                                              | "user"
                                              | "assistant"
                                              | "both"
                                          };
                                          setForm({ ...form, loreEntries: next });
                                        }}
                                      >
                                        <option value="both">
                                          {t("characters.loreEntryTriggerBoth")}
                                        </option>
                                        <option value="user">
                                          {t("characters.loreEntryTriggerUser")}
                                        </option>
                                        <option value="assistant">
                                          {t("characters.loreEntryTriggerAssistant")}
                                        </option>
                                      </select>
                                    </Field>
                                    <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-400">
                                      <input
                                        checked={entry.alwaysActive}
                                        type="checkbox"
                                        className="rounded border-white/20 bg-ink-950 text-ember-500 focus:ring-ember-500/50"
                                        onChange={() => {
                                          const next = [...form.loreEntries];
                                          next[index] = {
                                            ...entry,
                                            alwaysActive: !entry.alwaysActive
                                          };
                                          setForm({ ...form, loreEntries: next });
                                        }}
                                      />
                                      {t("characters.loreEntryAlwaysActive")}
                                    </label>
                                    <Field label={t("characters.loreEntryScope")}>
                                      <select
                                        className="w-full rounded-lg border border-white/10 bg-ink-950 px-3 py-2 text-sm text-slate-200 focus:border-ember-500/50 focus:outline-none focus:ring-1 focus:ring-ember-500/30"
                                        value={entry.scope}
                                        onChange={(event) => {
                                          const next = [...form.loreEntries];
                                          next[index] = {
                                            ...entry,
                                            scope: event.target.value as
                                              | "prefix"
                                              | "prompt"
                                              | "suffix"
                                          };
                                          setForm({ ...form, loreEntries: next });
                                        }}
                                      >
                                        <option value="prefix">
                                          {t("characters.loreEntryScopePrefix")}
                                        </option>
                                        <option value="prompt">
                                          {t("characters.loreEntryScopePrompt")}
                                        </option>
                                        <option value="suffix">
                                          {t("characters.loreEntryScopeSuffix")}
                                        </option>
                                      </select>
                                    </Field>
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

              {activeEditorSection === "quickReplies" ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold text-slate-200">
                      {t("characters.quickReplies")}
                    </p>
                  </div>
                  {form.quickReplies.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-white/10 px-4 py-6 text-center">
                      <p className="text-sm text-slate-400">{t("characters.quickRepliesEmpty")}</p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {form.quickReplies.map((qr, index) => (
                        <div
                          className="rounded-xl border border-white/10 bg-ink-950/40 transition-colors"
                          key={qr._localId}
                        >
                          <div
                            className="flex cursor-pointer items-center justify-between gap-2 px-4 py-3 select-none"
                            onClick={() => {
                              const next = [...form.quickReplies];
                              next[index] = { ...qr, _collapsed: !qr._collapsed };
                              setForm({ ...form, quickReplies: next });
                            }}
                          >
                            <div className="flex min-w-0 items-center gap-2">
                              <ChevronDown
                                size={14}
                                className={`shrink-0 text-slate-500 transition-transform duration-200 ${
                                  qr._collapsed ? "-rotate-90" : ""
                                }`}
                              />
                              <span className="truncate text-sm font-medium text-slate-200">
                                {qr.label || t("characters.quickReplyIndex", { index: index + 1 })}
                              </span>
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                              <button
                                className="rounded-lg p-1 text-slate-500 transition-colors hover:bg-red-500/10 hover:text-red-400"
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  const next = form.quickReplies.filter((_, i) => i !== index);
                                  setForm({ ...form, quickReplies: next });
                                }}
                              >
                                <X size={14} />
                              </button>
                            </div>
                          </div>
                          <div
                            className={`overflow-hidden transition-all duration-200 ease-out ${
                              qr._collapsed
                                ? "max-h-0 border-t-0 opacity-0"
                                : "max-h-[600px] border-t border-white/5 opacity-100"
                            }`}
                          >
                            <div className="px-4 pb-4 pt-3 space-y-3">
                              <Field label={t("characters.quickReplyLabel")}>
                                <TextInput
                                  placeholder={t("characters.quickReplyLabelPlaceholder")}
                                  value={qr.label}
                                  onChange={(event) => {
                                    const next = [...form.quickReplies];
                                    next[index] = { ...qr, label: event.target.value };
                                    setForm({ ...form, quickReplies: next });
                                  }}
                                />
                              </Field>
                              <Field container="div" label={t("characters.quickReplyContent")}>
                                <TextArea
                                  className="!h-[120px] min-h-[120px]"
                                  placeholder={t("characters.quickReplyContentPlaceholder")}
                                  value={qr.content}
                                  onChange={(event) => {
                                    const next = [...form.quickReplies];
                                    next[index] = { ...qr, content: event.target.value };
                                    setForm({ ...form, quickReplies: next });
                                  }}
                                />
                              </Field>
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
                        quickReplies: [...form.quickReplies, blankQuickReply()]
                      })
                    }
                  >
                    <Plus size={14} />
                    {t("characters.quickReplyAdd")}
                  </Button>
                </div>
              ) : null}

              <div className="flex flex-wrap justify-end gap-3 pt-4 border-t border-white/5">
                <Button
                  disabled={loading || !selected}
                  variant="danger"
                  onClick={() => setDeleteConfirmOpen(true)}
                >
                  <Trash2 size={16} />
                  {t("common.delete")}
                </Button>
                <Button
                  disabled={loading || !form.name.trim()}
                  onClick={() => void saveCharacter()}
                >
                  <Save size={16} />
                  {t("common.save")}
                </Button>
              </div>
            </div>
          </Panel>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"
              size={16}
            />
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

          <ErrorNotice message={error} />
          <SuccessNotice message={status} />

          {characters.length === 0 && pagination.total === 0 && !searchQuery.trim() ? (
            <div className="flex items-center justify-center py-16">
              <EmptyState>{t("characters.noCharacters")}</EmptyState>
            </div>
          ) : characters.length === 0 ? (
            <div className="flex items-center justify-center py-16">
              <EmptyState>{t("characters.noSearchResults")}</EmptyState>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                {characters.map((character) => (
                  <CharacterCard
                    key={character.id}
                    character={character}
                    noDescriptionLabel={t("common.noDescription")}
                    privateSummaryLabel={privateCharacterCopy.privateSummary}
                    playLabel={t("characters.play")}
                    editLabel={t("common.edit")}
                    onPlay={onPlay}
                    onEdit={selectCharacter}
                  />
                ))}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 pt-3 text-xs text-slate-400">
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
                    onClick={() =>
                      setCharacterPage((current) => Math.min(pagination.totalPages, current + 1))
                    }
                  >
                    {language === "zh-CN" ? "下一页" : "Next"}
                    <ChevronRight size={14} />
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      )}
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
    </>
  );
}
