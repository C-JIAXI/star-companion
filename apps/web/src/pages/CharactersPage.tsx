import {
  AlertTriangle,
  ArrowUpDown,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  Download,
  FileUp,
  ImagePlus,
  Lock,
  Maximize2,
  Minus,
  Plus,
  Save,
  Search,
  Sparkles,
  Star,
  Tag,
  Trash2,
  X,
  CheckSquare,
  Copy,
  Square,
  RotateCcw,
  ListChecks
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { CharacterCard } from "../components/CharacterCard";
import { MarkdownEditor } from "../components/MarkdownEditor";
import { ScopedHtmlRenderer } from "../components/ScopedHtmlRenderer";
import { useI18n } from "../i18n";
import { api } from "../lib/api";
import { useAppStore } from "../store/useAppStore";
import { readFileAsDataUrl, readFileText, saveJsonFile } from "../lib/files";
import { usePlaceholderSrc } from "../placeholderImages";
import { checkCharacterQuality, type CharacterQualityIssue } from "@local-roleplay/shared";
import type {
  CharacterCardImportInput,
  CharacterBatchTagsRequestDTO,
  CharacterDTO,
  CharacterSummaryDTO,
  CharacterDraftResponseDTO,
  CharacterDraftTask,
  CharacterExportMode,
  CharacterInput,
  CharacterLoreEntryDTO,
  CharacterSortMode,
  QuickReplyDTO
} from "../types";
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorNotice,
  Field,
  HelpLabel,
  Modal,
  Panel,
  SuccessNotice,
  TextArea,
  TextInput
} from "../components/ui";

const CHARACTER_PAGE_SIZE = 40;
const MAX_CHARACTER_AVATAR_FILE_SIZE = 2 * 1024 * 1024;
const CHARACTER_AVATAR_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif"
]);

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
type EditorSectionId = "prompt" | "tags" | "html" | "opening" | "lore" | "quickReplies" | "review" | "assistant";
type CharacterEditorMode = "basic" | "advanced";
type PasswordDialogMode = "unlock" | "export-private" | "export-public";
type ExpandedTextField = "htmlCss" | "openingHtml";

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
  tags: [] as string[],
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
        className="animate-scale-in flex w-full max-w-md flex-col overflow-hidden rounded-lg border border-white/[0.1] bg-ink-900 shadow-xl shadow-black/45"
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
  tags: character.tags ?? [],
  prefix: character.prefix,
  prompt: character.prompt,
  suffix: character.suffix,
  htmlCss: character.htmlCss,
  openingHtml: character.visibility === "private" && !character.canViewPrompt ? "" : character.openingHtml,
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
  tags: form.tags,
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

const BASIC_EDITABLE_FIELDS = ["name", "avatar", "description", "tags", "prompt", "openingHtml", "quickReplies"] as const;
const toBasicUpdate = (form: CharacterForm, saved: CharacterForm, locked: boolean): Partial<CharacterInput> => {
  const current = toInput(form);
  const previous = toInput(saved);
  const update: Partial<CharacterInput> = {};
  for (const field of BASIC_EDITABLE_FIELDS) {
    if (locked && field === "prompt") continue;
    if (JSON.stringify(current[field]) !== JSON.stringify(previous[field])) {
      Object.assign(update, { [field]: current[field] });
    }
  }
  return update;
};

const copyForm = (form: CharacterForm): CharacterForm => ({
  ...form,
  tags: [...form.tags],
  loreEntries: form.loreEntries.map((entry) => ({ ...entry, keys: [...entry.keys] })),
  quickReplies: form.quickReplies.map((reply) => ({ ...reply }))
});

const serializeCharacterForm = (form: CharacterForm) =>
  JSON.stringify({
    ...form,
    loreEntries: form.loreEntries.map(({ _localId, _collapsed, ...entry }) => entry),
    quickReplies: form.quickReplies.map(({ _localId, _collapsed, ...reply }) => reply)
  });

const normalizeTags = (tags: string[]) =>
  Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean))).slice(0, 24);

const splitTagInput = (value: string) =>
  value
    .split(/[,，]/)
    .map((tag) => tag.trim())
    .filter(Boolean);

const formatCharacterDate = (value: string, language: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat(language === "zh-CN" ? "zh-CN" : "en", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
};

const emptyCharacterPage = {
  items: [] as CharacterSummaryDTO[],
  total: 0,
  page: 1,
  pageSize: CHARACTER_PAGE_SIZE,
  totalPages: 1,
  availableTags: [] as string[]
};

export function CharactersPage({
  onPlay,
  onDirtyChange
}: {
  onPlay: (characterId: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { language, t } = useI18n();
  const [characters, setCharacters] = useState<CharacterSummaryDTO[]>([]);
  const [characterPage, setCharacterPage] = useState(1);
  const [pagination, setPagination] = useState(emptyCharacterPage);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedCharacter, setSelectedCharacter] = useState<CharacterDTO | null>(null);
  const [form, setForm] = useState<CharacterForm>(blankForm);
  const [savedForm, setSavedForm] = useState<CharacterForm>(() => copyForm(blankForm));
  const [savedFormSnapshot, setSavedFormSnapshot] = useState(() =>
    serializeCharacterForm(blankForm)
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTag, setSelectedTag] = useState("");
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [characterSort, setCharacterSort] = useState<CharacterSortMode>("favorites");
  const [favoritePendingId, setFavoritePendingId] = useState<string | null>(null);
  const [tagInput, setTagInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [exportMode, setExportMode] = useState<CharacterExportMode>("public");
  const [passwordDialogMode, setPasswordDialogMode] = useState<PasswordDialogMode | null>(null);
  const [passwordValue, setPasswordValue] = useState("");
  const [activeEditorSection, setActiveEditorSection] = useState<EditorSectionId>("prompt");
  const [editorMode, setEditorMode] = useState<CharacterEditorMode>(() =>
    window.localStorage.getItem("star-companion-character-editor-mode") === "advanced" ? "advanced" : "basic"
  );
  const [wizardStep, setWizardStep] = useState(0);
  const [qualityVisible, setQualityVisible] = useState(false);
  const [undoStack, setUndoStack] = useState<Array<{ form: CharacterForm; mode: CharacterEditorMode }>>([]);
  const [draftTask, setDraftTask] = useState<CharacterDraftTask>("generate_core_prompt");
  const [draftBrief, setDraftBrief] = useState("");
  const [draftResult, setDraftResult] = useState<CharacterDraftResponseDTO | null>(null);
  const [draftLoading, setDraftLoading] = useState(false);
  const [draftApplyAllConfirm, setDraftApplyAllConfirm] = useState(false);
  const draftAbortRef = useRef<AbortController | null>(null);
  const characterImportInputRef = useRef<HTMLInputElement | null>(null);
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchTagDialogOpen, setBatchTagDialogOpen] = useState(false);
  const [batchTagOperation, setBatchTagOperation] = useState<"add" | "remove">("add");
  const [batchTagInput, setBatchTagInput] = useState("");
  const [batchTags, setBatchTags] = useState<string[]>([]);
  const [batchTagError, setBatchTagError] = useState<string | null>(null);
  const [batchDeleteConfirmOpen, setBatchDeleteConfirmOpen] = useState(false);
  const [pageInputValue, setPageInputValue] = useState("");
  const [previewTemplateId, setPreviewTemplateId] = useState<HtmlPreviewTemplateId>(
    DEFAULT_HTML_PREVIEW_TEMPLATE
  );
  const [previewMarkup, setPreviewMarkup] = useState<string>(
    HTML_PREVIEW_TEMPLATES[DEFAULT_HTML_PREVIEW_TEMPLATE]
  );
  const [expandedTextField, setExpandedTextField] = useState<ExpandedTextField | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [justCreatedId, setJustCreatedId] = useState<string | null>(null);
  const [pendingEditorExit, setPendingEditorExit] = useState<"new" | "list" | null>(null);
  const characterRequestRef = useRef(0);
  const unlockedPasswordRef = useRef<Record<string, string>>({});
  useEffect(() => () => {
    draftAbortRef.current?.abort();
    draftAbortRef.current = null;
    unlockedPasswordRef.current = {};
  }, []);
  const editorCoverSrc = usePlaceholderSrc(form.avatar, selectedId ?? undefined);
  const usingUploadedAvatar = form.avatar.startsWith("data:image/");
  const expandedTextFieldTitle =
    expandedTextField === "htmlCss"
      ? t("characters.htmlCss")
      : expandedTextField === "openingHtml"
        ? t("characters.openingHtml")
        : "";
  const expandedTextFieldValue = expandedTextField ? form[expandedTextField] : "";
  const updateExpandedTextField = (value: string) => {
    if (!expandedTextField) {
      return;
    }

    setForm((current) => ({ ...current, [expandedTextField]: value }));
  };

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
      { id: "tags" as const, label: t("characters.tags") },
      { id: "html" as const, label: t("characters.editorSectionHtml") },
      { id: "opening" as const, label: t("characters.editorSectionOpening") },
      { id: "lore" as const, label: t("characters.editorSectionLore") },
      { id: "quickReplies" as const, label: t("characters.editorSectionQuickReplies") }
    ],
    [t]
  );

  const characterSortOptions = useMemo(
    () => [
      { value: "favorites" as const, label: t("characters.sortFavorites") },
      { value: "recently_chatted" as const, label: t("characters.sortRecentlyChatted") },
      { value: "most_chats" as const, label: t("characters.sortMostChats") },
      { value: "recently_updated" as const, label: t("characters.sortRecentlyUpdated") },
      { value: "name_asc" as const, label: t("characters.sortNameAsc") },
      { value: "name_desc" as const, label: t("characters.sortNameDesc") }
    ],
    [t]
  );

  const selected = selectedCharacter;
  const isLockedPrivateCharacter = selected?.visibility === "private" && !selected.canViewPrompt;
  const quality = useMemo(
    () => checkCharacterQuality(form, { protectedContentAvailable: !isLockedPrivateCharacter }),
    [form, isLockedPrivateCharacter]
  );
  const blockingQualityIssues = quality.issues.filter((item) => item.severity === "error");
  const currentFormSnapshot = useMemo(() => serializeCharacterForm(form), [form]);
  const editorOpen = isCreating || Boolean(selectedId && selectedCharacter);
  const hasUnsavedChanges = editorOpen && currentFormSnapshot !== savedFormSnapshot;
  const showIdentityFields = editorMode === "advanced" || !isCreating || wizardStep === 0;

  const switchEditorMode = (mode: CharacterEditorMode) => {
    if (mode === editorMode) return;
    setUndoStack((current) => [...current.slice(-9), { form: copyForm(form), mode: editorMode }]);
    setEditorMode(mode);
    window.localStorage.setItem("star-companion-character-editor-mode", mode);
    if (mode === "advanced") setActiveEditorSection("prompt");
  };

  const undoDraftChange = () => {
    const previous = undoStack[undoStack.length - 1];
    if (!previous) return;
    setForm(copyForm(previous.form));
    setEditorMode(previous.mode);
    window.localStorage.setItem("star-companion-character-editor-mode", previous.mode);
    setUndoStack((current) => current.slice(0, -1));
  };

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

  const resolveCharacterDetail = async (character: CharacterSummaryDTO) => {
    const password = unlockedPasswordRef.current[character.id];
    const detail = await api.characters.get(character.id);
    if (character.visibility !== "private" || detail.canViewPrompt || !password) return detail;

    try {
      return await api.characters.unlock(character.id, password);
    } catch {
      delete unlockedPasswordRef.current[character.id];
      return detail;
    }
  };

  const applyCharacterToEditor = (character: CharacterDTO) => {
    const nextForm = toForm(character);
    setSelectedCharacter(character);
    setForm(nextForm);
    setSavedForm(copyForm(nextForm));
    setSavedFormSnapshot(serializeCharacterForm(nextForm));
    setUndoStack([]);
    setDraftResult(null);
    setQualityVisible(false);
  };

  const loadCharacters = async (
    nextPage = characterPage,
    nextSearchQuery = searchQuery,
    nextSelectedTag = selectedTag,
    nextFavoriteOnly = favoriteOnly,
    nextSort = characterSort,
    nextSelectedId = selectedId
  ) => {
    const requestId = characterRequestRef.current + 1;
    characterRequestRef.current = requestId;
    const data = await api.characters.page({
      q: nextSearchQuery,
      tag: nextSelectedTag,
      favoriteOnly: nextFavoriteOnly,
      sort: nextSort,
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
      applyCharacterToEditor(detail);
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
  }, [characterPage, searchQuery, selectedTag, favoriteOnly, characterSort, t]);

  useEffect(() => {
    if (!status) {
      return;
    }

    const timeoutId = window.setTimeout(() => setStatus(null), 2200);
    return () => window.clearTimeout(timeoutId);
  }, [status]);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (hasUnsavedChanges) {
        event.preventDefault();
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasUnsavedChanges]);

  useEffect(() => {
    onDirtyChange?.(hasUnsavedChanges);
  }, [hasUnsavedChanges, onDirtyChange]);

  useEffect(
    () => () => {
      onDirtyChange?.(false);
    },
    [onDirtyChange]
  );

  const selectCharacter = (character: CharacterSummaryDTO) => {
    setIsCreating(false);
    setSelectedId(character.id);
    setError(null);
    setStatus(null);
    void resolveCharacterDetail(character).then((detail) => {
      applyCharacterToEditor(detail);
    });
  };

  const toggleFavorite = async (character: CharacterSummaryDTO) => {
    if (favoritePendingId) {
      return;
    }

    setFavoritePendingId(character.id);
    setError(null);
    setStatus(null);
    try {
      const updated = await api.characters.update(character.id, {
        isFavorite: !character.isFavorite
      });
      setSelectedCharacter((current) =>
        current?.id === updated.id ? { ...current, isFavorite: updated.isFavorite } : current
      );
      await loadCharacters(
        characterPage,
        searchQuery,
        selectedTag,
        favoriteOnly,
        characterSort,
        selectedId
      );
      setStatus(
        updated.isFavorite ? t("characters.favorited") : t("characters.unfavorited")
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("characters.failedSave"));
    } finally {
      setFavoritePendingId(null);
    }
  };

  const resetForm = () => {
    const nextForm = { ...blankForm };
    setIsCreating(true);
    setSelectedId(null);
    setSelectedCharacter(null);
    setForm(nextForm);
    setSavedForm(copyForm(nextForm));
    setSavedFormSnapshot(serializeCharacterForm(nextForm));
    setWizardStep(0);
    setUndoStack([]);
    setDraftResult(null);
    setError(null);
    setStatus(null);
  };

  const returnToCharacterList = () => {
    const nextForm = { ...blankForm };
    setSelectedId(null);
    setSelectedCharacter(null);
    setForm(nextForm);
    setSavedForm(copyForm(nextForm));
    setSavedFormSnapshot(serializeCharacterForm(nextForm));
    setIsCreating(false);
    setError(null);
    setStatus(null);
  };

  const requestEditorExit = (action: "new" | "list") => {
    if (hasUnsavedChanges) {
      setPendingEditorExit(action);
      return;
    }

    if (action === "new") {
      resetForm();
    } else {
      returnToCharacterList();
    }
  };

  const confirmEditorExit = () => {
    const action = pendingEditorExit;
    setPendingEditorExit(null);
    if (action === "new") {
      resetForm();
    } else if (action === "list") {
      returnToCharacterList();
    }
  };

  const saveCharacter = async (startChatAfterCreate = false) => {
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
        const updates = editorMode === "basic"
          ? toBasicUpdate(form, savedForm, isLockedPrivateCharacter)
          : toInput(form);
        if (Object.keys(updates).length === 0) {
          setStatus(t("characters.saved"));
          return;
        }
        const updated = await api.characters.update(
          editingCharacter.id,
          updates,
          accessPassword
        );
        applyCharacterToEditor(updated);
        await loadCharacters(
          characterPage,
          searchQuery,
          selectedTag,
          favoriteOnly,
          characterSort,
          updated.id
        );
      } else {
        const created = await api.characters.create(toInput(form));
        void useAppStore.getState().refreshReadiness();
        setIsCreating(false);
        setSearchQuery("");
        setSelectedTag("");
        setFavoriteOnly(false);
        setCharacterPage(1);
        setSelectedId(created.id);
        setJustCreatedId(created.id);
        applyCharacterToEditor(created);
        await loadCharacters(1, "", "", false, characterSort, created.id);
        if (startChatAfterCreate) onPlay(created.id);
      }
      setStatus(t("characters.saved"));
      setUndoStack([]);
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

  const focusQualityIssue = (item: CharacterQualityIssue) => {
    const section: EditorSectionId = item.field === "loreEntries" ? "lore"
      : item.field === "quickReplies" ? "quickReplies"
        : item.field === "openingHtml" ? "opening"
          : item.field === "htmlCss" ? "html"
            : item.field === "avatar" || item.field === "name" || item.field === "description" ? "prompt"
              : "prompt";
    if (editorMode === "basic" && (section === "lore" || section === "html")) switchEditorMode("advanced");
    if (item.field === "loreEntries" && item.itemIndex !== undefined) {
      setForm((current) => ({ ...current, loreEntries: current.loreEntries.map((entry, index) => index === item.itemIndex ? { ...entry, _collapsed: false } : entry) }));
    }
    if (item.field === "quickReplies" && item.itemIndex !== undefined) {
      setForm((current) => ({ ...current, quickReplies: current.quickReplies.map((entry, index) => index === item.itemIndex ? { ...entry, _collapsed: false } : entry) }));
    }
    setActiveEditorSection(section);
    if (isCreating && editorMode === "basic") {
      setWizardStep(item.field === "name" || item.field === "avatar" || item.field === "description" ? 0 : item.field === "openingHtml" || item.field === "quickReplies" ? 2 : item.field === "prompt" ? 1 : 3);
    }
    window.setTimeout(() => {
      const indexedSelector = item.itemIndex === undefined
        ? null
        : `[data-character-field="${item.field}"][data-character-item-index="${item.itemIndex}"]`;
      const root = (indexedSelector ? document.querySelector<HTMLElement>(indexedSelector) : null)
        ?? document.querySelector<HTMLElement>(`[data-character-field="${item.field}"]`);
      const issueTarget = item.code === "lore_content_empty" ? "lore-content"
        : item.code === "lore_keywords_missing" || item.code === "lore_keywords_overlap" ? "lore-keys"
          : item.code === "lore_trigger_invalid" ? "lore-trigger"
            : item.code === "quick_reply_content_empty" ? "quick-reply-content"
              : item.code === "quick_reply_label_empty" || item.code === "quick_reply_label_duplicate" ? "quick-reply-label"
                : null;
      const exactTarget = issueTarget ? root?.querySelector<HTMLElement>(`[data-character-focus="${issueTarget}"]`) : null;
      const target = exactTarget?.matches("input,textarea,select,button,[contenteditable=true]") ? exactTarget
        : exactTarget?.querySelector<HTMLElement>("input,textarea,select,button,[contenteditable=true]")
          ?? (root?.matches("input,textarea,select,button,[contenteditable=true]") ? root : root?.querySelector<HTMLElement>("input,textarea,select,button,[contenteditable=true]"));
      root?.scrollIntoView({ behavior: "smooth", block: "center" });
      target?.focus();
    }, 50);
  };

  const requestCharacterDraft = async () => {
    if (isLockedPrivateCharacter) return;
    draftAbortRef.current?.abort();
    const controller = new AbortController();
    draftAbortRef.current = controller;
    setDraftLoading(true);
    setError(null);
    try {
      const input = toInput(form);
      const result = await api.characters.draft({
        requestId: `character_agent_${crypto.randomUUID()}`,
        task: draftTask,
        brief: draftBrief.trim() || undefined,
        characterId: selected?.id,
        accessPassword: selected?.visibility === "private" ? unlockedPasswordRef.current[selected.id] : undefined,
        draft: {
          name: input.name,
          description: input.description ?? "",
          prefix: input.prefix ?? "",
          prompt: input.prompt ?? "",
          suffix: input.suffix ?? "",
          loreEntries: input.loreEntries ?? [],
          quickReplies: input.quickReplies ?? []
        }
      }, controller.signal);
      if (draftAbortRef.current === controller && !controller.signal.aborted) setDraftResult(result);
    } catch (caught) {
      if (draftAbortRef.current === controller && !controller.signal.aborted) setError(caught instanceof Error ? caught.message : "AI draft failed");
    } finally {
      if (draftAbortRef.current === controller) {
        draftAbortRef.current = null;
        setDraftLoading(false);
      }
    }
  };

  const cancelCharacterDraft = () => {
    const controller = draftAbortRef.current;
    if (!controller) return;
    draftAbortRef.current = null;
    controller.abort();
    setDraftLoading(false);
  };

  const applyDraftItems = (ids: string[]) => {
    if (!draftResult) return;
    const selectedItems = draftResult.items.filter((item) => ids.includes(item.id));
    if (!selectedItems.length) return;
    setUndoStack((current) => [...current.slice(-9), { form: copyForm(form), mode: editorMode }]);
    setForm((current) => {
      const next = copyForm(current);
      for (const item of selectedItems) {
        if (item.field === "prompt") next.prompt = item.suggestion;
        if (item.field === "loreEntries" && item.loreEntry) next.loreEntries.push({ ...item.loreEntry, id: "", _localId: crypto.randomUUID(), _collapsed: false });
        if (item.field === "quickReplies" && item.quickReply) next.quickReplies.push({ ...item.quickReply, id: "", _localId: crypto.randomUUID(), _collapsed: false });
      }
      return next;
    });
    setStatus(language === "zh-CN" ? "AI 草案已应用到未保存编辑，可撤销。" : "AI draft applied to unsaved edits. You can undo it.");
  };

  const duplicateCharacter = async () => {
    if (!selected) {
      return;
    }

    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const duplicate = await api.characters.duplicate(
        selected.id,
        `${selected.name} ${t("characters.copySuffix")}`
      );
      void useAppStore.getState().refreshReadiness();
      setSearchQuery("");
      setSelectedTag("");
      setFavoriteOnly(false);
      setCharacterSort("recently_updated");
      setCharacterPage(1);
      setSelectedId(duplicate.id);
      applyCharacterToEditor(duplicate);
      setStatus(t("characters.duplicated"));
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
      void useAppStore.getState().refreshReadiness();
      setDeleteConfirmOpen(false);
      setSelectedId(null);
      setSelectedCharacter(null);
      setForm(blankForm);
      setSavedFormSnapshot(serializeCharacterForm(blankForm));
      await loadCharacters();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("characters.failedDelete"));
    } finally {
      setLoading(false);
    }
  };

  const batchDeleteCharacters = async () => {
    if (selectedIds.size === 0) {
      return;
    }

    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const ids = Array.from(selectedIds);
      await api.characters.batchRemove(ids);
      void useAppStore.getState().refreshReadiness();
      setBatchDeleteConfirmOpen(false);
      setSelectedIds(new Set());
      setBatchMode(false);
      await loadCharacters();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("characters.failedDelete"));
    } finally {
      setLoading(false);
    }
  };

  const openBatchTagDialog = (operation: "add" | "remove") => {
    setBatchTagOperation(operation);
    setBatchTagInput("");
    setBatchTags([]);
    setBatchTagError(null);
    setBatchTagDialogOpen(true);
  };

  const addBatchTags = (rawValue: string) => {
    setBatchTags((current) => normalizeTags([...current, ...splitTagInput(rawValue)]));
    setBatchTagInput("");
    setBatchTagError(null);
  };

  const toggleBatchTag = (tag: string) => {
    setBatchTagError(null);
    setBatchTags((current) =>
      current.some((candidate) => candidate.toLowerCase() === tag.toLowerCase())
        ? current.filter((candidate) => candidate.toLowerCase() !== tag.toLowerCase())
        : normalizeTags([...current, tag])
    );
  };

  const applyBatchTags = async () => {
    if (selectedIds.size === 0 || batchTags.length === 0) {
      return;
    }

    setLoading(true);
    setError(null);
    setBatchTagError(null);
    setStatus(null);
    try {
      const input: CharacterBatchTagsRequestDTO = {
        ids: Array.from(selectedIds),
        operation: batchTagOperation,
        tags: batchTags
      };
      const result = await api.characters.batchTags(input);
      setBatchTagDialogOpen(false);
      setSelectedIds(new Set());
      setBatchMode(false);
      await loadCharacters();
      setStatus(
        t(
          batchTagOperation === "add"
            ? "characters.batchTagsAdded"
            : "characters.batchTagsRemoved",
          { count: result.updated }
        )
      );
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "";
      setBatchTagError(
        message.includes("more than 24 tags")
          ? t("characters.batchTagsLimit")
          : message || t("characters.batchTagsFailed")
      );
    } finally {
      setLoading(false);
    }
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === characters.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(characters.map((c) => c.id)));
    }
  };

  const toggleSelectCharacter = (id: string, selected: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (selected) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  };

  const handlePageInputChange = (value: string) => {
    setPageInputValue(value);
  };

  const handlePageInputSubmit = () => {
    const page = parseInt(pageInputValue, 10);
    if (!isNaN(page) && page >= 1 && page <= pagination.totalPages && page !== characterPage) {
      setCharacterPage(page);
    }
    setPageInputValue("");
  };

  const handlePageInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      handlePageInputSubmit();
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
      await saveJsonFile(`${selected.name || "character"}-${exportMode}.json`, card);
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
      void useAppStore.getState().refreshReadiness();
      setIsCreating(false);
      delete unlockedPasswordRef.current[imported.id];
      setSearchQuery("");
      setSelectedTag("");
      setFavoriteOnly(false);
      setCharacterPage(1);
      setSelectedId(imported.id);
      applyCharacterToEditor(imported);
      await loadCharacters(1, "", "", false, characterSort, imported.id);
      setStatus(privateCharacterCopy.imported);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("characters.failedImport"));
    } finally {
      setLoading(false);
    }
  };

  const updateAvatarFile = async (file: File | undefined) => {
    if (!file) {
      return;
    }

    if (!CHARACTER_AVATAR_MIME_TYPES.has(file.type)) {
      setError(t("characters.avatarInvalid"));
      return;
    }
    if (file.size > MAX_CHARACTER_AVATAR_FILE_SIZE) {
      setError(t("characters.avatarTooLarge"));
      return;
    }

    try {
      const avatar = await readFileAsDataUrl(file);
      setForm((current) => ({ ...current, avatar }));
      setError(null);
      setStatus(t("characters.avatarUploaded"));
    } catch {
      setError(t("characters.avatarUploadFailed"));
    }
  };

  const applyPreviewTemplate = (templateId: HtmlPreviewTemplateId) => {
    setPreviewTemplateId(templateId);
    setPreviewMarkup(HTML_PREVIEW_TEMPLATES[templateId]);
  };

  const addTagsToForm = (rawValue: string) => {
    const nextTags = normalizeTags([...form.tags, ...splitTagInput(rawValue)]);
    setForm({ ...form, tags: nextTags });
    setTagInput("");
  };

  const removeTagFromForm = (tag: string) => {
    setForm({ ...form, tags: form.tags.filter((item) => item !== tag) });
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
      applyCharacterToEditor(unlocked);
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
        applyCharacterToEditor(unlocked);
      }
      await saveJsonFile(
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
        {hasUnsavedChanges ? (
          <span
            className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-amber-300"
            data-testid="character-unsaved-indicator"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-amber-300" />
            {t("characters.unsavedChanges")}
          </span>
        ) : null}
        <Button
          variant="secondary"
          onClick={() => requestEditorExit("new")}
          className="!h-9 !min-h-[36px] !px-3 text-xs ml-auto"
        >
          <Plus size={14} />
          {t("common.new")}
        </Button>
        <label
          className={`inline-flex h-9 min-h-[36px] items-center gap-2 rounded-md border border-white/[0.08] bg-ink-800 px-3 text-xs font-medium transition-colors focus-within:ring-2 focus-within:ring-ember-500/35 ${
            hasUnsavedChanges
              ? "cursor-not-allowed text-slate-600"
              : "cursor-pointer text-slate-200 hover:border-white/[0.14] hover:bg-ink-700"
          }`}
        >
          <FileUp size={14} />
          {t("common.import")}
          <input
            ref={characterImportInputRef}
            className="sr-only"
            disabled={hasUnsavedChanges}
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
            data-testid="character-editor-back"
            type="button"
            onClick={() => requestEditorExit("list")}
          >
            <ChevronLeft size={14} />
            {language === "zh-CN" ? "返回角色列表" : "Back to characters"}
          </button>

          <Panel
            className="p-5 sm:p-6"
            title={t("characters.edit")}
            action={
              <>
                <div className="inline-flex rounded-md border border-white/[0.08] bg-ink-950/50 p-1">
                  {(["public", "private"] as CharacterExportMode[]).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                        exportMode === mode
                          ? "bg-ember-500 text-accentForeground"
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
                  disabled={!selected || hasUnsavedChanges}
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
              <div className="flex flex-col gap-3 rounded-lg border border-white/[0.08] bg-ink-950/35 p-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-semibold text-slate-100">
                    {language === "zh-CN" ? "创作模式" : "Creation mode"}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-slate-500">
                    {language === "zh-CN" ? "基础与高级模式编辑同一份角色草稿，切换不会清空隐藏字段。" : "Basic and advanced modes edit the same draft. Switching never clears hidden fields."}
                  </p>
                </div>
                <div className="flex gap-1 rounded-md border border-white/10 bg-ink-950 p-1" data-testid="character-editor-mode">
                  {(["basic", "advanced"] as CharacterEditorMode[]).map((mode) => (
                    <button key={mode} type="button" aria-pressed={editorMode === mode} className={`min-h-[44px] rounded px-4 text-sm font-medium ${editorMode === mode ? "bg-ember-500 text-accentForeground" : "text-slate-300 hover:bg-white/5"}`} onClick={() => switchEditorMode(mode)}>
                      {mode === "basic" ? (language === "zh-CN" ? "基础模式" : "Basic") : (language === "zh-CN" ? "高级模式" : "Advanced")}
                    </button>
                  ))}
                  <button type="button" disabled={!undoStack.length} className="min-h-[44px] rounded px-3 text-slate-300 disabled:opacity-40" onClick={undoDraftChange} aria-label={language === "zh-CN" ? "撤销上次草稿操作" : "Undo last draft action"}><RotateCcw size={15} /></button>
                </div>
              </div>
              {isCreating && editorMode === "basic" ? (
                <div className="space-y-3" data-testid="character-wizard">
                  <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label={language === "zh-CN" ? "创建步骤" : "Creation steps"}>
                    {(language === "zh-CN" ? ["身份", "核心设定", "开场体验", "检查与创建"] : ["Identity", "Core", "Opening", "Review"]).map((label, index) => (
                      <li key={label}><button type="button" className={`min-h-[44px] w-full rounded-md border px-2 text-xs ${wizardStep === index ? "border-ember-400 bg-ember-500/10 text-ember-100" : "border-white/10 text-slate-400"}`} onClick={() => setWizardStep(index)}>{index + 1}. {label}</button></li>
                    ))}
                  </ol>
                  <div className="flex flex-wrap justify-between gap-2">
                    <Button variant="ghost" disabled={wizardStep === 0} onClick={() => setWizardStep((step) => Math.max(0, step - 1))}><ChevronLeft size={14} />{language === "zh-CN" ? "上一步" : "Previous"}</Button>
                    <Button variant="secondary" onClick={() => switchEditorMode("advanced")}>{language === "zh-CN" ? "切换高级编辑" : "Switch to advanced"}</Button>
                    <Button variant="ghost" disabled={wizardStep === 3} onClick={() => setWizardStep((step) => Math.min(3, step + 1))}>{language === "zh-CN" ? "下一步（可跳过）" : "Next (optional)"}<ChevronRight size={14} /></Button>
                  </div>
                </div>
              ) : null}
              {selected?.visibility === "private" ? (
                <div className="rounded-lg border border-amber-400/15 bg-amber-500/[0.08] px-4 py-3 text-sm text-amber-100">
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
              {editorMode === "basic" && selected && (selected.prefix.trim() || selected.suffix.trim() || selected.htmlCss.trim() || selected.loreEntries.length > 0) ? (
                <div className="rounded-lg border border-sky-400/15 bg-sky-500/[0.06] px-4 py-3 text-xs leading-5 text-sky-100">
                  {language === "zh-CN" ? "此角色包含高级内容。基础模式会完整保留它们；切换高级模式即可查看。" : "This character contains advanced content. Basic mode preserves it unchanged; switch to Advanced to inspect it."}
                </div>
              ) : null}
              {showIdentityFields ? <div className="grid gap-6 lg:grid-cols-[2fr_1fr]" data-character-field="name">
                <div className="grid gap-5">
                  <div data-character-field="name"><Field label={t("common.name")}>
                    <TextInput
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                    />
                  </Field></div>
                  <div data-character-field="avatar"><Field container="div" label={t("characters.avatarUrl")}>
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      {usingUploadedAvatar ? (
                        <div className="flex min-h-[40px] min-w-[12rem] flex-1 items-center gap-2 rounded-md border border-emerald-500/20 bg-emerald-500/5 px-3 text-sm text-emerald-100 sm:min-h-[44px]">
                          <ImagePlus size={15} className="shrink-0 text-emerald-400" />
                          <span className="truncate">{t("characters.avatarLocal")}</span>
                        </div>
                      ) : (
                        <TextInput
                          className="min-w-[12rem] flex-1"
                          placeholder={t("characters.avatarUrlPlaceholder")}
                          value={form.avatar}
                          onChange={(event) => setForm({ ...form, avatar: event.target.value })}
                        />
                      )}
                      <label className="inline-flex min-h-[40px] shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md border border-white/[0.08] bg-ink-800 px-3 text-xs font-medium text-slate-200 transition-colors hover:border-white/[0.14] hover:bg-ink-700 focus-within:ring-2 focus-within:ring-ember-500/35 sm:min-h-[44px]">
                        <ImagePlus size={14} />
                        {form.avatar
                          ? t("characters.avatarReplace")
                          : t("characters.avatarUpload")}
                        <input
                          accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
                          className="sr-only"
                          data-testid="character-avatar-upload"
                          type="file"
                          onChange={(event) => {
                            void updateAvatarFile(event.target.files?.[0]);
                            event.currentTarget.value = "";
                          }}
                        />
                      </label>
                      {form.avatar ? (
                        <Button
                          aria-label={t("characters.avatarRemove")}
                          className="!h-10 !min-h-[40px] !w-10 !px-0 sm:!h-11 sm:!min-h-[44px] sm:!w-11"
                          title={t("characters.avatarRemove")}
                          variant="ghost"
                          onClick={() => setForm({ ...form, avatar: "" })}
                        >
                          <X size={16} />
                        </Button>
                      ) : null}
                    </div>
                  </Field></div>
                  <div data-character-field="description"><Field label={t("characters.description")}>
                    <TextArea
                      value={form.description}
                      onChange={(event) => setForm({ ...form, description: event.target.value })}
                      className="chat-input !h-[100px] min-h-[100px] !text-sm"
                    />
                  </Field></div>
                  {editorMode === "basic" ? <div data-character-field="tags">
                    <Field label={t("characters.tags")}>
                      <div className="space-y-3">
                        <div className="flex gap-2"><TextInput value={tagInput} placeholder={t("characters.tagInputPlaceholder")} onChange={(event) => setTagInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addTagsToForm(tagInput); } }} /><Button variant="secondary" disabled={!tagInput.trim()} onClick={() => addTagsToForm(tagInput)}>{t("characters.tagAdd")}</Button></div>
                        <div className="flex flex-wrap gap-2">{form.tags.map((tag) => <button key={tag} type="button" className="min-h-[36px] rounded border border-ember-500/20 bg-ember-500/10 px-2.5 text-xs text-ember-100" onClick={() => removeTagFromForm(tag)}>{tag} <X className="inline" size={12} /></button>)}</div>
                      </div>
                    </Field>
                  </div> : null}
                </div>
                <div className="group overflow-hidden rounded-lg border border-white/[0.08] bg-ink-950/35 p-0 text-sm transition-colors hover:border-white/[0.14]">
                  <div className="aspect-[4/3] w-full overflow-hidden border-b border-white/[0.08] bg-ink-800">
                    <img
                      alt=""
                      className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
                      data-testid="character-cover-preview"
                      src={editorCoverSrc}
                    />
                  </div>
                  <div className="min-w-0 w-full p-4">
                    <p className="mb-1 truncate text-sm font-semibold text-slate-100">
                      {form.name || t("common.name")}
                    </p>
                    <p className="line-clamp-2 text-xs leading-5 text-slate-400">
                      {form.description || t("common.noDescription")}
                    </p>
                    {form.tags.length > 0 ? (
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {form.tags.slice(0, 6).map((tag) => (
                          <span
                            key={tag}
                            className="max-w-full truncate rounded-md border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] text-slate-300"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {selectedCharacter ? (
                      <div className="mt-3 space-y-1 border-t border-white/5 pt-3 text-[11px] leading-4 text-slate-500">
                        <div className="flex items-center gap-1.5">
                          <CalendarDays size={12} />
                          <span>{t("characters.createdAt")}:</span>
                          <span>{formatCharacterDate(selectedCharacter.createdAt, language)}</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <CalendarDays size={12} />
                          <span>{t("characters.updatedAt")}:</span>
                          <span>{formatCharacterDate(selectedCharacter.updatedAt, language)}</span>
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div> : null}

              {editorMode === "advanced" ? <div className="flex overflow-x-auto border-b border-white/[0.08]">
                {[...editorSections, { id: "review" as const, label: language === "zh-CN" ? "检查" : "Review" }, { id: "assistant" as const, label: language === "zh-CN" ? "创作助手" : "Draft assistant" }].map((section) => (
                  <button
                    key={section.id}
                    type="button"
                    data-testid={`character-editor-section-${section.id}`}
                    className={`min-h-[44px] flex-1 whitespace-nowrap border-b-2 px-2 text-xs font-medium transition-colors sm:px-4 sm:text-sm ${
                      activeEditorSection === section.id
                        ? "border-ember-400 text-ember-100"
                        : "border-transparent text-slate-400 hover:bg-white/[0.035] hover:text-slate-200"
                    }`}
                    onClick={() => setActiveEditorSection(section.id)}
                  >
                    {section.label}
                  </button>
                ))}
              </div> : null}

              {(editorMode === "advanced" && activeEditorSection === "prompt") || (editorMode === "basic" && (!isCreating || wizardStep === 1)) ? (
                isLockedPrivateCharacter ? (
                  <EmptyState>{privatePasswordCopy.lockedHelp}</EmptyState>
                ) : (
                  <div className="space-y-7" data-character-field="prompt">
                    {editorMode === "basic" ? <div className="rounded-lg border border-sky-400/15 bg-sky-500/[0.07] p-4 text-sm leading-6 text-sky-100">
                      <p className="font-semibold">{language === "zh-CN" ? "核心角色设定" : "Core character prompt"}</p>
                      <p className="mt-1">{language === "zh-CN" ? "这是模型理解角色的主要设定。不需要编写技术性系统提示包装；你填写的内容会发送给当前模型供应商。" : "This is the main description the model uses to understand the character. No technical system-prompt wrapper is needed. What you write is sent to the current model provider."}</p>
                      <p className="mt-2 text-xs text-sky-200/75">{language === "zh-CN" ? "可思考：角色是谁？如何表达情绪？面对冲突如何行动？哪些事实必须一致？哪些行为不符合角色？" : "Consider: Who are they? How do they express emotion? How do they handle conflict? Which facts must remain consistent? What would be out of character?"}</p>
                    </div> : null}
                    {editorMode === "advanced" ? <Field
                      container="div"
                      label={
                        <HelpLabel
                          label={t("characters.prefix")}
                          description={t("help.characterPrefix")}
                          descriptionId="character-prefix-help"
                        />
                      }
                    >
                      <MarkdownEditor
                        ariaDescribedBy="character-prefix-help"
                        value={form.prefix}
                        onChange={(nextValue) => setForm({ ...form, prefix: nextValue })}
                        height={180}
                      />
                    </Field> : null}
                    <Field
                      container="div"
                      label={
                        <HelpLabel
                          label={t("characters.prompt")}
                          description={t("help.characterPrompt")}
                          descriptionId="character-prompt-help"
                        />
                      }
                    >
                      <MarkdownEditor
                        ariaDescribedBy="character-prompt-help"
                        value={form.prompt}
                        onChange={(nextValue) => setForm({ ...form, prompt: nextValue })}
                        height={320}
                      />
                    </Field>
                    {editorMode === "advanced" ? <Field
                      container="div"
                      label={
                        <HelpLabel
                          label={t("characters.suffix")}
                          description={t("help.characterSuffix")}
                          descriptionId="character-suffix-help"
                        />
                      }
                    >
                      <MarkdownEditor
                        ariaDescribedBy="character-suffix-help"
                        value={form.suffix}
                        onChange={(nextValue) => setForm({ ...form, suffix: nextValue })}
                        height={220}
                      />
                    </Field> : null}
                  </div>
                )
              ) : null}

              {editorMode === "advanced" && activeEditorSection === "tags" ? (
                <div className="space-y-4">
                  <div className="rounded-lg border border-white/[0.08] bg-ink-950/30 p-4">
                    <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-100">
                      <Tag size={15} />
                      {t("characters.tags")}
                    </div>
                    <div className="flex flex-col gap-3 sm:flex-row">
                      <TextInput
                        value={tagInput}
                        placeholder={t("characters.tagInputPlaceholder")}
                        onChange={(event) => setTagInput(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            addTagsToForm(tagInput);
                          }
                        }}
                      />
                      <Button
                        className="!min-h-[40px] whitespace-nowrap"
                        disabled={!tagInput.trim()}
                        variant="secondary"
                        onClick={() => addTagsToForm(tagInput)}
                      >
                        <Plus size={14} />
                        {t("characters.tagAdd")}
                      </Button>
                    </div>
                    {form.tags.length === 0 ? (
                      <p className="mt-4 text-sm text-slate-500">{t("characters.tagsEmpty")}</p>
                    ) : (
                      <div className="mt-4 flex flex-wrap gap-2">
                        {form.tags.map((tag) => (
                          <span
                            key={tag}
                            className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-ember-500/20 bg-ember-500/10 px-2.5 py-1 text-xs font-medium text-ember-100"
                          >
                            <span className="truncate">{tag}</span>
                            <button
                              className="rounded p-0.5 text-ember-100/70 transition-colors hover:bg-ember-500/20 hover:text-ember-50"
                              type="button"
                              onClick={() => removeTagFromForm(tag)}
                            >
                              <X size={12} />
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ) : null}

              {editorMode === "advanced" && activeEditorSection === "html" ? (
                isLockedPrivateCharacter ? (
                  <EmptyState>{privatePasswordCopy.lockedHelp}</EmptyState>
                ) : (
                  <div className="space-y-5" data-character-field="htmlCss">
                    <Field
                      container="div"
                      label={
                        <div className="flex min-w-0 items-center justify-between gap-3">
                          <HelpLabel
                            label={t("characters.htmlCss")}
                            description={t("help.characterHtmlCss")}
                            descriptionId="character-html-css-help"
                          />
                          <Button
                            aria-label={`${t("characters.expandEditor")} ${t("characters.htmlCss")}`}
                            className="!h-8 !min-h-[32px] shrink-0 !px-2.5 text-xs"
                            data-testid="expand-html-css-editor"
                            title={`${t("characters.expandEditor")} ${t("characters.htmlCss")}`}
                            variant="ghost"
                            onClick={() => setExpandedTextField("htmlCss")}
                          >
                            <Maximize2 size={14} />
                            {t("characters.expandEditor")}
                          </Button>
                        </div>
                      }
                    >
                      <TextArea
                        aria-describedby="character-html-css-help"
                        aria-label={t("characters.htmlCss")}
                        value={form.htmlCss}
                        onChange={(event) => setForm({ ...form, htmlCss: event.target.value })}
                        className="!h-[170px] min-h-[170px] font-mono text-xs leading-6"
                      />
                    </Field>

                    <div className="rounded-lg border border-white/[0.08] bg-ink-950/30 p-4">
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
                          <div className="custom-scrollbar flex min-h-[180px] items-start justify-end gap-3 overflow-y-auto rounded-lg border border-white/[0.08] bg-ink-950/60 p-4">
                            <article className="order-1 relative self-start max-w-[calc(100%-3.25rem)] overflow-hidden rounded-lg rounded-br-sm border border-white/[0.08] bg-ink-800 p-3 text-sm text-slate-100 sm:p-4">
                              <ScopedHtmlRenderer content={previewMarkup} htmlCss={form.htmlCss} />
                            </article>
                            <div
                              className="order-2 grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-md border border-ember-300/30 bg-ink-950/20 text-xs font-bold text-accentForeground"
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

              {(editorMode === "advanced" && activeEditorSection === "opening") || (editorMode === "basic" && (!isCreating || wizardStep === 2)) ? (
                isLockedPrivateCharacter ? (
                  <EmptyState>{privatePasswordCopy.lockedHelp}</EmptyState>
                ) : (
                  <div className="space-y-5" data-character-field="openingHtml">
                    <Field
                      container="div"
                      label={
                        <div className="flex min-w-0 items-center justify-between gap-3">
                          <HelpLabel
                            label={t("characters.openingHtml")}
                            description={t("help.characterOpeningHtml")}
                            descriptionId="character-opening-html-help"
                          />
                          <Button
                            aria-label={`${t("characters.expandEditor")} ${t("characters.openingHtml")}`}
                            className="!h-8 !min-h-[32px] shrink-0 !px-2.5 text-xs"
                            data-testid="expand-opening-html-editor"
                            title={`${t("characters.expandEditor")} ${t("characters.openingHtml")}`}
                            variant="ghost"
                            onClick={() => setExpandedTextField("openingHtml")}
                          >
                            <Maximize2 size={14} />
                            {t("characters.expandEditor")}
                          </Button>
                        </div>
                      }
                    >
                      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                        <TextArea
                          aria-describedby="character-opening-html-help"
                          aria-label={t("characters.openingHtml")}
                          value={form.openingHtml}
                          onChange={(event) =>
                            setForm({ ...form, openingHtml: event.target.value })
                          }
                          className="!h-[300px] min-h-[300px] font-mono text-xs leading-6"
                          placeholder={t("characters.openingHtmlPlaceholder")}
                        />
                        {form.openingHtml.trim() ? (
                          <div className="h-[300px] overflow-y-auto rounded-lg border border-white/10 bg-ink-950 p-4" data-testid="opening-html-preview">
                            <ScopedHtmlRenderer content={form.openingHtml} />
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

              {editorMode === "advanced" && activeEditorSection === "lore" ? (
                isLockedPrivateCharacter ? (
                  <EmptyState>{privatePasswordCopy.lockedHelp}</EmptyState>
                ) : (
                  <div className="border-t border-white/5 pt-5" data-character-field="loreEntries">
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
                      <div className="rounded-lg border border-dashed border-white/10 px-4 py-6 text-center">
                        <p className="text-sm text-slate-400">{t("characters.loreEntryEmpty")}</p>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {form.loreEntries.map((entry, index) => (
                          <div
                            className={`rounded-lg border transition-colors ${
                              entry.enabled
                                ? "border-white/10 bg-ink-950/40"
                                : "border-white/5 bg-ink-950/20 opacity-60"
                            }`}
                            data-character-field="loreEntries"
                            data-character-item-index={index}
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
                                    <div data-character-focus="lore-keys"><Field label={t("characters.loreEntryKeys")}>
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
                                    </Field></div>
                                    <div data-character-focus="lore-content"><Field container="div" label={t("characters.loreEntryContent")}>
                                      <MarkdownEditor
                                        height={180}
                                        value={entry.content}
                                        onChange={(nextValue) => {
                                          const next = [...form.loreEntries];
                                          next[index] = { ...entry, content: nextValue };
                                          setForm({ ...form, loreEntries: next });
                                        }}
                                      />
                                    </Field></div>
                                  </div>
                                  <div className="space-y-3">
                                    <Field
                                      label={
                                        <HelpLabel
                                          label={t("common.priority")}
                                          description={t("characters.loreEntryPriorityHelp")}
                                          descriptionId={`character-lore-priority-help-${index}`}
                                        />
                                      }
                                    >
                                      <TextInput
                                        aria-describedby={`character-lore-priority-help-${index}`}
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
                                    <div data-character-focus="lore-trigger"><Field label={t("characters.loreEntryTriggerMode")}>
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
                                    </Field></div>
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

              {((editorMode === "advanced" && activeEditorSection === "quickReplies") || (editorMode === "basic" && (!isCreating || wizardStep === 2))) ? (
                <div className="space-y-4" data-character-field="quickReplies">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold text-slate-200">
                      {t("characters.quickReplies")}
                    </p>
                  </div>
                  {form.quickReplies.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-white/10 px-4 py-6 text-center">
                      <p className="text-sm text-slate-400">{t("characters.quickRepliesEmpty")}</p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {form.quickReplies.map((qr, index) => (
                        <div
                          className="rounded-lg border border-white/10 bg-ink-950/40 transition-colors"
                          data-character-field="quickReplies"
                          data-character-item-index={index}
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
                              <div data-character-focus="quick-reply-label"><Field label={t("characters.quickReplyLabel")}>
                                <TextInput
                                  placeholder={t("characters.quickReplyLabelPlaceholder")}
                                  value={qr.label}
                                  onChange={(event) => {
                                    const next = [...form.quickReplies];
                                    next[index] = { ...qr, label: event.target.value };
                                    setForm({ ...form, quickReplies: next });
                                  }}
                                />
                              </Field></div>
                              <div data-character-focus="quick-reply-content"><Field container="div" label={t("characters.quickReplyContent")}>
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
                              </Field></div>
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

              {(editorMode === "advanced" && activeEditorSection === "review") || (editorMode === "basic" && (!isCreating || wizardStep === 3)) ? (
                <section className="space-y-4" data-testid="character-quality-panel">
                  {editorMode === "basic" && isCreating ? <div className="grid gap-4 rounded-lg border border-white/10 bg-ink-950/35 p-4 sm:grid-cols-[7rem_minmax(0,1fr)]" data-testid="character-review-preview">
                    <img alt="" className="aspect-square w-28 rounded-lg object-cover ring-1 ring-white/10" src={editorCoverSrc} />
                    <div className="min-w-0"><p className="truncate text-base font-semibold text-slate-100">{form.name || (language === "zh-CN" ? "未命名角色" : "Unnamed character")}</p><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-400">{form.description || (language === "zh-CN" ? "暂无简介" : "No description")}</p><div className="mt-3 flex flex-wrap gap-2">{form.tags.map((tag) => <span key={tag} className="rounded border border-white/10 bg-white/5 px-2 py-1 text-xs text-slate-300">{tag}</span>)}</div></div>
                  </div> : null}
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div><h3 className="flex items-center gap-2 text-sm font-semibold text-slate-100"><ListChecks size={16} />{language === "zh-CN" ? "保存前质量检查" : "Pre-save quality check"}</h3><p className="mt-1 text-xs text-slate-500">{language === "zh-CN" ? "完全在本地运行，不读取或上传外部数据。警告不会阻止保存。" : "Runs entirely locally without reading or uploading external data. Warnings do not block saving."}</p></div>
                    <Button data-testid="run-character-quality" variant="secondary" onClick={() => setQualityVisible(true)}>{language === "zh-CN" ? "运行检查" : "Run check"}</Button>
                  </div>
                  {isLockedPrivateCharacter ? <EmptyState>{language === "zh-CN" ? "私密内容未解锁，不会检查或显示受保护字段。" : "Protected fields are not checked or displayed until this private character is unlocked."}</EmptyState> : null}
                  <div className="grid grid-cols-2 gap-2 rounded-lg border border-white/10 bg-ink-950/40 p-3 sm:grid-cols-5" aria-label={language === "zh-CN" ? "Prompt token 估算" : "Estimated prompt tokens"}>
                    {([ ["prefix", quality.budget.prefixTokens], ["prompt", quality.budget.promptTokens], ["suffix", quality.budget.suffixTokens], [language === "zh-CN" ? "始终启用 lore" : "always-on lore", quality.budget.alwaysActiveLoreTokens], [language === "zh-CN" ? "合计" : "total", quality.budget.totalTokens] ] as Array<[string, number]>).map(([label, value]) => <div key={label} className="min-w-0 rounded bg-white/[0.03] p-2"><div className="truncate text-[11px] text-slate-500">{label}</div><div className="mt-1 font-mono text-sm text-slate-200">≈ {value}</div></div>)}
                  </div>
                  <p className="text-xs text-slate-500">{language === "zh-CN" ? "字符近似估算，不调用模型，不展示完整组装 Prompt。聊天生成后可在消息的 Prompt 构成中查看实际分段。" : "Character-based estimate only. It does not call a model or expose the assembled prompt. After generation, inspect the message Prompt breakdown for actual sections."}</p>
                  {qualityVisible ? <div className="space-y-2" role="list">{quality.issues.length ? quality.issues.map((item, index) => <button key={`${item.code}-${index}`} type="button" role="listitem" className="flex min-h-[44px] w-full items-start gap-3 rounded-lg border border-white/10 bg-ink-950/35 p-3 text-left hover:border-white/20" onClick={() => focusQualityIssue(item)}><span className="rounded bg-white/10 px-2 py-0.5 text-[10px] uppercase text-slate-200">{item.severity}</span><span className="min-w-0 text-sm leading-5 text-slate-300"><span className="mr-2 font-mono text-xs text-slate-500">{item.code}</span>{item.message[language === "zh-CN" ? "zh-CN" : "en"]}</span></button>) : <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 text-sm text-emerald-200" role="status">{language === "zh-CN" ? "未发现问题。" : "No issues found."}</div>}</div> : null}
                </section>
              ) : null}

              {editorMode === "advanced" && activeEditorSection === "assistant" ? (
                isLockedPrivateCharacter ? <EmptyState>{language === "zh-CN" ? "先解锁私密角色，才能使用创作助手。" : "Unlock the private character before using the drafting assistant."}</EmptyState> : <section className="space-y-4" data-testid="character-draft-assistant">
                  <div className="rounded-lg border border-violet-400/15 bg-violet-500/[0.07] p-4"><h3 className="flex items-center gap-2 text-sm font-semibold text-violet-100"><Sparkles size={16} />{language === "zh-CN" ? "可选 AI 创作助手" : "Optional AI drafting assistant"}</h3><p className="mt-2 text-xs leading-5 text-violet-100/80">{language === "zh-CN" ? "只返回可审阅草案，不会保存或静默覆盖。请求通过后端 Agent 模型、统一预算、重试和备用链路。" : "Returns reviewable drafts only—never saves or silently overwrites. Requests use the backend Agent model and the unified budget, retry, and fallback lifecycle."}</p></div>
                  <Field label={language === "zh-CN" ? "独立任务" : "Independent task"}><select className="min-h-[44px] w-full rounded-lg border border-white/10 bg-ink-950 px-3 text-sm text-slate-200" value={draftTask} onChange={(event) => setDraftTask(event.target.value as CharacterDraftTask)}>{([ ["generate_core_prompt", "生成核心设定 / Generate core prompt"], ["refine_prompt", "收紧现有 prompt / Refine prompt"], ["consistency_questions", "一致性问题 / Consistency questions"], ["suggest_lore", "提议 lore / Suggest lore"], ["suggest_quick_replies", "提议快捷回复 / Suggest quick replies"], ["find_contradictions", "检查潜在矛盾 / Find contradictions"] ] as const).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
                  <Field label={language === "zh-CN" ? "可选要点" : "Optional points"}><TextArea value={draftBrief} onChange={(event) => setDraftBrief(event.target.value)} placeholder={language === "zh-CN" ? "只填写这次草案需要考虑的要点" : "Only the points needed for this draft"} /></Field>
                  <div className="rounded-lg border border-white/10 p-3 text-xs leading-5 text-slate-400"><strong className="text-slate-200">{language === "zh-CN" ? "将发送的字段类别：" : "Field categories sent: "}</strong>{({ generate_core_prompt: "name, description, points", refine_prompt: "prompt, points", consistency_questions: "name, prompt", suggest_lore: "prompt, existing lore keywords, points", suggest_quick_replies: "prompt, existing quick-reply labels, points", find_contradictions: "prefix, prompt, suffix, lore entries" } as Record<CharacterDraftTask, string>)[draftTask]}<br />{language === "zh-CN" ? "不会发送 API Key、其他角色、聊天正文、persona、用户画像或长期记忆。" : "API keys, other characters, chat text, persona, profile summaries, and long-term memories are never sent."}</div>
                  <div className="flex flex-wrap gap-2"><Button disabled={draftLoading} data-testid="run-character-draft" onClick={() => void requestCharacterDraft()}><Sparkles size={15} />{draftLoading ? (language === "zh-CN" ? "生成中" : "Generating") : (language === "zh-CN" ? "生成草案" : "Generate draft")}</Button>{draftLoading ? <Button variant="ghost" onClick={cancelCharacterDraft}>{language === "zh-CN" ? "取消" : "Cancel"}</Button> : null}</div>
                  {draftResult ? <div className="space-y-3"><p className="text-xs font-medium text-amber-200">{language === "zh-CN" ? "AI 草案：可能不准确，请逐项审阅。" : "AI draft: may be inaccurate; review every item."}</p>{draftResult.items.map((item) => <article key={item.id} className="min-w-0 overflow-hidden rounded-lg border border-white/10 bg-ink-950/40 p-4"><h4 className="text-sm font-semibold text-slate-100">{item.title}</h4><div className="mt-3 grid min-w-0 gap-3 md:grid-cols-2"><div className="min-w-0"><p className="text-[11px] uppercase text-slate-500">{language === "zh-CN" ? "原内容" : "Current"}</p><pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs text-slate-400">{item.field === "prompt" ? form.prompt : item.field === "loreEntries" ? `${form.loreEntries.length} lore entries` : item.field === "quickReplies" ? `${form.quickReplies.length} quick replies` : language === "zh-CN" ? "不修改字段" : "No field change"}</pre></div><div className="min-w-0"><p className="text-[11px] uppercase text-slate-500">{language === "zh-CN" ? "建议内容" : "Suggested"}</p><pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs text-slate-200">{item.suggestion}</pre></div></div>{["prompt", "loreEntries", "quickReplies"].includes(item.field) ? <Button className="mt-3" variant="secondary" onClick={() => applyDraftItems([item.id])}>{language === "zh-CN" ? "应用此项" : "Apply item"}</Button> : null}</article>)}<div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={() => setDraftApplyAllConfirm(true)}>{language === "zh-CN" ? "全部应用" : "Apply all"}</Button><Button variant="ghost" onClick={() => setDraftResult(null)}>{language === "zh-CN" ? "放弃草案" : "Discard"}</Button></div></div> : null}
                </section>
              ) : null}

              {isCreating && editorMode === "basic" && wizardStep === 3 ? (
                <div className="flex flex-wrap justify-end gap-2 rounded-lg border border-white/10 bg-ink-950/30 p-3">
                  <Button disabled={loading || !form.name.trim() || blockingQualityIssues.length > 0} data-testid="character-create-stay" onClick={() => void saveCharacter()}><Save size={15} />{language === "zh-CN" ? "创建并留在编辑" : "Create and stay"}</Button>
                  <Button disabled={loading || !form.name.trim() || blockingQualityIssues.length > 0} data-testid="character-create-chat" onClick={() => void saveCharacter(true)}>{language === "zh-CN" ? "创建并立即聊天" : "Create and start chat"}<ChevronRight size={15} /></Button>
                </div>
              ) : null}

              {justCreatedId && selected?.id === justCreatedId ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-emerald-400/15 bg-emerald-500/[0.06] p-3 text-sm text-emerald-100"><span>{language === "zh-CN" ? "角色已创建。你可以继续编辑或立即开始聊天。" : "Character created. Continue editing or start a chat now."}</span><Button variant="secondary" data-testid="character-start-chat" onClick={() => onPlay(justCreatedId)}>{language === "zh-CN" ? "立即开始聊天" : "Start chat"}</Button></div> : null}

              <div className="flex flex-wrap justify-end gap-3 pt-4 border-t border-white/5">
                <Button
                  disabled={loading || !selected || hasUnsavedChanges}
                  variant="secondary"
                  onClick={() => void duplicateCharacter()}
                >
                  <Copy size={16} />
                  {t("characters.duplicate")}
                </Button>
                <Button
                  disabled={loading || !selected}
                  variant="danger"
                  onClick={() => setDeleteConfirmOpen(true)}
                >
                  <Trash2 size={16} />
                  {t("common.delete")}
                </Button>
                <Button
                  disabled={loading || !form.name.trim() || !hasUnsavedChanges || blockingQualityIssues.length > 0}
                  data-testid="character-save"
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
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[14rem] flex-1">
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
            <label className="relative shrink-0">
              <span className="sr-only">{t("characters.sort")}</span>
              <ArrowUpDown
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                size={14}
              />
              <select
                aria-label={t("characters.sort")}
                className="h-10 min-w-[9.5rem] appearance-none rounded-md border border-white/10 bg-ink-900 py-0 pl-9 pr-8 text-xs text-slate-200 outline-none transition-colors hover:border-white/20 focus:border-ember-500 focus:ring-1 focus:ring-ember-500/50"
                data-testid="characters-sort"
                value={characterSort}
                onChange={(event) => {
                  setCharacterSort(event.target.value as CharacterSortMode);
                  setCharacterPage(1);
                  setSelectedIds(new Set());
                }}
              >
                {characterSortOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <ChevronDown
                className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500"
                size={14}
              />
            </label>
            <Button
              aria-pressed={favoriteOnly}
              className="!min-h-[40px] !px-3 text-xs"
              data-testid="characters-favorites-filter"
              variant={favoriteOnly ? "secondary" : "ghost"}
              onClick={() => {
                setFavoriteOnly((current) => !current);
                setCharacterPage(1);
                setSelectedIds(new Set());
              }}
            >
              <Star size={14} fill={favoriteOnly ? "currentColor" : "none"} />
              {t("characters.favorites")}
            </Button>
            <Button
              data-testid="characters-batch-mode"
              className="!min-h-[40px] !px-3 text-xs"
              variant={batchMode ? "secondary" : "ghost"}
              onClick={() => {
                setBatchMode((current) => !current);
                setSelectedIds(new Set());
              }}
            >
              {batchMode ? <CheckSquare size={14} /> : <Square size={14} />}
              {batchMode ? t("characters.batchExit") : t("characters.batchManage")}
            </Button>
          </div>

          {pagination.availableTags.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500">
                <Tag size={13} />
                {t("characters.tagFilter")}
              </span>
              <button
                className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                  selectedTag
                    ? "border-white/10 bg-white/5 text-slate-300 hover:bg-white/10"
                    : "border-ember-500/25 bg-ember-500/10 text-ember-100"
                }`}
                type="button"
                onClick={() => {
                  setSelectedTag("");
                  setCharacterPage(1);
                }}
              >
                {t("characters.tagFilterAll")}
              </button>
              {pagination.availableTags.map((tag) => (
                <button
                  key={tag}
                  className={`max-w-full rounded-md border px-2.5 py-1 text-xs transition-colors ${
                    selectedTag === tag
                      ? "border-ember-500/25 bg-ember-500/10 text-ember-100"
                      : "border-white/10 bg-white/5 text-slate-300 hover:bg-white/10"
                  }`}
                  type="button"
                  onClick={() => {
                    setSelectedTag(selectedTag === tag ? "" : tag);
                    setCharacterPage(1);
                  }}
                >
                  <span className="inline-block max-w-[10rem] truncate align-bottom">{tag}</span>
                </button>
              ))}
            </div>
          ) : null}

          {batchMode && characters.length > 0 ? (
            <div className="flex flex-col gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-slate-300 sm:flex-row sm:items-center sm:justify-between sm:px-4">
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  checked={selectedIds.size === characters.length && characters.length > 0}
                  type="checkbox"
                  className="rounded border-white/20 bg-ink-950 text-ember-500 focus:ring-ember-500/50"
                  onChange={toggleSelectAll}
                />
                {t("characters.batchSelectPage", {
                  selected: selectedIds.size,
                  total: characters.length
                })}
              </label>
              {selectedIds.size > 0 ? (
                <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                  <Button
                    className="!min-h-[30px] !px-2.5 text-xs"
                    data-testid="characters-batch-add-tags"
                    variant="secondary"
                    onClick={() => openBatchTagDialog("add")}
                  >
                    <Plus size={12} />
                    {t("characters.batchAddTags")}
                  </Button>
                  <Button
                    className="!min-h-[30px] !px-2.5 text-xs"
                    data-testid="characters-batch-remove-tags"
                    variant="secondary"
                    onClick={() => openBatchTagDialog("remove")}
                  >
                    <Minus size={12} />
                    {t("characters.batchRemoveTags")}
                  </Button>
                  <Button
                    className="!min-h-[30px] !px-2.5 text-xs"
                    variant="danger"
                    onClick={() => setBatchDeleteConfirmOpen(true)}
                  >
                    <Trash2 size={12} />
                    {t("characters.batchDeleteSelected", { count: selectedIds.size })}
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}

          <ErrorNotice message={error} />
          <SuccessNotice message={status} />

          {characters.length === 0 &&
          pagination.total === 0 &&
          !searchQuery.trim() &&
          !selectedTag &&
          !favoriteOnly ? (
            <div className="flex items-center justify-center py-16">
              <EmptyState>
                <div className="flex max-w-md flex-col items-center gap-3">
                  <p className="font-medium text-ink-100">{t("characters.noCharacters")}</p>
                  <p className="text-xs leading-5 text-ink-400">{language === "zh-CN" ? "从空白创建原创角色，或导入你拥有的 JSON 角色卡；应用不会自动添加默认内容。" : "Create an original character from scratch or import a JSON character card you own. The app never adds default content automatically."}</p>
                  <div className="flex flex-wrap justify-center gap-2">
                    <Button data-testid="characters-empty-create" onClick={() => requestEditorExit("new")}><Plus size={15} />{t("characters.create")}</Button>
                    <Button variant="secondary" onClick={() => characterImportInputRef.current?.click()}><FileUp size={15} />{t("common.import")}</Button>
                    <Button variant="secondary" onClick={() => {
                      window.history.pushState({}, "", "/docs#quick-start");
                      window.dispatchEvent(new PopStateEvent("popstate"));
                    }}>{language === "zh-CN" ? "查看应用内指南" : "View in-app guide"}</Button>
                  </div>
                </div>
              </EmptyState>
            </div>
          ) : characters.length === 0 ? (
            <div className="flex items-center justify-center py-16">
              <EmptyState>
                <div className="flex max-w-md flex-col items-center gap-3">
                  <p className="font-medium text-ink-100">{t("characters.noSearchResults")}</p>
                  <p className="text-xs text-ink-400">{language === "zh-CN" ? `当前筛选：${searchQuery.trim() || selectedTag || (favoriteOnly ? "仅收藏" : "—")}` : `Current filter: ${searchQuery.trim() || selectedTag || (favoriteOnly ? "favorites only" : "—")}`}</p>
                  <Button variant="secondary" onClick={() => { setSearchQuery(""); setSelectedTag(""); setFavoriteOnly(false); setCharacterPage(1); }}>{language === "zh-CN" ? "清除筛选" : "Clear filters"}</Button>
                </div>
              </EmptyState>
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
                    createdAtLabel={t("characters.createdAt")}
                    updatedAtLabel={t("characters.updatedAt")}
                    locale={language === "zh-CN" ? "zh-CN" : "en"}
                    playLabel={t("characters.play")}
                    editLabel={t("common.edit")}
                    favoriteLabel={t("characters.favorite")}
                    unfavoriteLabel={t("characters.unfavorite")}
                    onPlay={batchMode ? () => {} : onPlay}
                    onEdit={batchMode ? () => {} : selectCharacter}
                    onToggleFavorite={toggleFavorite}
                    favoritePending={favoritePendingId === character.id}
                    selectable={batchMode}
                    selected={selectedIds.has(character.id)}
                    onSelect={toggleSelectCharacter}
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
                  <div className="flex items-center gap-1.5 text-xs text-slate-400">
                    <input
                      type="number"
                      min={1}
                      max={pagination.totalPages}
                      className="h-8 w-14 rounded-md border border-white/10 bg-ink-950/50 px-1.5 text-center text-xs text-slate-200 outline-none transition-all hover:border-white/20 focus:border-ember-500 focus:ring-1 focus:ring-ember-500/50 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                      value={pageInputValue || characterPage}
                      placeholder={String(characterPage)}
                      onChange={(event) => handlePageInputChange(event.target.value)}
                      onKeyDown={handlePageInputKeyDown}
                      onBlur={handlePageInputSubmit}
                    />
                    <span>/ {pagination.totalPages}</span>
                  </div>
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
      {pendingEditorExit ? (
        <ConfirmDialog
          cancelLabel={t("common.cancel")}
          confirmLabel={t("characters.discardChangesConfirm")}
          message={t("characters.discardChangesMessage")}
          title={t("characters.discardChangesTitle")}
          variant="danger"
          onCancel={() => setPendingEditorExit(null)}
          onConfirm={confirmEditorExit}
        />
      ) : null}
      {draftApplyAllConfirm && draftResult ? (
        <ConfirmDialog
          cancelLabel={t("common.cancel")}
          confirmLabel={language === "zh-CN" ? "应用并保留撤销" : "Apply and keep undo"}
          message={language === "zh-CN" ? "将所有可应用 AI 建议写入当前未保存草稿。正式角色仍需你主动保存。" : "Apply every actionable AI suggestion to the current unsaved draft. You must still save the character yourself."}
          title={language === "zh-CN" ? "全部应用 AI 草案？" : "Apply all AI drafts?"}
          onCancel={() => setDraftApplyAllConfirm(false)}
          onConfirm={() => { applyDraftItems(draftResult.items.map((item) => item.id)); setDraftApplyAllConfirm(false); }}
        />
      ) : null}
      {expandedTextField ? (
        <Modal
          bodyClassName="flex min-h-0 flex-col gap-3 overflow-hidden"
          panelClassName="h-[calc(100dvh-1.5rem)] !max-h-[calc(100dvh-1.5rem)] max-w-[min(96vw,1100px)] sm:h-[calc(100dvh-3rem)] sm:!max-h-[calc(100dvh-3rem)]"
          title={`${t("characters.expandEditor")} ${expandedTextFieldTitle}`}
          onClose={() => setExpandedTextField(null)}
        >
          <p className="text-xs leading-5 text-slate-500">{t("characters.expandedEditorHelp")}</p>
          <TextArea
            aria-label={expandedTextFieldTitle}
            className="min-h-0 flex-1 resize-none font-mono text-xs leading-6"
            data-testid="expanded-character-textarea"
            placeholder={
              expandedTextField === "openingHtml"
                ? t("characters.openingHtmlPlaceholder")
                : undefined
            }
            spellCheck={false}
            value={expandedTextFieldValue}
            onChange={(event) => updateExpandedTextField(event.target.value)}
          />
        </Modal>
      ) : null}
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
      {batchDeleteConfirmOpen ? (
        <ConfirmDialog
          cancelLabel={t("common.cancel")}
          confirmLabel={t("common.delete")}
          loading={loading}
          message={
            language === "zh-CN"
              ? `确定删除选中的 ${selectedIds.size} 个角色？此操作不可撤销。`
              : `Delete ${selectedIds.size} selected characters? This cannot be undone.`
          }
          title={language === "zh-CN" ? "批量删除角色" : "Batch Delete Characters"}
          onCancel={() => setBatchDeleteConfirmOpen(false)}
          onConfirm={() => void batchDeleteCharacters()}
        />
      ) : null}
      {batchTagDialogOpen ? (
        <Modal
          panelClassName="max-w-xl"
          title={t("characters.batchTagsTitle")}
          onClose={() => setBatchTagDialogOpen(false)}
        >
          <div className="space-y-5" data-testid="characters-batch-tags-dialog">
            <p className="text-sm leading-6 text-slate-400">
              {t("characters.batchTagsDescription", { count: selectedIds.size })}
            </p>
            <div
              aria-label={t("characters.batchTagsTitle")}
              className="grid grid-cols-2 gap-1 rounded-lg border border-white/10 bg-ink-950/60 p-1"
              role="group"
            >
              <button
                aria-pressed={batchTagOperation === "add"}
                className={`flex min-h-9 items-center justify-center gap-2 rounded-md px-3 text-xs font-medium transition-colors ${
                  batchTagOperation === "add"
                    ? "bg-ember-500 text-white"
                    : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
                }`}
                type="button"
                onClick={() => setBatchTagOperation("add")}
              >
                <Plus size={14} />
                {t("characters.batchAddTags")}
              </button>
              <button
                aria-pressed={batchTagOperation === "remove"}
                className={`flex min-h-9 items-center justify-center gap-2 rounded-md px-3 text-xs font-medium transition-colors ${
                  batchTagOperation === "remove"
                    ? "bg-ember-500 text-white"
                    : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
                }`}
                type="button"
                onClick={() => setBatchTagOperation("remove")}
              >
                <Minus size={14} />
                {t("characters.batchRemoveTags")}
              </button>
            </div>
            <Field label={t("characters.batchTagsSelected")}>
              <div className="flex gap-2">
                <TextInput
                  data-testid="characters-batch-tags-input"
                  placeholder={t("characters.tagInputPlaceholder")}
                  value={batchTagInput}
                  onChange={(event) => setBatchTagInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addBatchTags(batchTagInput);
                    }
                  }}
                />
                <Button
                  className="shrink-0"
                  disabled={!batchTagInput.trim()}
                  variant="secondary"
                  onClick={() => addBatchTags(batchTagInput)}
                >
                  <Plus size={14} />
                  {t("characters.tagAdd")}
                </Button>
              </div>
            </Field>
            {batchTags.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {batchTags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex max-w-full items-center gap-1 rounded-md border border-ember-500/25 bg-ember-500/10 py-1 pl-2.5 pr-1 text-xs text-ember-100"
                  >
                    <span className="max-w-[12rem] truncate">{tag}</span>
                    <button
                      aria-label={t("characters.batchTagRemoveDraft", { tag })}
                      className="grid h-6 w-6 shrink-0 place-items-center rounded text-ember-200/70 hover:bg-white/10 hover:text-white"
                      type="button"
                      onClick={() => toggleBatchTag(tag)}
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-xs text-slate-500">{t("characters.batchTagsEmpty")}</p>
            )}
            {pagination.availableTags.length > 0 ? (
              <div className="space-y-2">
                <p className="text-xs font-medium text-slate-400">
                  {t("characters.batchTagsAvailable")}
                </p>
                <div className="flex max-h-32 flex-wrap gap-2 overflow-y-auto pr-1">
                  {pagination.availableTags.map((tag) => {
                    const selected = batchTags.some(
                      (candidate) => candidate.toLowerCase() === tag.toLowerCase()
                    );
                    return (
                      <button
                        key={tag}
                        aria-pressed={selected}
                        className={`max-w-full rounded-md border px-2.5 py-1 text-xs transition-colors ${
                          selected
                            ? "border-ember-500/30 bg-ember-500/10 text-ember-100"
                            : "border-white/10 text-slate-400 hover:bg-white/5 hover:text-slate-200"
                        }`}
                        type="button"
                        onClick={() => toggleBatchTag(tag)}
                      >
                        <span className="block max-w-[12rem] truncate">{tag}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
            {batchTagError ? (
              <div
                className="flex items-start gap-2 rounded-md border border-rose-500/25 bg-rose-950/20 px-3 py-2.5 text-xs leading-5 text-rose-100"
                role="alert"
              >
                <AlertTriangle className="mt-0.5 shrink-0 text-rose-400" size={15} />
                <span>{batchTagError}</span>
              </div>
            ) : null}
            <div className="flex flex-col-reverse gap-2 border-t border-white/[0.06] pt-4 sm:flex-row sm:justify-end">
              <Button variant="ghost" onClick={() => setBatchTagDialogOpen(false)}>
                {t("common.cancel")}
              </Button>
              <Button
                data-testid="characters-batch-tags-apply"
                disabled={loading || batchTags.length === 0}
                onClick={() => void applyBatchTags()}
              >
                <Tag size={14} />
                {t("characters.batchTagsApply", { count: selectedIds.size })}
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
