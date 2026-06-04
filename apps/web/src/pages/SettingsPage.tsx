import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronDown,
  ChevronRight,
  Copy as CopyIcon,
  Download,
  FileUp,
  History,
  Plus,
  RefreshCw,
  Save,
  ServerCog,
  Trash2,
  Wifi
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { api } from "../lib/api";
import { downloadJson, readFileText } from "../lib/files";
import { generateId } from "../lib/uuid";
import { useAppStore } from "../store/useAppStore";
import type {
  AppLanguage,
  BackupImportSummaryDTO,
  LanSyncDirection,
  LanSyncInfoDTO,
  LanSyncSummaryDTO,
  ProviderModel,
  ProviderProfile,
  PublicUserSettingsDTO,
  SettingsInput
} from "../types";
import {
  Button,
  ConfirmDialog,
  ErrorNotice,
  Field,
  HelpLabel,
  Panel,
  SuccessNotice,
  TextInput
} from "../components/ui";
import type { ReactNode } from "react";

const defaultForm: SettingsInput = {
  activeProvider: "openai-compatible",
  apiBaseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-5.4-mini",
  temperature: 0.8,
  maxTokens: 800,
  topP: 1,
  language: "zh-CN",
  providers: [],
  activeProviderId: "",
  activeModelId: "",
  showMessageAvatars: true,
  userProfileSummary: ""
};

const selectClassName =
  "min-h-[40px] w-full rounded-lg border border-white/10 bg-ink-950/50 px-3 text-sm text-slate-100 outline-none transition-all hover:border-white/20 focus:border-ember-500 focus:bg-ink-950 focus:ring-1 focus:ring-ember-500/50";

const settingsPanelClassName =
  "border-white/5 bg-ink-900/80 shadow-lg shadow-black/20 backdrop-blur-sm";

const settingsSurfaceClassName =
  "border border-white/5 bg-ink-950/30";

const settingsDividerClassName = "border-white/5";
const syncRecordStorageKey = "star-companion:lan-sync-records";

const serializeForm = (form: SettingsInput) => JSON.stringify(form);

const isValidUrl = (value: string) => {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
};

type SyncRecord = {
  id: string;
  direction: LanSyncDirection;
  mode: "merge" | "replace";
  peerBaseUrl: string;
  peerExportedAt: string | null;
  completedAt: string;
  summary: BackupImportSummaryDTO;
};

const isSyncRecord = (value: unknown): value is SyncRecord => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const record = value as Partial<SyncRecord>;
  return (
    typeof record.id === "string" &&
    (record.direction === "pull" || record.direction === "push") &&
    (record.mode === "merge" || record.mode === "replace") &&
    typeof record.peerBaseUrl === "string" &&
    typeof record.completedAt === "string" &&
    Boolean(record.summary)
  );
};

const readSyncRecords = (): SyncRecord[] => {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const parsed = JSON.parse(window.localStorage.getItem(syncRecordStorageKey) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter(isSyncRecord).slice(0, 8) : [];
  } catch {
    return [];
  }
};

const toSyncRecord = (result: LanSyncSummaryDTO): SyncRecord => ({
  id: generateId(),
  direction: result.direction,
  mode: result.mode,
  peerBaseUrl: result.peerBaseUrl,
  peerExportedAt: result.peerExportedAt,
  completedAt: result.completedAt,
  summary: result.summary
});

const describeSummaryCounts = (summary: BackupImportSummaryDTO) =>
  `${summary.characters} / ${summary.chats} / ${summary.messages} / ${summary.memories}`;

const copyTextWithFallback = async (value: string) => {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
};

const providerTemplates = [
  {
    id: "openai",
    label: "OpenAI",
    provider: "openai",
    apiBaseUrl: "https://api.openai.com/v1",
    defaultModels: [
      { label: "GPT-5.5", model: "gpt-5.5" },
      { label: "GPT-5.4 Mini", model: "gpt-5.4-mini" },
      { label: "GPT-5.4 Nano", model: "gpt-5.4-nano" }
    ]
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    provider: "anthropic",
    apiBaseUrl: "https://api.anthropic.com/v1",
    defaultModels: [
      { label: "Claude Opus 4.8", model: "claude-opus-4-8" },
      { label: "Claude Sonnet 4.6", model: "claude-sonnet-4-6" },
      { label: "Claude Haiku 4.5", model: "claude-haiku-4-5" }
    ]
  },
  {
    id: "google-gemini",
    label: "Google Gemini",
    provider: "google-gemini",
    apiBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaultModels: [
      { label: "Gemini 3 Pro Preview", model: "gemini-3-pro-preview" },
      { label: "Gemini 3 Flash Preview", model: "gemini-3-flash-preview" },
      { label: "Gemini 2.5 Flash", model: "gemini-2.5-flash" }
    ]
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    provider: "deepseek",
    apiBaseUrl: "https://api.deepseek.com",
    defaultModels: [
      { label: "DeepSeek V4 Pro", model: "deepseek-v4-pro" },
      { label: "DeepSeek V4 Flash", model: "deepseek-v4-flash" }
    ]
  },
  {
    id: "qwen",
    label: "通义千问 / Qwen",
    provider: "qwen",
    apiBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModels: [
      { label: "Qwen3.7 Max", model: "qwen3.7-max" },
      { label: "Qwen3.7 Plus", model: "qwen3.7-plus" },
      { label: "Qwen3.6 Flash", model: "qwen3.6-flash" }
    ]
  },
  {
    id: "moonshot",
    label: "Moonshot Kimi",
    provider: "moonshot",
    apiBaseUrl: "https://api.moonshot.ai/v1",
    defaultModels: [
      { label: "Kimi K2.6", model: "kimi-k2.6" },
      { label: "Moonshot v1 128K", model: "moonshot-v1-128k" }
    ]
  },
  {
    id: "zhipu",
    label: "智谱 GLM",
    provider: "zhipu",
    apiBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModels: [
      { label: "GLM-5.1", model: "glm-5.1" },
      { label: "GLM-4.6", model: "glm-4.6" }
    ]
  },
  {
    id: "xiaomi-mimo",
    label: "Xiaomi MIMO",
    provider: "xiaomi-mimo",
    apiBaseUrl: "https://api.xiaomimimo.com/v1",
    defaultModels: [
      { label: "MIMO v2.5 Pro", model: "mimo-v2.5-pro" }
    ]
  },
  {
    id: "groq",
    label: "Groq",
    provider: "groq",
    apiBaseUrl: "https://api.groq.com/openai/v1",
    defaultModels: [
      { label: "GPT OSS 120B", model: "openai/gpt-oss-120b" },
      { label: "Llama 3.3 70B", model: "llama-3.3-70b-versatile" }
    ]
  },
  {
    id: "ollama",
    label: "Ollama",
    provider: "ollama",
    apiBaseUrl: "http://localhost:11434/v1",
    defaultModels: [
      { label: "Llama 3.1", model: "llama3.1" }
    ]
  },
  {
    id: "lm-studio",
    label: "LM Studio",
    provider: "lm-studio",
    apiBaseUrl: "http://localhost:1234/v1",
    defaultModels: [
      { label: "Local Model", model: "local-model" }
    ]
  }
] as const;

const getProviderDisplayName = (provider: ProviderProfile, language: AppLanguage) => {
  const label = provider.label.trim();
  if (label) {
    return label;
  }

  return language === "zh-CN" ? "未命名供应商" : "Unnamed provider";
};

const getPageCopy = (language: AppLanguage) =>
  language === "zh-CN"
    ? {
        runtimeTitle: "当前运行配置",
        runtimeHelp: "这里展示当前聊天实际使用的供应商与模型，采样参数可在此调整。",
        providerStatus: "当前供应商",
        modelStatus: "当前模型",
        apiKeyStatus: "API Key",
        changesStatus: "更改状态",
        providerCount: "供应商数量",
        keyStored: "已保存",
        keyPendingRemoval: "待清除",
        keyMissing: "未保存",
        changesDirty: "未保存更改",
        changesClean: "已同步",
        providerCountDisplay: (count: number) => `${count} 个`,
        proxyNote: "所有模型请求都通过后端代理发出，前端不会直连模型供应商。",
        samplingBlockTitle: "采样参数",
        providersTitle: "供应商管理",
        providersHelp: "配置供应商连接信息和模型列表。选择一个模型即可切换当前聊天使用的模型。",
        addProvider: "添加供应商",
        providerLabel: "供应商名称",
        providerType: "供应商类型",
        providerUrl: "API Base URL",
        providerKey: "专用 API Key（可选）",
        providerModels: "模型列表",
        providerEmpty: "还没有供应商。点击上方按钮添加一个。",
        providerDeleteTitle: "删除供应商",
        providerDeleteConfirm: (name: string) => `删除供应商"${name}"？`,
        modelLabel: "模型名称",
        modelId: "模型 ID",
        addModel: "添加模型",
        importFromProvider: "从供应商导入",
        activeModel: "当前使用",
        urlInvalid: "请输入有效的 URL 地址",
        validationProvider:
          "请先补全每个供应商的名称、类型、API Base URL 和至少一个模型，且 API Base URL 必须是有效地址。",
        backupTitle: "备份与迁移",
        backupHelp:
          "完整备份会导出角色、聊天、消息和记忆；设置仅导出模型参数，不包含 API Key。",
        syncTitle: "局域网同步",
        syncHelp:
          "填写同一局域网中另一台设备的后端地址，手动选择拉取或推送数据。同步复用完整备份，不包含 API Key。",
        localBackendTitle: "本机后端地址",
        localBackendHelp:
          "把局域网地址复制到另一台设备的对端地址中。回环地址只适用于当前设备自己。",
        localBackendLoading: "正在读取本机地址...",
        localBackendUnavailable: "暂时没有可展示的局域网地址，请确认设备已连接 Wi-Fi 或局域网。",
        localBackendLocalOnly: "仅本机",
        localBackendLanReachable: "局域网可用",
        localBackendRefresh: "刷新地址",
        copyAddress: "复制地址",
        addressCopied: "地址已复制。",
        syncPeerUrl: "对端地址",
        syncPeerPlaceholder: "例如：http://192.168.1.23:4000",
        syncMode: "同步模式",
        syncPull: "从对端拉取",
        syncPush: "推送到对端",
        syncRecords: "同步记录",
        syncRecordLegend: "角色 / 聊天 / 消息 / 记忆",
        syncNoRecords: "还没有同步记录。",
        syncPeerUrlRequired: "请输入同一局域网中的对端后端地址。",
        syncFailed: "同步失败",
        syncPullConfirm:
          "将从对端读取完整备份并写入本机数据库。替换模式会清空本机角色、聊天、消息和记忆。确定继续吗？",
        syncPushConfirm:
          "将把本机完整备份写入对端数据库。替换模式会清空对端角色、聊天、消息和记忆。确定继续吗？",
        syncPulled: (summary: BackupImportSummaryDTO) =>
          `拉取完成：${describeSummaryCounts(summary)}`,
        syncPushed: (summary: BackupImportSummaryDTO) =>
          `推送完成：${describeSummaryCounts(summary)}`,
        syncDirection: (direction: LanSyncDirection) =>
          direction === "pull" ? "拉取" : "推送",
        syncModeLabel: (mode: "merge" | "replace") =>
          mode === "merge" ? "合并" : "替换",
        saveReady: "保存到本地",
        noPendingChanges: "当前没有待保存更改"
      }
    : {
        runtimeTitle: "Active Runtime",
        runtimeHelp: "These values show the active provider and model used by chat. Sampling parameters can be adjusted here.",
        providerStatus: "Provider",
        modelStatus: "Model",
        apiKeyStatus: "API Key",
        changesStatus: "Change State",
        providerCount: "Provider Count",
        keyStored: "Stored",
        keyPendingRemoval: "Pending removal",
        keyMissing: "Not stored",
        changesDirty: "Unsaved changes",
        changesClean: "Synced",
        providerCountDisplay: (count: number) => `${count}`,
        proxyNote: "All model requests go through the backend proxy. The frontend never calls providers directly.",
        samplingBlockTitle: "Sampling",
        providersTitle: "Provider Management",
        providersHelp: "Configure provider connection info and model lists. Select a model to switch the active model used by chat.",
        addProvider: "Add Provider",
        providerLabel: "Provider Name",
        providerType: "Provider Type",
        providerUrl: "API Base URL",
        providerKey: "Dedicated API Key (optional)",
        providerModels: "Models",
        providerEmpty: "No providers yet. Click the button above to add one.",
        providerDeleteTitle: "Delete Provider",
        providerDeleteConfirm: (name: string) => `Delete provider "${name}"?`,
        modelLabel: "Model Name",
        modelId: "Model ID",
        addModel: "Add Model",
        importFromProvider: "Import from Provider",
        activeModel: "Active",
        urlInvalid: "Please enter a valid URL",
        validationProvider:
          "Complete every provider name, type, API base URL, and add at least one model before saving. API base URLs must be valid URLs.",
        backupTitle: "Backup & Migration",
        backupHelp:
          "Full backups export characters, chats, and messages. Settings export model parameters but never the API key.",
        syncTitle: "LAN Sync",
        syncHelp:
          "Enter another device backend address on the same LAN, then pull from it or push local data to it. Sync uses full backups and never includes the API key.",
        localBackendTitle: "This Device Backend",
        localBackendHelp:
          "Copy a LAN address into the peer address field on another device. Loopback only works on this device.",
        localBackendLoading: "Reading local addresses...",
        localBackendUnavailable: "No LAN address is available yet. Check that this device is on Wi-Fi or LAN.",
        localBackendLocalOnly: "Local only",
        localBackendLanReachable: "LAN reachable",
        localBackendRefresh: "Refresh addresses",
        copyAddress: "Copy address",
        addressCopied: "Address copied.",
        syncPeerUrl: "Peer Address",
        syncPeerPlaceholder: "Example: http://192.168.1.23:4000",
        syncMode: "Sync Mode",
        syncPull: "Pull from Peer",
        syncPush: "Push to Peer",
        syncRecords: "Sync Records",
        syncRecordLegend: "characters / chats / messages / memories",
        syncNoRecords: "No sync records yet.",
        syncPeerUrlRequired: "Enter a peer backend address on the same LAN.",
        syncFailed: "Sync failed",
        syncPullConfirm:
          "This will read a full backup from the peer and write it into this device. Replace mode clears local characters, chats, messages, and memories. Continue?",
        syncPushConfirm:
          "This will write this device's full backup into the peer. Replace mode clears peer characters, chats, messages, and memories. Continue?",
        syncPulled: (summary: BackupImportSummaryDTO) =>
          `Pull complete: ${describeSummaryCounts(summary)}`,
        syncPushed: (summary: BackupImportSummaryDTO) =>
          `Push complete: ${describeSummaryCounts(summary)}`,
        syncDirection: (direction: LanSyncDirection) =>
          direction === "pull" ? "Pull" : "Push",
        syncModeLabel: (mode: "merge" | "replace") =>
          mode === "merge" ? "Merge" : "Replace",
        saveReady: "Save locally",
        noPendingChanges: "No pending changes"
      };

type SettingsSection = "runtime" | "providers" | "backup";

function SummaryCard({
  label,
  value,
  tone = "default"
}: {
  label: string;
  value: string;
  tone?: "default" | "ember" | "emerald";
}) {
  const toneClassName = {
    default:
      settingsSurfaceClassName,
    ember:
      "border border-white/5 bg-ember-500/[0.04]",
    emerald:
      "border border-white/5 bg-emerald-500/[0.04]"
  }[tone];

  return (
    <div className={`rounded-xl px-4 py-3 ${toneClassName}`}>
      <div className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">{label}</div>
      <div className="mt-2 min-w-0 break-words text-sm font-semibold leading-6 text-slate-100">
        {value}
      </div>
    </div>
  );
}

function SettingsSectionHeading({
  title,
  description
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="space-y-1">
      <h4 className="text-sm font-semibold text-slate-100">{title}</h4>
      <p className="text-sm leading-6 text-slate-400">{description}</p>
    </div>
  );
}

function SettingsBadge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-xs font-medium text-slate-300">
      {children}
    </span>
  );
}

export function SettingsPage({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void } = {}) {
  const { language, t } = useI18n();
  const copy = useMemo(() => getPageCopy(language), [language]);
  const setLanguage = useAppStore((state) => state.setLanguage);
  const setShowMessageAvatars = useAppStore((state) => state.setShowMessageAvatars);

  const [form, setForm] = useState<SettingsInput>(defaultForm);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [clearStoredApiKey, setClearStoredApiKey] = useState(false);
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [importMode, setImportMode] = useState<"merge" | "replace">("merge");
  const [syncMode, setSyncMode] = useState<"merge" | "replace">("merge");
  const [syncPeerUrl, setSyncPeerUrl] = useState("");
  const [syncInfo, setSyncInfo] = useState<LanSyncInfoDTO | null>(null);
  const [syncInfoLoading, setSyncInfoLoading] = useState(false);
  const [syncRecords, setSyncRecords] = useState<SyncRecord[]>([]);
  const [pendingSyncDirection, setPendingSyncDirection] = useState<LanSyncDirection | null>(null);
  const [pendingImportFile, setPendingImportFile] = useState<File | null>(null);
  const [expandedProviderId, setExpandedProviderId] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<SettingsSection>("runtime");
  const [pendingDeleteProviderId, setPendingDeleteProviderId] = useState<string | null>(null);
  const [pendingDeleteModel, setPendingDeleteModel] = useState<{
    providerId: string;
    modelId: string;
  } | null>(null);
  const [addProviderDropdownOpen, setAddProviderDropdownOpen] = useState(false);
  const [selectedModelIds, setSelectedModelIds] = useState<Set<string>>(new Set());
  const [pendingBatchDelete, setPendingBatchDelete] = useState<string | null>(null);
  const [manageMode, setManageMode] = useState(false);
  const addProviderButtonRef = useRef<HTMLDivElement>(null);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number } | null>(null);

  const applyLoadedSettings = useCallback(
    (settings: PublicUserSettingsDTO) => {
      const nextForm: SettingsInput = {
        activeProvider: settings.activeProvider,
        apiBaseUrl: settings.apiBaseUrl,
        apiKey: "",
        model: settings.model,
        temperature: settings.temperature,
        maxTokens: settings.maxTokens,
        topP: settings.topP,
        language: settings.language,
        providers: settings.providers ?? [],
        activeProviderId: settings.activeProviderId ?? "",
        activeModelId: settings.activeModelId ?? "",
        showMessageAvatars: settings.showMessageAvatars,
        userProfileSummary: settings.userProfileSummary ?? ""
      };
      setForm(nextForm);
      setSavedSnapshot(serializeForm(nextForm));
      setLanguage(settings.language);
      setShowMessageAvatars(settings.showMessageAvatars);
      setHasApiKey(settings.hasApiKey);
      setClearStoredApiKey(false);
    },
    [setLanguage, setShowMessageAvatars]
  );

  useEffect(() => {
    void api.settings
      .get()
      .then(applyLoadedSettings)
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : "Failed to load settings")
      );
  }, [applyLoadedSettings]);

  useEffect(() => {
    setSyncRecords(readSyncRecords());
  }, []);

  const loadSyncInfo = useCallback(async () => {
    setSyncInfoLoading(true);

    try {
      setSyncInfo(await api.sync.info());
    } catch {
      setSyncInfo(null);
    } finally {
      setSyncInfoLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSyncInfo();
  }, [loadSyncInfo]);

  useEffect(() => {
    if (!status) {
      return;
    }

    const timeoutId = window.setTimeout(() => setStatus(null), 2200);
    return () => window.clearTimeout(timeoutId);
  }, [status]);

  const hasUnsavedChanges =
    savedSnapshot !== null &&
    (serializeForm(form) !== savedSnapshot || clearStoredApiKey);

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (hasUnsavedChanges) {
        event.preventDefault();
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [hasUnsavedChanges]);

  useEffect(() => {
    onDirtyChange?.(hasUnsavedChanges);
  }, [hasUnsavedChanges, onDirtyChange]);

  const activeProviderName = useMemo(() => {
    const provider = form.providers.find((p) => p.id === form.activeProviderId);
    return provider ? getProviderDisplayName(provider, language) : "";
  }, [form.providers, form.activeProviderId, language]);

  const activeModelName = useMemo(() => {
    if (!form.activeProviderId || !form.activeModelId) {
      return "";
    }
    const provider = form.providers.find((p) => p.id === form.activeProviderId);
    if (!provider) {
      return "";
    }
    const model = provider.models.find((m) => m.id === form.activeModelId);
    return model ? (model.label || model.model) : "";
  }, [form.providers, form.activeProviderId, form.activeModelId]);

  const syncAddressRows = useMemo(
    () =>
      syncInfo
        ? [
            {
              url: syncInfo.localUrl,
              label: copy.localBackendLocalOnly,
              tone: "default"
            },
            ...syncInfo.lanUrls.map((url) => ({
              url,
              label: copy.localBackendLanReachable,
              tone: "lan"
            }))
          ]
        : [],
    [copy.localBackendLanReachable, copy.localBackendLocalOnly, syncInfo]
  );

  useEffect(() => {
    setExpandedProviderId((current) => {
      if (current && form.providers.some((p) => p.id === current)) {
        return current;
      }
      return null;
    });
  }, [form.providers]);

  useEffect(() => {
    setSelectedModelIds(new Set());
    setManageMode(false);
  }, [expandedProviderId]);

  const saveSettings = async () => {
    const hasInvalidProvider = form.providers.some(
      (provider) =>
        !provider.label.trim() ||
        !provider.provider.trim() ||
        !isValidUrl(provider.apiBaseUrl) ||
        provider.models.length === 0
    );

    if (hasInvalidProvider) {
      setError(copy.validationProvider);
      return;
    }

    setLoading(true);
    setError(null);
    setStatus(null);

    const payload: SettingsInput = {
      ...form,
      apiKey: clearStoredApiKey ? "" : form.apiKey?.trim() ? form.apiKey : undefined
    };

    try {
      const settings = await api.settings.update(payload);
      const nextForm: SettingsInput = {
        activeProvider: settings.activeProvider,
        apiBaseUrl: settings.apiBaseUrl,
        apiKey: "",
        model: settings.model,
        temperature: settings.temperature,
        maxTokens: settings.maxTokens,
        topP: settings.topP,
        language: settings.language,
        providers: settings.providers ?? [],
        activeProviderId: settings.activeProviderId ?? "",
        activeModelId: settings.activeModelId ?? "",
        autoSummarizeUser: settings.autoSummarizeUser,
        showMessageAvatars: settings.showMessageAvatars,
        userProfileSummary: settings.userProfileSummary ?? ""
      };

      setForm(nextForm);
      setSavedSnapshot(serializeForm(nextForm));
      setHasApiKey(settings.hasApiKey);
      setClearStoredApiKey(false);
      setLanguage(settings.language);
      setShowMessageAvatars(settings.showMessageAvatars);
      setStatus(t("settings.saved"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("settings.failedSave"));
    } finally {
      setLoading(false);
    }
  };

  const testBackend = async () => {
    setLoading(true);
    setError(null);
    setStatus(null);

    try {
      const result = await api.settings.test();
      setStatus(t("settings.modelReachable", { model: result.model }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("settings.connectionFailed"));
    } finally {
      setLoading(false);
    }
  };

  const exportBackup = async () => {
    setLoading(true);
    setError(null);
    setStatus(null);

    try {
      const backup = await api.backups.export();
      const stamp = new Date().toISOString().slice(0, 19).replaceAll(":", "-");
      downloadJson(`local-roleplay-backup-${stamp}.json`, backup);
      setStatus(t("settings.backupExported"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("settings.failedExportBackup"));
    } finally {
      setLoading(false);
    }
  };

  const importBackup = async (file: File | undefined) => {
    if (!file) {
      return;
    }

    setLoading(true);
    setError(null);
    setStatus(null);

    try {
      const raw = await readFileText(file);
      const parsed = JSON.parse(raw) as unknown;
      const summary = await api.backups.import(parsed, importMode);
      setPendingImportFile(null);
      setStatus(
        t("settings.backupImported", {
          characters: summary.characters,
          chats: summary.chats,
          messages: summary.messages
        })
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("settings.failedImportBackup"));
    } finally {
      setLoading(false);
    }
  };

  const addSyncRecord = (result: LanSyncSummaryDTO) => {
    const record = toSyncRecord(result);
    setSyncRecords((current) => {
      const next = [record, ...current].slice(0, 8);
      window.localStorage.setItem(syncRecordStorageKey, JSON.stringify(next));
      return next;
    });
  };

  const copySyncAddress = async (address: string) => {
    try {
      await copyTextWithFallback(address);
      setStatus(copy.addressCopied);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : copy.syncFailed);
    }
  };

  const runLanSync = async (direction: LanSyncDirection) => {
    if (!syncPeerUrl.trim()) {
      setError(copy.syncPeerUrlRequired);
      return;
    }

    setLoading(true);
    setError(null);
    setStatus(null);

    try {
      const result =
        direction === "pull"
          ? await api.sync.pull({ peerBaseUrl: syncPeerUrl, mode: syncMode })
          : await api.sync.push({ peerBaseUrl: syncPeerUrl, mode: syncMode });

      addSyncRecord(result);

      if (direction === "pull") {
        applyLoadedSettings(await api.settings.get());
        setStatus(copy.syncPulled(result.summary));
      } else {
        setStatus(copy.syncPushed(result.summary));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : copy.syncFailed);
    } finally {
      setPendingSyncDirection(null);
      setLoading(false);
    }
  };

  const addProviderFromTemplate = (templateId: string) => {
    const template = providerTemplates.find((t) => t.id === templateId);
    if (!template) {
      return;
    }

    const newProvider: ProviderProfile = {
      id: generateId(),
      label: template.label,
      provider: template.provider,
      apiBaseUrl: template.apiBaseUrl,
      models: template.defaultModels.map((m) => ({
        id: generateId(),
        label: m.label,
        model: m.model
      }))
    };

    setForm((current) => ({
      ...current,
      providers: [...current.providers, newProvider]
    }));
    setExpandedProviderId(newProvider.id);
    setAddProviderDropdownOpen(false);
    setActiveSection("providers");
  };

  const addCustomProvider = () => {
    const newProvider: ProviderProfile = {
      id: generateId(),
      label: language === "zh-CN" ? "新供应商" : "New Provider",
      provider: "openai",
      apiBaseUrl: "https://api.openai.com/v1",
      models: []
    };

    setForm((current) => ({
      ...current,
      providers: [...current.providers, newProvider]
    }));
    setExpandedProviderId(newProvider.id);
    setAddProviderDropdownOpen(false);
    setActiveSection("providers");
  };

  const updateProvider = (providerId: string, updates: Partial<ProviderProfile>) => {
    setForm((current) => ({
      ...current,
      providers: current.providers.map((p) =>
        p.id === providerId ? { ...p, ...updates } : p
      )
    }));
  };

  const addModelToProvider = (providerId: string) => {
    const newModel: ProviderModel = {
      id: generateId(),
      label: "",
      model: ""
    };

    setForm((current) => ({
      ...current,
      providers: current.providers.map((p) =>
        p.id === providerId ? { ...p, models: [...p.models, newModel] } : p
      )
    }));
  };

  const updateModel = (providerId: string, modelId: string, updates: Partial<ProviderModel>) => {
    setForm((current) => ({
      ...current,
      providers: current.providers.map((p) =>
        p.id === providerId
          ? { ...p, models: p.models.map((m) => m.id === modelId ? { ...m, ...updates } : m) }
          : p
      )
    }));
  };

  const toggleModelSelection = (modelId: string) => {
    setSelectedModelIds((prev) => {
      const next = new Set(prev);
      if (next.has(modelId)) {
        next.delete(modelId);
      } else {
        next.add(modelId);
      }
      return next;
    });
  };

  const toggleAllModels = (modelIds: string[]) => {
    setSelectedModelIds((prev) => {
      const allSelected = modelIds.every((id) => prev.has(id));
      if (allSelected) {
        const next = new Set(prev);
        for (const id of modelIds) {
          next.delete(id);
        }
        return next;
      }
      const next = new Set(prev);
      for (const id of modelIds) {
        next.add(id);
      }
      return next;
    });
  };

  const batchDeleteModels = (providerId: string) => {
    setForm((current) => {
      const provider = current.providers.find((p) => p.id === providerId);
      if (!provider) return current;
      const toDelete = provider.models.filter((m) => selectedModelIds.has(m.id));
      if (!toDelete.length) return current;
      const deleteIds = new Set(toDelete.map((m) => m.id));
      return {
        ...current,
        providers: current.providers.map((p) =>
          p.id === providerId
            ? { ...p, models: p.models.filter((m) => !deleteIds.has(m.id)) }
            : p
        ),
        activeModelId: deleteIds.has(current.activeModelId) ? "" : current.activeModelId
      };
    });
    setSelectedModelIds(new Set());
    setPendingBatchDelete(null);
  };

  const selectModel = (providerId: string, modelId: string) => {
    setForm((current) => ({
      ...current,
      activeProviderId: providerId,
      activeModelId: modelId
    }));
  };

  const addModelsFromImport = (providerId: string, modelIds: string[]) => {
    const uniqueModelIds = [...new Set(modelIds.map((model) => model.trim()).filter(Boolean))];

    if (!uniqueModelIds.length) {
      return;
    }

    let addedCount = 0;

    setForm((current) => {
      const provider = current.providers.find((p) => p.id === providerId);
      if (!provider) {
        return current;
      }

      const existingModels = new Set(provider.models.map((m) => m.model));
      const modelsToAdd = uniqueModelIds
        .filter((model) => !existingModels.has(model))
        .map((model) => ({
          id: generateId(),
          label: model,
          model
        }));

      if (!modelsToAdd.length) {
        return current;
      }

      addedCount = modelsToAdd.length;
      return {
        ...current,
        providers: current.providers.map((p) =>
          p.id === providerId
            ? { ...p, models: [...p.models, ...modelsToAdd] }
            : p
        )
      };
    });
    if (addedCount > 0) {
      setStatus(language === "zh-CN" ? `已导入 ${addedCount} 个模型。` : `Imported ${addedCount} model(s).`);
    }
  };

  const fetchProviderModels = async (providerId: string) => {
    setLoading(true);
    setError(null);
    setStatus(null);

    try {
      const profile = form.providers.find((p) => p.id === providerId);
      const result = await api.settings.providerModels(providerId, profile ? {
        provider: profile.provider,
        apiBaseUrl: profile.apiBaseUrl,
        key: profile.key
      } : undefined);
      addModelsFromImport(providerId, result.models);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("settings.connectionFailed"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <ErrorNotice message={error} />
      <SuccessNotice message={status} />

      <section className={`rounded-2xl border p-4 sm:p-5 ${settingsPanelClassName}`}>
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.75fr)_minmax(300px,0.95fr)]">
          <div className="grid gap-3 sm:grid-cols-2">
            <SummaryCard
              label={copy.providerStatus}
              value={activeProviderName || t("common.unknown")}
            />
            <SummaryCard
              label={copy.modelStatus}
              value={activeModelName || t("common.unknown")}
              tone={activeModelName ? "emerald" : "default"}
            />
            <SummaryCard
              label={copy.apiKeyStatus}
              value={
                clearStoredApiKey
                  ? copy.keyPendingRemoval
                  : hasApiKey || Boolean(form.apiKey?.trim())
                    ? copy.keyStored
                    : copy.keyMissing
              }
              tone={hasApiKey || Boolean(form.apiKey?.trim()) ? "emerald" : "default"}
            />
            <SummaryCard
              label={copy.providerCount}
              value={copy.providerCountDisplay(form.providers.length)}
            />
          </div>

          <div className={`flex h-full flex-col gap-4 rounded-xl p-4 ${settingsSurfaceClassName}`}>
            <div className="space-y-2">
              <div className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
                {copy.changesStatus}
              </div>
              <div
                className={`inline-flex min-h-[32px] items-center rounded-full px-3 text-sm font-semibold ${
                  hasUnsavedChanges
                    ? "bg-amber-500/10 text-amber-200 shadow-[inset_0_0_0_1px_rgba(245,158,11,0.16)]"
                    : "bg-emerald-500/[0.06] text-emerald-200 shadow-[inset_0_0_0_1px_rgba(16,185,129,0.16)]"
                }`}
              >
                {hasUnsavedChanges ? copy.changesDirty : copy.changesClean}
              </div>
              <p className="text-sm leading-6 text-slate-400">
                {hasUnsavedChanges ? copy.proxyNote : copy.noPendingChanges}
              </p>
            </div>

            <div className="mt-auto flex flex-col gap-3">
              <Button
                className="w-full"
                disabled={loading || !hasUnsavedChanges}
                onClick={() => void saveSettings()}
              >
                <Save size={16} />
                {copy.saveReady}
              </Button>
              <Button
                className="w-full"
                disabled={loading}
                variant="secondary"
                onClick={() => void testBackend()}
              >
                <ServerCog size={16} />
                {t("settings.testModel")}
              </Button>
            </div>
          </div>
        </div>
      </section>

      <div>
        <div className={`flex rounded-xl border p-1 ${settingsPanelClassName}`}>
          {([
            ["runtime", copy.runtimeTitle],
            ["providers", copy.providersTitle],
            ["backup", copy.backupTitle]
          ] as const).map(([section, label]) => {
            const active = activeSection === section;

            return (
              <button
                key={section}
                className={`min-h-[48px] flex-1 whitespace-nowrap rounded-lg px-2 text-xs font-medium transition-colors sm:px-4 sm:text-sm ${
                  active
                    ? "bg-ember-500 text-ink-950 shadow-sm shadow-ember-500/20"
                    : "text-slate-300 hover:bg-ink-800/75 active:bg-ink-800/90"
                }`}
                type="button"
                onClick={() => setActiveSection(section)}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {activeSection === "runtime" ? (
        <Panel
          className={settingsPanelClassName}
          title={copy.runtimeTitle}
          action={
            activeModelName ? (
              <div
                className={`max-w-full truncate rounded-full px-3 py-1 text-xs font-medium text-slate-200 ${settingsSurfaceClassName}`}
                title={`${copy.activeModel}: ${activeModelName}`}
              >
                {`${copy.activeModel}: ${activeModelName}`}
              </div>
            ) : undefined
          }
        >
          <div className="space-y-6">
            <p className="text-sm leading-6 text-slate-400">{copy.runtimeHelp}</p>

            <div className={`rounded-xl p-4 ${settingsSurfaceClassName}`}>
              <div className="space-y-3">
                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <div className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
                      {copy.providerStatus}
                    </div>
                    <div className="mt-1 text-sm font-semibold text-slate-100">
                      {activeProviderName || t("common.unknown")}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
                      {copy.modelStatus}
                    </div>
                    <div className="mt-1 text-sm font-semibold text-slate-100">
                      {activeModelName || t("common.unknown")}
                    </div>
                  </div>
                </div>
                <p className="text-sm leading-6 text-slate-400">
                  {language === "zh-CN"
                    ? '要切换供应商或模型，请前往「供应商管理」标签页选择。'
                    : "To switch provider or model, go to the Provider Management tab."}
                </p>
              </div>
            </div>

            <div className={`border-t pt-6 ${settingsDividerClassName}`}>
              <div className="mb-5 grid gap-5 md:grid-cols-2">
                <Field label={language === "zh-CN" ? "聊天头像显示" : "Show chat avatars"}>
                  <label className="flex min-h-[40px] cursor-pointer items-center gap-3 rounded-lg border border-white/10 bg-ink-950/50 px-3 text-sm text-slate-100 transition-all hover:border-white/20">
                    <input
                      checked={form.showMessageAvatars ?? true}
                      type="checkbox"
                      className="rounded border-white/20 bg-ink-950 text-ember-500 focus:ring-ember-500/50"
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          showMessageAvatars: event.target.checked
                        }))
                      }
                    />
                    <span className="text-sm text-slate-200">
                      {language === "zh-CN" ? "在聊天消息中显示角色与用户封面" : "Show user and character covers in chat messages"}
                    </span>
                  </label>
                </Field>
              </div>
              <SettingsSectionHeading
                title={copy.samplingBlockTitle}
                description={
                  language === "zh-CN"
                    ? "把响应风格和输出长度放在一起，调整时更容易整体判断。"
                    : "Keep response style and output length together so the runtime stays easy to tune."
                }
              />

              <div className="mt-5 grid gap-5 md:grid-cols-3">
                <Field
                  label={
                    <HelpLabel
                      label={t("settings.temperature")}
                      description={t("help.temperature")}
                    />
                  }
                >
                  <TextInput
                    step="0.1"
                    min="0"
                    max="2"
                    type="number"
                    value={form.temperature}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        temperature: Math.min(2, Math.max(0, Number(event.target.value) || 0))
                      }))
                    }
                  />
                </Field>
                <Field
                  label={
                    <HelpLabel
                      label={t("settings.maxTokens")}
                      description={t("help.maxTokens")}
                    />
                  }
                >
                  <TextInput
                    min="1"
                    max="200000"
                    type="number"
                    value={form.maxTokens}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        maxTokens: Math.min(200000, Math.max(1, Number(event.target.value) || 1))
                      }))
                    }
                  />
                </Field>
                <Field
                  label={<HelpLabel label={t("settings.topP")} description={t("help.topP")} />}
                >
                  <TextInput
                    step="0.05"
                    min="0"
                    max="1"
                    type="number"
                    value={form.topP}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        topP: Math.min(1, Math.max(0, Number(event.target.value) || 0))
                      }))
                    }
                  />
                </Field>
              </div>
            </div>
          </div>
        </Panel>
      ) : null}

      {activeSection === "providers" ? (
        <Panel
          className={settingsPanelClassName}
          title={copy.providersTitle}
          action={
            <div ref={addProviderButtonRef}>
              <Button
                className="!min-h-[34px] !px-3 text-xs"
                variant="secondary"
                onClick={() => {
                  if (!addProviderDropdownOpen && addProviderButtonRef.current) {
                    const rect = addProviderButtonRef.current.getBoundingClientRect();
                    const dropdownHeight = 320;
                    const spaceBelow = window.innerHeight - rect.bottom;
                    const top = spaceBelow < dropdownHeight
                      ? rect.top - dropdownHeight - 4
                      : rect.bottom + 4;
                    const dropdownWidth = 256;
                    const left = rect.right - dropdownWidth;
                    const maxLeft = window.innerWidth - dropdownWidth - 8;
                    setDropdownPos({ top: Math.max(8, top), left: Math.min(Math.max(8, left), maxLeft) });
                  }
                  setAddProviderDropdownOpen((prev) => !prev);
                }}
              >
                <Plus size={14} />
                {copy.addProvider}
              </Button>
            </div>
          }
        >
          <div className="space-y-4">
            <p className="text-sm leading-6 text-slate-400">{copy.providersHelp}</p>

            {form.providers.length === 0 ? (
              <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-8 text-center text-sm text-slate-500">
                {copy.providerEmpty}
              </div>
            ) : (
              <div className="space-y-3">
                {form.providers.map((provider) => {
                  const isActive = provider.id === form.activeProviderId;
                  const isExpanded = expandedProviderId === provider.id;
                  const cardClassName = isActive
                    ? "border-ember-500/25 bg-ember-500/[0.05] shadow-lg shadow-ember-950/10"
                    : isExpanded
                      ? "border-white/10 bg-ink-950/40"
                      : "border-white/5 bg-white/5 hover:border-white/10 hover:bg-white/10";
                  const toggleIconClassName = isActive
                    ? "border-ember-500/20 bg-ember-500/10 text-ember-200"
                    : isExpanded
                      ? "border-white/10 bg-ink-800 text-slate-200"
                      : "border-white/5 bg-ink-900 text-slate-300";

                  return (
                    <div
                      key={provider.id}
                      className={`rounded-xl border px-4 py-4 transition-all duration-200 ${cardClassName}`}
                    >
                      <div className={`flex flex-col gap-3 border-b pb-4 md:flex-row md:items-start md:justify-between ${settingsDividerClassName}`}>
                        <div className="min-w-0 flex-1 space-y-3">
                          <button
                            className="flex w-full items-start gap-3 rounded-lg text-left outline-none transition-colors hover:text-slate-100 focus:text-slate-100"
                            type="button"
                            onClick={() =>
                              setExpandedProviderId((current) =>
                                current === provider.id ? null : provider.id
                              )
                            }
                          >
                            <span
                              className={`mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-colors ${toggleIconClassName}`}
                            >
                              {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                            </span>
                            <div className="min-w-0 space-y-2">
                              <div className="truncate text-sm font-semibold text-slate-100">
                                {getProviderDisplayName(provider, language)}
                              </div>
                              <div className="flex flex-wrap items-center gap-2">
                                {isActive ? <SettingsBadge>{copy.activeModel}</SettingsBadge> : null}
                                <SettingsBadge>{provider.provider || t("common.unknown")}</SettingsBadge>
                                <SettingsBadge>
                                  {language === "zh-CN"
                                    ? `${provider.models.length} 个模型`
                                    : `${provider.models.length} model(s)`}
                                </SettingsBadge>
                              </div>
                              <div className="truncate text-xs leading-5 text-slate-500">
                                {provider.apiBaseUrl}
                              </div>
                            </div>
                          </button>
                        </div>

                        <div className="flex flex-wrap items-center gap-2 md:shrink-0">
                          <Button
                            className="!min-h-[34px] !px-3 text-xs whitespace-nowrap hover:!bg-ink-800/75 focus:!ring-ink-700/40"
                            variant="secondary"
                            onClick={() => void fetchProviderModels(provider.id)}
                          >
                            <RefreshCw size={14} />
                            {copy.importFromProvider}
                          </Button>
                          <Button
                            className="!min-h-[34px] !w-9 !p-0"
                            variant="danger"
                            onClick={() => setPendingDeleteProviderId(provider.id)}
                          >
                            <Trash2 size={14} />
                          </Button>
                        </div>
                      </div>

                      <div
                        className={`overflow-hidden transition-all duration-200 ${isExpanded ? "mt-4" : ""}`}
                        aria-hidden={!isExpanded}
                        style={{
                          maxHeight: isExpanded ? "64rem" : "0px",
                          opacity: isExpanded ? 1 : 0,
                          pointerEvents: isExpanded ? "auto" : "none"
                        }}
                      >
                        <div className="space-y-4">
                          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                            <Field label={copy.providerLabel}>
                              <TextInput
                                value={provider.label}
                                onChange={(event) =>
                                  updateProvider(provider.id, { label: event.target.value })
                                }
                              />
                            </Field>
                            <Field label={copy.providerType}>
                              <TextInput
                                value={provider.provider}
                                onChange={(event) =>
                                  updateProvider(provider.id, { provider: event.target.value })
                                }
                              />
                            </Field>
                            <Field label={copy.providerUrl}>
                              <TextInput
                                value={provider.apiBaseUrl}
                                onChange={(event) =>
                                  updateProvider(provider.id, { apiBaseUrl: event.target.value })
                                }
                              />
                            </Field>
                            <Field label={copy.providerKey}>
                              <TextInput
                                type="password"
                                value={provider.key ?? ""}
                                onChange={(event) =>
                                  updateProvider(provider.id, {
                                    key: event.target.value || undefined
                                  })
                                }
                              />
                            </Field>
                          </div>

                          <div className={`border-t pt-4 ${settingsDividerClassName}`}>
                            <div className="mb-3 flex items-center justify-between">
                              <div className="flex items-center gap-3">
                                <span className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
                                  {copy.providerModels}
                                </span>
                                {manageMode ? (
                                  <label className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-400">
                                    <input
                                      checked={provider.models.length > 0 && provider.models.every((m) => selectedModelIds.has(m.id))}
                                      className="rounded border-white/20 bg-ink-950 text-ember-500 focus:ring-ember-500/50"
                                      type="checkbox"
                                      onChange={() => toggleAllModels(provider.models.map((m) => m.id))}
                                    />
                                    {language === "zh-CN" ? "全选" : "All"}
                                  </label>
                                ) : null}
                                {manageMode && selectedModelIds.size > 0 ? (
                                  <Button
                                    className="!min-h-[28px] !px-2 text-xs"
                                    variant="danger"
                                    onClick={() => setPendingBatchDelete(provider.id)}
                                  >
                                    <Trash2 size={12} />
                                    {language === "zh-CN"
                                      ? `删除 ${selectedModelIds.size} 个`
                                      : `Delete ${selectedModelIds.size}`}
                                  </Button>
                                ) : null}
                              </div>
                              <div className="flex items-center gap-2">
                                {provider.models.length > 0 ? (
                                  <button
                                    className={`text-xs transition-colors ${manageMode ? "text-ember-400 hover:text-ember-300" : "text-slate-400 hover:text-slate-200"}`}
                                    type="button"
                                    onClick={() => {
                                      setManageMode((prev) => !prev);
                                      setSelectedModelIds(new Set());
                                    }}
                                  >
                                    {manageMode
                                      ? (language === "zh-CN" ? "退出管理" : "Exit")
                                      : (language === "zh-CN" ? "管理" : "Manage")}
                                  </button>
                                ) : null}
                                <Button
                                  className="!min-h-[28px] !px-2 text-xs"
                                  variant="ghost"
                                  onClick={() => addModelToProvider(provider.id)}
                                >
                                  <Plus size={12} />
                                  {copy.addModel}
                                </Button>
                              </div>
                            </div>

                            {provider.models.length === 0 ? (
                              <p className="py-4 text-center text-xs text-slate-500">
                                {language === "zh-CN"
                                  ? "暂无模型，请添加或导入。"
                                  : "No models yet. Add or import some."}
                              </p>
                            ) : (
                              <div className="space-y-2">
                                {provider.models.map((model) => {
                                  const isModelActive =
                                    provider.id === form.activeProviderId &&
                                    model.id === form.activeModelId;

                                  return (
                                    <div
                                      key={model.id}
                                      className={`group flex items-center gap-2.5 rounded-lg border px-3 py-2 transition-all ${
                                        manageMode
                                          ? "cursor-pointer border-white/5 bg-white/[0.02] hover:border-white/10"
                                          : isModelActive
                                            ? "border-ember-500/25 bg-ember-500/[0.06]"
                                            : "border-white/5 bg-white/[0.02] hover:border-white/10"
                                      }`}
                                      onClick={(event) => {
                                        const target = event.target as HTMLElement;
                                        if (target.tagName === "INPUT" || target.closest("button") || target.closest("input")) return;
                                        if (manageMode) {
                                          toggleModelSelection(model.id);
                                        } else {
                                          selectModel(provider.id, model.id);
                                        }
                                      }}
                                    >
                                      {manageMode ? (
                                        <input
                                          checked={selectedModelIds.has(model.id)}
                                          className="shrink-0 rounded border-white/20 bg-ink-950 text-ember-500 focus:ring-ember-500/50"
                                          type="checkbox"
                                          onChange={() => toggleModelSelection(model.id)}
                                        />
                                      ) : null}
                                      <button
                                        className={`shrink-0 rounded-full border-2 transition-all ${
                                          manageMode
                                            ? "h-3.5 w-3.5 cursor-not-allowed border-slate-600 bg-slate-700/50 opacity-40"
                                            : isModelActive
                                              ? "h-3.5 w-3.5 border-ember-400 bg-ember-400 shadow-[0_0_6px_rgba(251,146,60,0.4)]"
                                              : "h-3.5 w-3.5 border-slate-500 bg-transparent hover:border-slate-300"
                                        }`}
                                        disabled={manageMode}
                                        title={language === "zh-CN" ? "设为当前模型" : "Set as active model"}
                                        type="button"
                                        onClick={() => selectModel(provider.id, model.id)}
                                      />
                                      <TextInput
                                        className={`!min-h-[30px] !flex-1 !border-0 !bg-transparent !px-1 !py-1 font-mono text-xs ${manageMode ? "pointer-events-none opacity-40" : ""}`}
                                        disabled={manageMode}
                                        placeholder={copy.modelId}
                                        value={model.model}
                                        onChange={(event) =>
                                          updateModel(provider.id, model.id, { model: event.target.value, label: event.target.value })
                                        }
                                      />
                                      {!manageMode ? (
                                      <Button
                                        className="!min-h-[28px] !w-7 !p-0 opacity-0 transition-opacity group-hover:opacity-100"
                                        variant="danger"
                                        onClick={() =>
                                          setPendingDeleteModel({
                                            providerId: provider.id,
                                            modelId: model.id
                                          })
                                        }
                                      >
                                        <Trash2 size={12} />
                                      </Button>
                                      ) : null}
                                    </div>
                                  );
                                })}
                              </div>
                            )}

                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </Panel>
      ) : null}

      {activeSection === "backup" ? (
        <Panel className={settingsPanelClassName} title={copy.backupTitle}>
          <div className="space-y-6">
            <p className="text-sm leading-6 text-slate-400">{copy.backupHelp}</p>

            <Field label={t("settings.importMode")}>
              <select
                className={selectClassName}
                value={importMode}
                onChange={(event) => setImportMode(event.target.value as "merge" | "replace")}
              >
                <option value="merge">{t("settings.importModeMerge")}</option>
                <option value="replace">{t("settings.importModeReplace")}</option>
              </select>
            </Field>

            <div className="flex flex-wrap gap-3">
              <Button
                disabled={loading}
                variant="secondary"
                onClick={() => void exportBackup()}
              >
                <Download size={16} />
                {t("settings.exportBackup")}
              </Button>
              <Button
                disabled={loading}
                variant="secondary"
                onClick={() => document.getElementById("backup-import-input")?.click()}
              >
                <FileUp size={16} />
                {t("settings.importBackup")}
              </Button>
              <input
                id="backup-import-input"
                className="sr-only"
                type="file"
                accept="application/json,.json"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  setPendingImportFile(file ?? null);
                }}
              />
            </div>

            <div className={`border-t pt-6 ${settingsDividerClassName}`}>
              <div className="mb-4 flex items-start gap-3">
                <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-white/10 bg-white/[0.03] text-ember-300">
                  <Wifi size={18} />
                </div>
                <SettingsSectionHeading title={copy.syncTitle} description={copy.syncHelp} />
              </div>

              <div className={`mb-4 rounded-lg p-3 ${settingsSurfaceClassName}`}>
                <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-slate-100">
                      {copy.localBackendTitle}
                    </div>
                    <p className="mt-1 text-xs leading-5 text-slate-500">
                      {copy.localBackendHelp}
                    </p>
                  </div>
                  <Button
                    className="!min-h-[34px] !px-3 text-xs"
                    disabled={syncInfoLoading}
                    variant="ghost"
                    onClick={() => void loadSyncInfo()}
                  >
                    <RefreshCw size={14} />
                    {copy.localBackendRefresh}
                  </Button>
                </div>

                {syncInfoLoading && syncAddressRows.length === 0 ? (
                  <div className="rounded-lg border border-white/5 bg-white/[0.02] px-3 py-3 text-sm text-slate-500">
                    {copy.localBackendLoading}
                  </div>
                ) : syncAddressRows.length === 0 ? (
                  <div className="rounded-lg border border-white/5 bg-white/[0.02] px-3 py-3 text-sm text-slate-500">
                    {copy.localBackendUnavailable}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {syncAddressRows.map((address) => (
                      <div
                        key={`${address.label}-${address.url}`}
                        className="grid gap-2 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2 sm:grid-cols-[minmax(0,1fr)_auto]"
                      >
                        <div className="min-w-0">
                          <div className="mb-1">
                            <SettingsBadge>{address.label}</SettingsBadge>
                          </div>
                          <div className="break-all font-mono text-xs leading-5 text-slate-300">
                            {address.url}
                          </div>
                        </div>
                        <Button
                          className="!min-h-[32px] !px-3 text-xs"
                          variant="secondary"
                          onClick={() => void copySyncAddress(address.url)}
                        >
                          <CopyIcon size={13} />
                          {copy.copyAddress}
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_220px]">
                <Field label={copy.syncPeerUrl}>
                  <TextInput
                    inputMode="url"
                    placeholder={copy.syncPeerPlaceholder}
                    value={syncPeerUrl}
                    onChange={(event) => setSyncPeerUrl(event.target.value)}
                  />
                </Field>
                <Field label={copy.syncMode}>
                  <select
                    className={selectClassName}
                    value={syncMode}
                    onChange={(event) => setSyncMode(event.target.value as "merge" | "replace")}
                  >
                    <option value="merge">{t("settings.importModeMerge")}</option>
                    <option value="replace">{t("settings.importModeReplace")}</option>
                  </select>
                </Field>
              </div>

              <div className="mt-4 flex flex-wrap gap-3">
                <Button
                  disabled={loading}
                  variant="secondary"
                  onClick={() => setPendingSyncDirection("pull")}
                >
                  <ArrowDownToLine size={16} />
                  {copy.syncPull}
                </Button>
                <Button
                  disabled={loading}
                  variant="secondary"
                  onClick={() => setPendingSyncDirection("push")}
                >
                  <ArrowUpFromLine size={16} />
                  {copy.syncPush}
                </Button>
              </div>
            </div>

            <div className={`border-t pt-6 ${settingsDividerClassName}`}>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                  <History size={16} className="text-slate-400" />
                  {copy.syncRecords}
                </div>
                <span className="text-xs text-slate-500">{copy.syncRecordLegend}</span>
              </div>

              {syncRecords.length === 0 ? (
                <div className={`rounded-lg px-4 py-5 text-center text-sm text-slate-500 ${settingsSurfaceClassName}`}>
                  {copy.syncNoRecords}
                </div>
              ) : (
                <div className="space-y-2">
                  {syncRecords.map((record) => (
                    <div
                      key={record.id}
                      className={`grid gap-2 rounded-lg px-3 py-3 text-sm sm:grid-cols-[minmax(0,1fr)_auto] ${settingsSurfaceClassName}`}
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <SettingsBadge>{copy.syncDirection(record.direction)}</SettingsBadge>
                          <SettingsBadge>{copy.syncModeLabel(record.mode)}</SettingsBadge>
                          <span className="truncate text-slate-300">{record.peerBaseUrl}</span>
                        </div>
                        <div className="mt-2 text-xs text-slate-500">
                          {new Date(record.completedAt).toLocaleString(
                            language === "zh-CN" ? "zh-CN" : "en-US"
                          )}
                        </div>
                      </div>
                      <div className="font-mono text-xs text-slate-300">
                        {describeSummaryCounts(record.summary)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </Panel>
      ) : null}

      {pendingImportFile ? (
        <ConfirmDialog
          cancelLabel={t("common.cancel")}
          confirmLabel={t("common.confirm")}
          loading={loading}
          message={t("settings.importBackupConfirm")}
          title={t("settings.importBackupTitle")}
          variant="primary"
          onCancel={() => setPendingImportFile(null)}
          onConfirm={() => void importBackup(pendingImportFile)}
        />
      ) : null}

      {pendingSyncDirection ? (
        <ConfirmDialog
          cancelLabel={t("common.cancel")}
          confirmLabel={t("common.confirm")}
          loading={loading}
          message={
            pendingSyncDirection === "pull" ? copy.syncPullConfirm : copy.syncPushConfirm
          }
          title={copy.syncTitle}
          variant="primary"
          onCancel={() => setPendingSyncDirection(null)}
          onConfirm={() => void runLanSync(pendingSyncDirection)}
        />
      ) : null}

      {pendingDeleteProviderId ? (
        <ConfirmDialog
          cancelLabel={t("common.cancel")}
          confirmLabel={t("common.delete")}
          loading={loading}
          message={copy.providerDeleteConfirm(
            getProviderDisplayName(
              form.providers.find((p) => p.id === pendingDeleteProviderId) ?? {
                id: "",
                label: "",
                provider: "",
                apiBaseUrl: "",
                models: []
              },
              language
            )
          )}
          title={copy.providerDeleteTitle}
          onCancel={() => setPendingDeleteProviderId(null)}
          onConfirm={() => {
            setForm((current) => ({
              ...current,
              providers: current.providers.filter((p) => p.id !== pendingDeleteProviderId),
              activeProviderId:
                current.activeProviderId === pendingDeleteProviderId
                  ? ""
                  : current.activeProviderId,
              activeModelId:
                current.activeProviderId === pendingDeleteProviderId
                  ? ""
                  : current.activeModelId
            }));
            setPendingDeleteProviderId(null);
          }}
        />
      ) : null}

      {pendingDeleteModel ? (
        <ConfirmDialog
          cancelLabel={t("common.cancel")}
          confirmLabel={t("common.delete")}
          loading={loading}
          message={
            language === "zh-CN"
              ? `删除该模型？`
              : `Delete this model?`
          }
          title={copy.providerDeleteTitle}
          onCancel={() => setPendingDeleteModel(null)}
          onConfirm={() => {
            setForm((current) => ({
              ...current,
              providers: current.providers.map((p) =>
                p.id === pendingDeleteModel.providerId
                  ? {
                      ...p,
                      models: p.models.filter((m) => m.id !== pendingDeleteModel.modelId)
                    }
                  : p
              ),
              activeModelId:
                current.activeModelId === pendingDeleteModel.modelId
                  ? ""
                  : current.activeModelId
            }));
            setPendingDeleteModel(null);
          }}
        />
      ) : null}

      {pendingBatchDelete ? (
        <ConfirmDialog
          cancelLabel={t("common.cancel")}
          confirmLabel={t("common.delete")}
          loading={loading}
          message={
            language === "zh-CN"
              ? `删除选中的 ${selectedModelIds.size} 个模型？`
              : `Delete ${selectedModelIds.size} selected model(s)?`
          }
          title={copy.providerDeleteTitle}
          onCancel={() => setPendingBatchDelete(null)}
          onConfirm={() => batchDeleteModels(pendingBatchDelete)}
        />
      ) : null}

      {addProviderDropdownOpen && dropdownPos
        ? createPortal(
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={() => {
                  setAddProviderDropdownOpen(false);
                  setDropdownPos(null);
                }}
              />
              <div
                className="fixed z-50 max-h-80 w-64 overflow-y-auto rounded-xl border border-white/10 bg-ink-900 p-1 shadow-xl shadow-black/30"
                style={{ top: dropdownPos.top, left: dropdownPos.left }}
              >
                {providerTemplates.map((template) => (
                  <button
                    key={template.id}
                    className="flex w-full flex-col gap-1 rounded-lg px-3 py-2.5 text-left text-sm text-slate-200 transition-colors hover:bg-white/10"
                    type="button"
                    onClick={() => addProviderFromTemplate(template.id)}
                  >
                    <span className="font-medium">{template.label}</span>
                    <span className="text-xs text-slate-500">{template.provider}</span>
                  </button>
                ))}
                <div className="mx-1 my-1 border-t border-white/5" />
                <button
                  className="flex w-full items-center rounded-lg px-3 py-2.5 text-left text-sm font-medium text-slate-300 transition-colors hover:bg-white/10"
                  type="button"
                  onClick={addCustomProvider}
                >
                  {language === "zh-CN" ? "自定义供应商" : "Custom Provider"}
                </button>
              </div>
            </>,
            document.body
          )
        : null}
    </div>
  );
}
