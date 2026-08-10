import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Copy as CopyIcon,
  Download,
  FileUp,
  History,
  Plus,
  RefreshCw,
  Save,
  ServerCog,
  Trash2,
  Wifi,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getAiModelCapabilities, modelSupportsAiModule } from "@local-roleplay/shared";
import { AboutUpdatesPanel } from "../components/AboutUpdatesPanel";
import { languageOptions, useI18n } from "../i18n";
import { api } from "../lib/api";
import { readFileText, saveJsonFile } from "../lib/files";
import { generateId } from "../lib/uuid";
import { useAppStore } from "../store/useAppStore";
import type {
  AppLanguage,
  AiModelCapability,
  AiModuleId,
  BackupConflictAction,
  BackupConflictResolutionDTO,
  BackupImportSummaryDTO,
  BackupPreviewDTO,
  LanSyncDirection,
  LanSyncInfoDTO,
  LanSyncSummaryDTO,
  ProviderModel,
  ProviderProfile,
  PublicUserSettingsDTO,
  RecoveryPointDTO,
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
  moduleModelPreferences: {},
  userPersonaPresets: [],
  showMessageAvatars: true,
  showMessageTimestamps: false,
  ttsVoice: "alloy",
  ttsPlaybackRate: 1,
  ttsAutoPlay: false,
  userProfileSummary: ""
};

const selectClassName =
  "min-h-[44px] w-full rounded-md border border-white/[0.1] bg-ink-950/70 px-3 text-sm text-ink-50 outline-none transition-colors hover:border-white/[0.16] focus:border-ember-400 focus:bg-ink-950 focus:ring-1 focus:ring-ember-400/30 sm:min-h-10";

const settingsPanelClassName =
  "border-white/[0.08] bg-ink-900";

const settingsSurfaceClassName =
  "border border-white/[0.07] bg-ink-950/45";

const settingsDividerClassName = "border-white/[0.08]";
const syncRecordStorageKey = "star-companion:lan-sync-records";
const lastBackupStorageKey = "star-companion:last-successful-backup";

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
  completedAt: result.completedAt!,
  summary: result.summary!
});

const describeSummaryCounts = (summary: BackupImportSummaryDTO) =>
  `${summary.characters} / ${summary.chats} / ${summary.messages} / ${summary.memories}`;

const previewCountFields = ["added", "updated", "skipped", "conflicts", "invalid", "deleted"] as const;

const moduleModelRows = [
  { id: "chat", zh: "聊天回复", en: "Chat replies" },
  { id: "agent", zh: "AI Agent", en: "AI Agent" },
  { id: "memory", zh: "长期记忆", en: "Long-term memory" },
  { id: "memory_embedding", zh: "记忆向量", en: "Memory embeddings" },
  { id: "user_profile", zh: "用户画像", en: "User profile" },
  { id: "voice_transcription", zh: "语音转文字", en: "Voice transcription" },
  { id: "voice_speech", zh: "文字朗读", en: "Text to speech" },
  { id: "image_generation", zh: "生图", en: "Image generation" }
] satisfies Array<{ id: AiModuleId; zh: string; en: string }>;

const modelCapabilityRows: Array<{ id: AiModelCapability; zh: string; en: string }> = [
  { id: "text_generation", zh: "文本生成", en: "Text" },
  { id: "text_embedding", zh: "文本向量", en: "Embedding" },
  { id: "audio_transcription", zh: "语音转写", en: "Transcription" },
  { id: "text_to_speech", zh: "文字朗读", en: "Speech" },
  { id: "image_generation", zh: "生图", en: "Image" }
];

const removeModuleModelPreferences = (
  preferences: SettingsInput["moduleModelPreferences"],
  providerId: string,
  modelIds?: Set<string>
) => {
  const next = { ...(preferences ?? {}) };
  for (const [moduleId, preference] of Object.entries(next)) {
    if (preference?.providerId === providerId && (!modelIds || modelIds.has(preference.modelId))) {
      delete next[moduleId as AiModuleId];
    }
  }
  return next;
};

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
      { label: "GPT-5.4 Nano", model: "gpt-5.4-nano" },
      { label: "Text Embedding 3 Small", model: "text-embedding-3-small", capabilities: ["text_embedding"] },
      { label: "GPT-4o Mini Transcribe", model: "gpt-4o-mini-transcribe", capabilities: ["audio_transcription"] },
      { label: "GPT-4o Mini TTS", model: "gpt-4o-mini-tts", capabilities: ["text_to_speech"] },
      { label: "GPT Image 1", model: "gpt-image-1", capabilities: ["image_generation"] }
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
      { label: "Gemini 2.5 Flash", model: "gemini-2.5-flash" },
      { label: "Gemini Embedding 001", model: "gemini-embedding-001", capabilities: ["text_embedding"] }
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
        aboutTitle: "关于与更新",
        backupHelp:
          "完整备份会导出角色、聊天、消息和记忆；设置仅导出模型参数，不包含 API Key。",
        workflowSteps: "选择来源 → 预检 → 查看影响 → 确认执行 → 结果摘要",
        lastBackup: "最近成功备份",
        lastRecovery: "最近恢复点",
        never: "暂无",
        previewTitle: "影响预览",
        previewCounts: { added: "新增", updated: "更新", skipped: "跳过", conflicts: "冲突", invalid: "无效", deleted: "预计删除" },
        previewBlocked: "此来源未通过完整性校验，不能执行写入。",
        previewReady: "预检已完成。数据库尚未发生任何修改。",
        previewIssues: "校验问题",
        conflictResolution: "冲突处理",
        keepExisting: "保留本机",
        useIncomingBackup: "采用备份",
        useLocal: "保留本机数据",
        usePeer: "采用对端数据",
        skipConflict: "跳过此冲突",
        confirmImport: "确认执行导入",
        replaceDanger: "替换模式会删除未包含在来源中的现有角色、聊天、消息和记忆，并先自动创建恢复点。",
        recoveryTitle: "本地恢复点",
        recoveryEmpty: "还没有恢复点。发生覆盖或删除前会自动创建。",
        recoveryReason: (reason: RecoveryPointDTO["reason"]) => reason === "before_restore" ? "恢复前" : "导入前",
        restore: "恢复",
        restoreConfirm: "恢复会用此恢复点替换当前角色、聊天、消息和长期记忆，并先创建新的安全恢复点。确定继续吗？",
        restoreComplete: "恢复完成。已同时保留恢复前安全点。",
        restoreFailed: "恢复失败，原数据未被修改。",
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
        syncPreviewAction: "生成差异预览",
        confirmSync: "确认执行同步",
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
        aboutTitle: "About & Updates",
        backupHelp:
          "Full backups export characters, chats, and messages. Settings export model parameters but never the API key.",
        workflowSteps: "Choose source → Preflight → Review impact → Confirm → Result",
        lastBackup: "Latest successful backup",
        lastRecovery: "Latest recovery point",
        never: "None yet",
        previewTitle: "Impact Preview",
        previewCounts: { added: "Add", updated: "Update", skipped: "Skip", conflicts: "Conflict", invalid: "Invalid", deleted: "Expected deletion" },
        previewBlocked: "This source failed integrity validation and cannot write data.",
        previewReady: "Preflight is complete. No database data has been changed.",
        previewIssues: "Validation issues",
        conflictResolution: "Conflict resolution",
        keepExisting: "Keep this device",
        useIncomingBackup: "Use backup",
        useLocal: "Keep local data",
        usePeer: "Use peer data",
        skipConflict: "Skip this conflict",
        confirmImport: "Confirm Import",
        replaceDanger: "Replace deletes existing characters, chats, messages, and memories that are absent from the source. A recovery point is created first.",
        recoveryTitle: "Local Recovery Points",
        recoveryEmpty: "No recovery points yet. One is created automatically before overwrite or deletion.",
        recoveryReason: (reason: RecoveryPointDTO["reason"]) => reason === "before_restore" ? "Before restore" : "Before import",
        restore: "Restore",
        restoreConfirm: "Restore replaces current characters, chats, messages, and memories with this point, after first creating a new safety point. Continue?",
        restoreComplete: "Restore complete. A pre-restore safety point was also retained.",
        restoreFailed: "Restore failed. Existing data was not changed.",
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
        syncPreviewAction: "Generate Difference Preview",
        confirmSync: "Confirm Sync",
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

type SettingsSection = "runtime" | "providers" | "backup" | "about";
type SettingsSetupFocus = "provider" | "api-key" | "model";
type SettingsModuleFocus = `module-${AiModuleId}`;
type SettingsFocus = SettingsSetupFocus | SettingsModuleFocus;

const isSettingsSetupFocus = (
  focus: SettingsFocus | null
): focus is SettingsSetupFocus =>
  focus === "provider" || focus === "api-key" || focus === "model";

const getFocusedModuleId = (focus: SettingsFocus | null): AiModuleId | null => {
  if (!focus?.startsWith("module-")) {
    return null;
  }

  const moduleId = focus.slice("module-".length) as AiModuleId;
  return moduleModelRows.some((row) => row.id === moduleId) ? moduleId : null;
};

const readSettingsLocation = () => {
  const params = new URLSearchParams(window.location.search);
  const section = params.get("section");
  const focus = params.get("focus");
  const moduleFocus = moduleModelRows
    .map((row) => `module-${row.id}` as SettingsModuleFocus)
    .find((value) => value === focus);

  return {
    section: section === "providers" || section === "backup" || section === "about" ? section : "runtime",
    focus:
      focus === "provider" || focus === "api-key" || focus === "model"
        ? focus
        : moduleFocus ?? null
  } satisfies { section: SettingsSection; focus: SettingsFocus | null };
};

const providerCanRunWithoutKey = (provider: ProviderProfile) => {
  const providerKind = provider.provider.trim().toLowerCase();
  if (providerKind === "ollama" || providerKind === "lm-studio") {
    return true;
  }

  try {
    const host = new URL(provider.apiBaseUrl).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
};

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
    <div className={`rounded-md border-l-2 px-4 py-3 ${toneClassName}`}>
      <div className="section-kicker">{label}</div>
      <div className="mt-1.5 min-w-0 break-words text-sm font-semibold leading-6 text-ink-50">
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
  const setShowMessageTimestamps = useAppStore((state) => state.setShowMessageTimestamps);

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
  const [pendingImportData, setPendingImportData] = useState<unknown>(null);
  const [backupPreview, setBackupPreview] = useState<BackupPreviewDTO | null>(null);
  const [importResolutions, setImportResolutions] = useState<Record<string, BackupConflictAction>>({});
  const [confirmingImport, setConfirmingImport] = useState(false);
  const [syncPreview, setSyncPreview] = useState<LanSyncSummaryDTO | null>(null);
  const [syncResolutions, setSyncResolutions] = useState<Record<string, BackupConflictAction>>({});
  const [confirmingSync, setConfirmingSync] = useState(false);
  const [recoveryPoints, setRecoveryPoints] = useState<RecoveryPointDTO[]>([]);
  const [pendingRestorePoint, setPendingRestorePoint] = useState<RecoveryPointDTO | null>(null);
  const [lastBackupAt, setLastBackupAt] = useState<string | null>(null);
  const [expandedProviderId, setExpandedProviderId] = useState<string | null>(null);
  const [settingsLocation] = useState(readSettingsLocation);
  const [activeSection, setActiveSection] = useState<SettingsSection>(settingsLocation.section);
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
  const setupAutoExpandedRef = useRef(false);
  const setupGuideRef = useRef<HTMLElement>(null);
  const focusedModuleRowRef = useRef<HTMLDivElement>(null);
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
        moduleModelPreferences: settings.moduleModelPreferences ?? {},
        userPersonaPresets: settings.userPersonaPresets ?? [],
        showMessageAvatars: settings.showMessageAvatars,
        showMessageTimestamps: settings.showMessageTimestamps,
        ttsVoice: settings.ttsVoice ?? "alloy",
        ttsPlaybackRate: settings.ttsPlaybackRate ?? 1,
        ttsAutoPlay: settings.ttsAutoPlay ?? false,
        userProfileSummary: settings.userProfileSummary ?? ""
      };
      setForm(nextForm);
      setSavedSnapshot(serializeForm(nextForm));
      setLanguage(settings.language);
      setShowMessageAvatars(settings.showMessageAvatars);
      setShowMessageTimestamps(settings.showMessageTimestamps);
      setHasApiKey(settings.hasApiKey);
      setClearStoredApiKey(false);
    },
    [setLanguage, setShowMessageAvatars, setShowMessageTimestamps]
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
    setLastBackupAt(window.localStorage.getItem(lastBackupStorageKey));
  }, []);

  const loadRecoveryPoints = useCallback(async () => {
    try {
      setRecoveryPoints(await api.backups.recoveryPoints());
    } catch {
      setRecoveryPoints([]);
    }
  }, []);

  useEffect(() => {
    void loadRecoveryPoints();
  }, [loadRecoveryPoints]);

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

  const setupProviderReady = form.providers.some(
    (provider) =>
      provider.label.trim() &&
      provider.provider.trim() &&
      isValidUrl(provider.apiBaseUrl)
  );
  const setupCredentialReady =
    !clearStoredApiKey &&
    (hasApiKey ||
      Boolean(form.apiKey?.trim()) ||
      form.providers.some(
        (provider) =>
          Boolean(provider.key?.trim()) ||
          Boolean(provider.hasKey) ||
          providerCanRunWithoutKey(provider)
      ));
  const setupActiveProvider = form.providers.find(
    (provider) => provider.id === form.activeProviderId
  );
  const setupActiveModel = setupActiveProvider?.models.find(
    (model) => model.id === form.activeModelId
  );
  const setupModelReady = Boolean(
    setupActiveProvider &&
      setupActiveModel &&
      modelSupportsAiModule(setupActiveProvider.provider, setupActiveModel, "chat")
  );
  const setupSteps = [
    {
      id: "provider" as const,
      ready: setupProviderReady,
      title: t("settings.setupProvider"),
      detail: t("settings.setupProviderHelp")
    },
    {
      id: "api-key" as const,
      ready: setupCredentialReady,
      title: t("settings.setupCredential"),
      detail: t("settings.setupCredentialHelp")
    },
    {
      id: "model" as const,
      ready: setupModelReady,
      title: t("settings.setupModel"),
      detail: t("settings.setupModelHelp")
    }
  ];
  const setupReadyCount = setupSteps.filter((step) => step.ready).length;
  const focusedModuleId = getFocusedModuleId(settingsLocation.focus);
  const showSetupGuide =
    isSettingsSetupFocus(settingsLocation.focus) || !setupProviderReady;

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

  useEffect(
    () => () => {
      onDirtyChange?.(false);
    },
    [onDirtyChange]
  );

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
    if (
      !settingsLocation.focus ||
      !isSettingsSetupFocus(settingsLocation.focus) ||
      setupAutoExpandedRef.current ||
      form.providers.length === 0
    ) {
      return;
    }

    const providerId =
      form.providers.find((provider) => provider.id === form.activeProviderId)?.id ??
      form.providers[0]?.id;
    if (providerId) {
      setupAutoExpandedRef.current = true;
      setExpandedProviderId(providerId);
    }
  }, [form.activeProviderId, form.providers, settingsLocation.focus]);

  useEffect(() => {
    if (savedSnapshot === null) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      if (isSettingsSetupFocus(settingsLocation.focus)) {
        setupGuideRef.current?.scrollIntoView({ block: "start" });
        return;
      }

      if (focusedModuleId) {
        focusedModuleRowRef.current?.scrollIntoView({ block: "center" });
        focusedModuleRowRef.current?.querySelector("select")?.focus();
      }
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [focusedModuleId, savedSnapshot, settingsLocation.focus]);

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
        moduleModelPreferences: settings.moduleModelPreferences ?? {},
        userPersonaPresets: settings.userPersonaPresets ?? [],
        autoSummarizeUser: settings.autoSummarizeUser,
        showMessageAvatars: settings.showMessageAvatars,
        showMessageTimestamps: settings.showMessageTimestamps,
        ttsVoice: settings.ttsVoice ?? "alloy",
        ttsPlaybackRate: settings.ttsPlaybackRate ?? 1,
        ttsAutoPlay: settings.ttsAutoPlay ?? false,
        userProfileSummary: settings.userProfileSummary ?? ""
      };

      setForm(nextForm);
      setSavedSnapshot(serializeForm(nextForm));
      setHasApiKey(settings.hasApiKey);
      setClearStoredApiKey(false);
      setLanguage(settings.language);
      setShowMessageAvatars(settings.showMessageAvatars);
      setShowMessageTimestamps(settings.showMessageTimestamps);
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
      await saveJsonFile(`local-roleplay-backup-${stamp}.json`, backup);
      const exportedAt = new Date().toISOString();
      window.localStorage.setItem(lastBackupStorageKey, exportedAt);
      setLastBackupAt(exportedAt);
      setStatus(t("settings.backupExported"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("settings.failedExportBackup"));
    } finally {
      setLoading(false);
    }
  };

  const prepareBackupImport = async (file: File | undefined) => {
    if (!file) return;
    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const parsed = JSON.parse(await readFileText(file)) as unknown;
      const preview = await api.backups.preview(parsed, importMode);
      setPendingImportFile(file);
      setPendingImportData(parsed);
      setBackupPreview(preview);
      setImportResolutions({});
      setConfirmingImport(false);
    } catch (caught) {
      setPendingImportFile(null);
      setPendingImportData(null);
      setBackupPreview(null);
      setError(caught instanceof Error ? caught.message : t("settings.failedImportBackup"));
    } finally {
      setLoading(false);
    }
  };

  const importBackup = async () => {
    if (!pendingImportFile || !backupPreview || !pendingImportData) {
      return;
    }

    setLoading(true);
    setError(null);
    setStatus(null);

    try {
      const conflictResolutions: BackupConflictResolutionDTO[] = Object.entries(importResolutions).map(
        ([key, action]) => ({ key, action })
      );
      const summary = await api.backups.import(
        pendingImportData,
        importMode,
        backupPreview.previewId,
        conflictResolutions
      );
      setPendingImportFile(null);
      setPendingImportData(null);
      setBackupPreview(null);
      setConfirmingImport(false);
      await loadRecoveryPoints();
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
    if (!result.summary || !result.completedAt) return;
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

  const prepareLanSync = async (direction: LanSyncDirection) => {
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
          ? await api.sync.pull({ peerBaseUrl: syncPeerUrl, mode: syncMode, phase: "preview" })
          : await api.sync.push({ peerBaseUrl: syncPeerUrl, mode: syncMode, phase: "preview" });

      setPendingSyncDirection(direction);
      setSyncPreview(result);
      setSyncResolutions({});
      setConfirmingSync(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : copy.syncFailed);
    } finally {
      setLoading(false);
    }
  };

  const runLanSync = async () => {
    if (!pendingSyncDirection || !syncPreview) return;
    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const conflictResolutions: BackupConflictResolutionDTO[] = Object.entries(syncResolutions).map(
        ([key, action]) => ({ key, action })
      );
      const input = {
        peerBaseUrl: syncPeerUrl,
        mode: syncMode,
        phase: "execute" as const,
        previewId: syncPreview.preview.previewId,
        conflictResolutions
      };
      const result = pendingSyncDirection === "pull"
        ? await api.sync.pull(input)
        : await api.sync.push(input);

      addSyncRecord(result);

      if (pendingSyncDirection === "pull") {
        applyLoadedSettings(await api.settings.get());
        setStatus(copy.syncPulled(result.summary!));
      } else {
        setStatus(copy.syncPushed(result.summary!));
      }
      setSyncPreview(null);
      setConfirmingSync(false);
      await loadRecoveryPoints();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : copy.syncFailed);
    } finally {
      setLoading(false);
    }
  };

  const restoreRecoveryPoint = async () => {
    if (!pendingRestorePoint) return;
    setLoading(true);
    setError(null);
    try {
      await api.backups.restoreRecoveryPoint(pendingRestorePoint.id);
      setPendingRestorePoint(null);
      applyLoadedSettings(await api.settings.get());
      await loadRecoveryPoints();
      setStatus(copy.restoreComplete);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : copy.restoreFailed);
    } finally {
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
        model: m.model,
        capabilities: "capabilities" in m ? [...m.capabilities] : undefined
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
        moduleModelPreferences: removeModuleModelPreferences(
          current.moduleModelPreferences,
          providerId,
          deleteIds
        ),
        activeModelId: deleteIds.has(current.activeModelId) ? "" : current.activeModelId
      };
    });
    setSelectedModelIds(new Set());
    setPendingBatchDelete(null);
  };

  const selectModel = (providerId: string, modelId: string) => {
    setForm((current) => {
      const provider = current.providers.find((entry) => entry.id === providerId);
      const model = provider?.models.find((entry) => entry.id === modelId);
      if (!provider || !model || !modelSupportsAiModule(provider.provider, model, "chat")) {
        return current;
      }
      return {
        ...current,
        activeProviderId: providerId,
        activeModelId: modelId
      };
    });
  };

  const setModuleModelPreference = (moduleId: AiModuleId, value: string) => {
    setForm((current) => {
      const nextPreferences = { ...(current.moduleModelPreferences ?? {}) };
      if (!value) {
        delete nextPreferences[moduleId];
      } else {
        const [providerId, modelId] = value.split("::");
        if (providerId && modelId) {
          nextPreferences[moduleId] = { providerId, modelId };
        }
      }

      return {
        ...current,
        moduleModelPreferences: nextPreferences
      };
    });
  };

  const updateModelCapabilities = (
    providerId: string,
    modelId: string,
    capability: AiModelCapability,
    enabled: boolean
  ) => {
    setForm((current) => ({
      ...current,
      providers: current.providers.map((provider) =>
        provider.id !== providerId
          ? provider
          : {
              ...provider,
              models: provider.models.map((model) => {
                if (model.id !== modelId) return model;
                const currentCapabilities = getAiModelCapabilities(model);
                const capabilities = enabled
                  ? [...new Set([...currentCapabilities, capability])]
                  : currentCapabilities.filter((entry) => entry !== capability);
                return { ...model, capabilities };
              })
            }
      )
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
    <div className="mx-auto max-w-7xl space-y-6">
      <ErrorNotice message={error} />
      <SuccessNotice message={status} />

      <section className="border-b border-white/[0.08] pb-6">
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

          <div className="flex h-full flex-col gap-4 border-l border-white/[0.1] px-4 py-2 xl:px-5">
            <div className="space-y-2">
              <div className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
                {copy.changesStatus}
              </div>
              <div
                className={`inline-flex min-h-[30px] items-center rounded-md px-2.5 text-xs font-semibold ${
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
                data-testid="settings-save"
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

      <div className="border-b border-white/[0.08]">
        <div className="flex gap-1 overflow-x-auto">
          {([
            ["runtime", copy.runtimeTitle],
            ["providers", copy.providersTitle],
            ["backup", copy.backupTitle],
            ["about", copy.aboutTitle]
          ] as const).map(([section, label]) => {
            const active = activeSection === section;

            return (
              <button
                aria-pressed={active}
                key={section}
                className={`min-h-[44px] min-w-[7.5rem] flex-none whitespace-nowrap border-b-2 px-2 text-xs font-medium transition-colors sm:min-w-0 sm:flex-1 sm:px-4 sm:text-sm ${
                  active
                    ? "border-ember-400 text-ember-200"
                    : "border-transparent text-ink-400 hover:bg-white/[0.035] hover:text-ink-100"
                }`}
                data-testid={`settings-section-${section}`}
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
                className={`max-w-full truncate rounded-md px-3 py-1 text-xs font-medium text-ink-200 ${settingsSurfaceClassName}`}
                title={`${copy.activeModel}: ${activeModelName}`}
              >
                {`${copy.activeModel}: ${activeModelName}`}
              </div>
            ) : undefined
          }
        >
          <div className="space-y-6">
            <p className="text-sm leading-6 text-slate-400">{copy.runtimeHelp}</p>

            <div className={`rounded-lg p-4 ${settingsSurfaceClassName}`}>
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
                <Field label={t("settings.language")}>
                  <select
                    className={selectClassName}
                    value={form.language}
                    onChange={(event) => {
                      const nextLanguage = event.target.value as AppLanguage;
                      setForm((current) => ({
                        ...current,
                        language: nextLanguage
                      }));
                      setLanguage(nextLanguage);
                    }}
                  >
                    {languageOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </Field>
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
                <Field label={language === "zh-CN" ? "消息时间" : "Message timestamps"}>
                  <label className="flex min-h-[40px] cursor-pointer items-center gap-3 rounded-lg border border-white/10 bg-ink-950/50 px-3 text-sm text-slate-100 transition-all hover:border-white/20">
                    <input
                      checked={form.showMessageTimestamps ?? false}
                      type="checkbox"
                      className="rounded border-white/20 bg-ink-950 text-ember-500 focus:ring-ember-500/50"
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          showMessageTimestamps: event.target.checked
                        }))
                      }
                    />
                    <span className="text-sm text-slate-200">
                      {language === "zh-CN" ? "在每条聊天消息下显示发送时间" : "Show the sent time below each chat message"}
                    </span>
                  </label>
                </Field>
              </div>
              <div className={`border-t py-6 ${settingsDividerClassName}`}>
                <SettingsSectionHeading
                  title={t("settings.voicePlayback")}
                  description={t("settings.voicePlaybackHelp")}
                />
                <div className="mt-5 grid gap-5 md:grid-cols-3">
                  <Field label={t("settings.ttsVoice")}>
                    <TextInput
                      aria-label={t("settings.ttsVoice")}
                      data-testid="settings-tts-voice"
                      list="tts-voice-options"
                      maxLength={80}
                      value={form.ttsVoice ?? "alloy"}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          ttsVoice: event.target.value
                        }))
                      }
                    />
                    <datalist id="tts-voice-options">
                      {['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'].map((voice) => (
                        <option key={voice} value={voice} />
                      ))}
                    </datalist>
                  </Field>
                  <Field label={t("settings.ttsPlaybackRate")}>
                    <TextInput
                      aria-label={t("settings.ttsPlaybackRate")}
                      data-testid="settings-tts-playback-rate"
                      max={2}
                      min={0.5}
                      step={0.1}
                      type="number"
                      value={form.ttsPlaybackRate ?? 1}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          ttsPlaybackRate: Number(event.target.value)
                        }))
                      }
                      onBlur={() =>
                        setForm((current) => ({
                          ...current,
                          ttsPlaybackRate: Math.min(
                            2,
                            Math.max(0.5, current.ttsPlaybackRate || 1)
                          )
                        }))
                      }
                    />
                  </Field>
                  <Field label={t("settings.ttsAutoPlay")}>
                    <label className="flex min-h-[40px] cursor-pointer items-center gap-3 rounded-lg border border-white/10 bg-ink-950/50 px-3 text-sm text-slate-100 transition-all hover:border-white/20 sm:min-h-[44px]">
                      <input
                        checked={form.ttsAutoPlay ?? false}
                        data-testid="settings-tts-auto-play"
                        type="checkbox"
                        className="rounded border-white/20 bg-ink-950 text-ember-500 focus:ring-ember-500/50"
                        onChange={(event) =>
                          setForm((current) => ({
                            ...current,
                            ttsAutoPlay: event.target.checked
                          }))
                        }
                      />
                      <span className="text-sm text-slate-200">
                        {t("settings.ttsAutoPlayHelp")}
                      </span>
                    </label>
                  </Field>
                </div>
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

            {showSetupGuide ? (
              <section
                className="scroll-mt-4 border-y border-white/[0.08] py-4"
                data-settings-setup-focus={settingsLocation.focus ?? "none"}
                data-testid="settings-setup-guide"
                ref={setupGuideRef}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-100">
                      {t("settings.setupTitle")}
                    </h3>
                    <p className="mt-1 text-xs leading-5 text-slate-500">
                      {t("settings.setupHelp")}
                    </p>
                  </div>
                  <SettingsBadge>
                    {t("settings.setupProgress", {
                      current: setupReadyCount,
                      total: setupSteps.length
                    })}
                  </SettingsBadge>
                </div>
                <div className="mt-4 grid gap-3 md:grid-cols-3">
                  {setupSteps.map((step) => {
                    const focused = settingsLocation.focus === step.id;
                    const StepIcon = step.ready ? CheckCircle2 : Circle;

                    return (
                      <div
                        aria-current={focused ? "step" : undefined}
                        className={`border-l-2 pl-3 ${
                          step.ready
                            ? "border-emerald-400/60"
                            : focused
                              ? "border-amber-300"
                              : "border-white/[0.1]"
                        }`}
                        data-setup-focused={focused ? "true" : "false"}
                        data-setup-ready={step.ready ? "true" : "false"}
                        data-setup-step={step.id}
                        key={step.id}
                      >
                        <div className="flex items-center gap-2">
                          <StepIcon
                            aria-hidden="true"
                            className={step.ready ? "text-emerald-300" : "text-slate-500"}
                            size={15}
                          />
                          <p className="text-sm font-medium text-slate-200">{step.title}</p>
                        </div>
                        <p className="mt-1 text-xs leading-5 text-slate-500">{step.detail}</p>
                      </div>
                    );
                  })}
                </div>
              </section>
            ) : null}

            {form.providers.length > 0 ? (
              <div className={`rounded-lg border p-4 ${settingsSurfaceClassName}`}>
                <div className="mb-3 flex flex-col gap-1">
                  <h3 className="text-sm font-semibold text-slate-100">
                    {language === "zh-CN" ? "模块模型" : "Module models"}
                  </h3>
                  <p className="text-xs leading-5 text-slate-500">
                    {language === "zh-CN"
                      ? "仅显示已标注兼容该功能的模型；留空则使用当前聊天模型。"
                      : "Only compatible models are shown. Leave blank to use the current chat model."}
                  </p>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  {moduleModelRows.map((row) => {
                    const selected = form.moduleModelPreferences?.[row.id];
                    const value = selected ? `${selected.providerId}::${selected.modelId}` : "";
                    const focused = focusedModuleId === row.id;
                    const compatibleModels = form.providers.flatMap((provider) =>
                      provider.models
                        .filter((model) => modelSupportsAiModule(provider.provider, model, row.id))
                        .map((model) => ({ provider, model }))
                    );
                    const activeProvider = form.providers.find(
                      (provider) => provider.id === form.activeProviderId
                    );
                    const activeModel = activeProvider?.models.find(
                      (model) => model.id === form.activeModelId
                    );
                    const fallbackCompatible = Boolean(
                      activeModel &&
                        activeProvider &&
                        modelSupportsAiModule(activeProvider.provider, activeModel, row.id)
                    );

                    return (
                      <div
                        className={`rounded-md border p-2 transition-colors ${
                          focused
                            ? "border-amber-300/50 bg-amber-400/[0.06]"
                            : "border-transparent"
                        }`}
                        data-module-model={row.id}
                        data-module-model-focused={focused ? "true" : "false"}
                        key={row.id}
                        ref={focused ? focusedModuleRowRef : undefined}
                      >
                        <Field label={language === "zh-CN" ? row.zh : row.en}>
                          <select
                            className={selectClassName}
                            value={value}
                            onChange={(event) => setModuleModelPreference(row.id, event.target.value)}
                          >
                            <option value="">
                              {fallbackCompatible
                                ? (language === "zh-CN" ? "使用当前聊天模型" : "Use current chat model")
                                : (language === "zh-CN"
                                    ? "当前聊天模型不兼容，请选择模型"
                                    : "Current chat model is incompatible; choose a model")}
                            </option>
                            {compatibleModels.map(({ provider, model }) => (
                              <option key={`${provider.id}:${model.id}`} value={`${provider.id}::${model.id}`}>
                                {`${getProviderDisplayName(provider, language)} / ${model.label || model.model}`}
                              </option>
                            ))}
                          </select>
                          {focused ? (
                            <span className="text-xs leading-5 text-amber-200">
                              {t("settings.moduleModelFocusHint")}
                            </span>
                          ) : null}
                          {compatibleModels.length === 0 ? (
                            <span className="text-xs leading-5 text-amber-300/90">
                              {language === "zh-CN"
                                ? "没有已标注支持此功能的模型。请在下方模型列表勾选对应能力，或导入兼容模型。"
                                : "No model is marked compatible. Set its capability below or import a compatible model."}
                            </span>
                          ) : null}
                        </Field>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {form.providers.length === 0 ? (
              <div className="rounded-lg border border-dashed border-white/10 bg-ink-950/25 px-4 py-8 text-center text-sm text-slate-500">
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
                      className={`rounded-lg border px-4 py-4 transition-colors ${cardClassName}`}
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
                              <div className="flex gap-2">
                                <TextInput
                                  type="password"
                                  value={provider.key ?? ""}
                                  placeholder={
                                    provider.hasKey
                                      ? language === "zh-CN"
                                        ? "已保存；输入可替换"
                                        : "Stored; enter to replace"
                                      : undefined
                                  }
                                  onChange={(event) =>
                                    updateProvider(provider.id, { key: event.target.value })
                                  }
                                />
                                {provider.hasKey && provider.key === undefined ? (
                                  <Button
                                    aria-label={language === "zh-CN" ? "清除专用 API Key" : "Clear dedicated API key"}
                                    className="!min-h-[40px] !w-10 !px-0"
                                    title={language === "zh-CN" ? "清除专用 API Key" : "Clear dedicated API key"}
                                    variant="secondary"
                                    onClick={() => updateProvider(provider.id, { key: "" })}
                                  >
                                    <X size={16} />
                                  </Button>
                                ) : null}
                              </div>
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
                                  const supportsChat = modelSupportsAiModule(provider.provider, model, "chat");
                                  const capabilities = getAiModelCapabilities(model);

                                  return (
                                    <div
                                      key={model.id}
                                      className={`group flex flex-wrap items-center gap-2.5 rounded-lg border px-3 py-2 transition-all ${
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
                                        disabled={manageMode || !supportsChat}
                                        title={
                                          supportsChat
                                            ? (language === "zh-CN" ? "设为当前聊天模型" : "Set as current chat model")
                                            : (language === "zh-CN" ? "该模型不支持文本聊天" : "This model does not support text chat")
                                        }
                                        type="button"
                                        onClick={() => selectModel(provider.id, model.id)}
                                      />
                                      <TextInput
                                        className={`!min-h-[30px] !min-w-40 !flex-1 !border-0 !bg-transparent !px-1 !py-1 font-mono text-xs ${manageMode ? "pointer-events-none opacity-40" : ""}`}
                                        disabled={manageMode}
                                        placeholder={copy.modelId}
                                        value={model.model}
                                        onChange={(event) =>
                                          updateModel(provider.id, model.id, { model: event.target.value, label: event.target.value })
                                        }
                                      />
                                      <TextInput
                                        aria-label={t("settings.contextWindow")}
                                        className={`!min-h-[30px] !w-24 !shrink-0 !px-2 !py-1 font-mono text-xs ${manageMode ? "pointer-events-none opacity-40" : ""}`}
                                        disabled={manageMode}
                                        max={10_000_000}
                                        min={256}
                                        placeholder={language === "zh-CN" ? "上下文" : "Context"}
                                        step={1024}
                                        title={t("help.contextWindow")}
                                        type="number"
                                        value={model.contextWindow ?? ""}
                                        onChange={(event) =>
                                          updateModel(provider.id, model.id, {
                                            contextWindow: event.target.value
                                              ? Number(event.target.value)
                                              : undefined
                                          })
                                        }
                                      />
                                      <div className="flex min-w-full flex-wrap items-center gap-x-2 gap-y-1 border-t border-white/10 pt-2 text-[11px] text-slate-400 sm:min-w-0 sm:border-l sm:border-t-0 sm:pl-2 sm:pt-0">
                                        {modelCapabilityRows.map((capability) => (
                                          <label key={capability.id} className="flex cursor-pointer items-center gap-1 whitespace-nowrap">
                                            <input
                                              checked={capabilities.includes(capability.id)}
                                              className="rounded border-white/20 bg-ink-950 text-ember-500 focus:ring-ember-500/50"
                                              disabled={manageMode}
                                              type="checkbox"
                                              onChange={(event) =>
                                                updateModelCapabilities(
                                                  provider.id,
                                                  model.id,
                                                  capability.id,
                                                  event.target.checked
                                                )
                                              }
                                            />
                                            {language === "zh-CN" ? capability.zh : capability.en}
                                          </label>
                                        ))}
                                      </div>
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

            <div className="sticky bottom-0 z-10 flex flex-col gap-2 border-t border-white/[0.1] bg-ink-900/95 py-3 backdrop-blur sm:flex-row sm:justify-end">
              <Button
                data-testid="settings-provider-save"
                disabled={loading || !hasUnsavedChanges}
                onClick={() => void saveSettings()}
              >
                <Save size={16} />
                {copy.saveReady}
              </Button>
              <Button
                data-testid="settings-provider-test"
                disabled={loading || hasUnsavedChanges || !setupModelReady}
                variant="secondary"
                onClick={() => void testBackend()}
              >
                <ServerCog size={16} />
                {t("settings.testModel")}
              </Button>
            </div>
          </div>
        </Panel>
      ) : null}

      {activeSection === "backup" ? (
        <Panel className={settingsPanelClassName} title={copy.backupTitle}>
          <div className="space-y-6">
            <p className="text-sm leading-6 text-slate-400">{copy.backupHelp}</p>
            <div className={`rounded-lg p-3 text-xs leading-5 text-slate-400 ${settingsSurfaceClassName}`}>
              <div className="font-medium text-slate-200">{copy.workflowSteps}</div>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <span>{copy.lastBackup}: {lastBackupAt ? new Date(lastBackupAt).toLocaleString(language === "zh-CN" ? "zh-CN" : "en-US") : copy.never}</span>
                <span>{copy.lastRecovery}: {recoveryPoints[0] ? new Date(recoveryPoints[0].createdAt).toLocaleString(language === "zh-CN" ? "zh-CN" : "en-US") : copy.never}</span>
              </div>
            </div>

            <Field label={t("settings.importMode")}>
              <select
                className={selectClassName}
                value={importMode}
                onChange={(event) => {
                  setImportMode(event.target.value as "merge" | "replace");
                  setPendingImportFile(null);
                  setPendingImportData(null);
                  setBackupPreview(null);
                }}
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
                  void prepareBackupImport(file);
                }}
              />
            </div>

            {backupPreview ? (
              <div data-testid="backup-impact-preview" className={`space-y-4 rounded-lg p-4 ${settingsSurfaceClassName}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-semibold text-slate-100">{copy.previewTitle}</div>
                  <SettingsBadge>{copy.syncModeLabel(backupPreview.mode)}</SettingsBadge>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                  {previewCountFields.map((field) => (
                    <div key={field} className="rounded-md border border-white/5 bg-black/10 p-2 text-center">
                      <div className="text-lg font-semibold text-slate-100">{backupPreview.counts[field]}</div>
                      <div className="text-xs text-slate-500">{copy.previewCounts[field]}</div>
                    </div>
                  ))}
                </div>
                <p className={`text-sm ${backupPreview.canExecute ? "text-emerald-300" : "text-amber-300"}`}>
                  {backupPreview.canExecute ? copy.previewReady : copy.previewBlocked}
                </p>
                {backupPreview.mode === "replace" ? (
                  <p className="rounded-md border border-red-400/20 bg-red-400/5 p-3 text-sm leading-6 text-red-200">{copy.replaceDanger}</p>
                ) : null}
                {backupPreview.issues.length ? (
                  <div>
                    <div className="mb-2 text-sm font-medium text-amber-200">{copy.previewIssues}</div>
                    <ul className="space-y-1 text-sm text-amber-100/80">
                      {backupPreview.issues.map((issue, index) => <li key={`${issue.entity}-${issue.index}-${index}`}>• {issue.message}</li>)}
                    </ul>
                  </div>
                ) : null}
                {backupPreview.mode === "merge" && backupPreview.conflicts.length ? (
                  <div className="space-y-2">
                    <div className="text-sm font-medium text-slate-200">{copy.conflictResolution}</div>
                    {backupPreview.conflicts.map((conflict, index) => (
                      <div key={conflict.key} className="grid gap-2 rounded-md border border-white/5 p-2 sm:grid-cols-[minmax(0,1fr)_220px] sm:items-center">
                        <span className="font-mono text-xs text-slate-400">{conflict.entity} · {conflict.id.slice(-12)}</span>
                        <select
                          aria-label={`${copy.conflictResolution} ${index + 1}`}
                          className={selectClassName}
                          value={importResolutions[conflict.key] ?? ""}
                          onChange={(event) => setImportResolutions((current) => ({ ...current, [conflict.key]: event.target.value as BackupConflictAction }))}
                        >
                          <option value="">{copy.conflictResolution}</option>
                          <option value="keep_existing">{copy.keepExisting}</option>
                          <option value="use_incoming">{copy.useIncomingBackup}</option>
                          <option value="skip">{copy.skipConflict}</option>
                        </select>
                      </div>
                    ))}
                  </div>
                ) : null}
                <Button
                  data-testid="backup-confirm-import"
                  disabled={loading || !backupPreview.canExecute || (backupPreview.mode === "merge" && backupPreview.conflicts.some((conflict) => !importResolutions[conflict.key]))}
                  variant={backupPreview.mode === "replace" ? "danger" : "secondary"}
                  onClick={() => setConfirmingImport(true)}
                >
                  {copy.confirmImport}
                </Button>
              </div>
            ) : null}

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
                    onChange={(event) => {
                      setSyncPeerUrl(event.target.value);
                      setSyncPreview(null);
                      setPendingSyncDirection(null);
                    }}
                  />
                </Field>
                <Field label={copy.syncMode}>
                  <select
                    className={selectClassName}
                    value={syncMode}
                    onChange={(event) => {
                      setSyncMode(event.target.value as "merge" | "replace");
                      setSyncPreview(null);
                      setPendingSyncDirection(null);
                    }}
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
                  onClick={() => void prepareLanSync("pull")}
                >
                  <ArrowDownToLine size={16} />
                  {copy.syncPull}
                </Button>
                <Button
                  disabled={loading}
                  variant="secondary"
                  onClick={() => void prepareLanSync("push")}
                >
                  <ArrowUpFromLine size={16} />
                  {copy.syncPush}
                </Button>
              </div>

              {syncPreview && pendingSyncDirection ? (
                <div data-testid="sync-impact-preview" className={`mt-4 space-y-4 rounded-lg p-4 ${settingsSurfaceClassName}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-semibold text-slate-100">{copy.previewTitle}</div>
                    <div className="flex gap-2"><SettingsBadge>{copy.syncDirection(pendingSyncDirection)}</SettingsBadge><SettingsBadge>{copy.syncModeLabel(syncPreview.mode)}</SettingsBadge></div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                    {previewCountFields.map((field) => (
                      <div key={field} className="rounded-md border border-white/5 bg-black/10 p-2 text-center">
                        <div className="text-lg font-semibold text-slate-100">{syncPreview.preview.counts[field]}</div>
                        <div className="text-xs text-slate-500">{copy.previewCounts[field]}</div>
                      </div>
                    ))}
                  </div>
                  <p className={`text-sm ${syncPreview.preview.canExecute ? "text-emerald-300" : "text-amber-300"}`}>
                    {syncPreview.preview.canExecute ? copy.previewReady : copy.previewBlocked}
                  </p>
                  {syncPreview.mode === "replace" ? <p className="rounded-md border border-red-400/20 bg-red-400/5 p-3 text-sm text-red-200">{copy.replaceDanger}</p> : null}
                  {syncPreview.preview.issues.length ? (
                    <ul className="space-y-1 text-sm text-amber-100/80">{syncPreview.preview.issues.map((issue, index) => <li key={`${issue.entity}-${issue.index}-${index}`}>• {issue.message}</li>)}</ul>
                  ) : null}
                  {syncPreview.mode === "merge" && syncPreview.preview.conflicts.length ? (
                    <div className="space-y-2">
                      <div className="text-sm font-medium text-slate-200">{copy.conflictResolution}</div>
                      {syncPreview.preview.conflicts.map((conflict, index) => {
                        const localAction = pendingSyncDirection === "pull" ? "keep_existing" : "use_incoming";
                        const peerAction = pendingSyncDirection === "pull" ? "use_incoming" : "keep_existing";
                        return (
                          <div key={conflict.key} className="grid gap-2 rounded-md border border-white/5 p-2 sm:grid-cols-[minmax(0,1fr)_220px] sm:items-center">
                            <span className="font-mono text-xs text-slate-400">{conflict.entity} · {conflict.id.slice(-12)}</span>
                            <select
                              aria-label={`${copy.conflictResolution} ${index + 1}`}
                              className={selectClassName}
                              value={syncResolutions[conflict.key] ?? ""}
                              onChange={(event) => setSyncResolutions((current) => ({ ...current, [conflict.key]: event.target.value as BackupConflictAction }))}
                            >
                              <option value="">{copy.conflictResolution}</option>
                              <option value={localAction}>{copy.useLocal}</option>
                              <option value={peerAction}>{copy.usePeer}</option>
                              <option value="skip">{copy.skipConflict}</option>
                            </select>
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                  <Button
                    data-testid="sync-confirm-execute"
                    disabled={loading || !syncPreview.preview.canExecute || (syncPreview.mode === "merge" && syncPreview.preview.conflicts.some((conflict) => !syncResolutions[conflict.key]))}
                    variant={syncPreview.mode === "replace" ? "danger" : "secondary"}
                    onClick={() => setConfirmingSync(true)}
                  >{copy.confirmSync}</Button>
                </div>
              ) : null}
            </div>

            <div className={`border-t pt-6 ${settingsDividerClassName}`}>
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-100"><History size={16} className="text-slate-400" />{copy.recoveryTitle}</div>
              {recoveryPoints.length === 0 ? (
                <div className={`rounded-lg px-4 py-5 text-center text-sm text-slate-500 ${settingsSurfaceClassName}`}>{copy.recoveryEmpty}</div>
              ) : (
                <div className="space-y-2">
                  {recoveryPoints.map((point) => (
                    <div key={point.id} className={`grid gap-3 rounded-lg p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center ${settingsSurfaceClassName}`}>
                      <div>
                        <div className="flex flex-wrap gap-2"><SettingsBadge>{copy.recoveryReason(point.reason)}</SettingsBadge><span className="text-sm text-slate-300">{new Date(point.createdAt).toLocaleString(language === "zh-CN" ? "zh-CN" : "en-US")}</span></div>
                        <div className="mt-2 font-mono text-xs text-slate-500">{point.summary.characters} / {point.summary.chats} / {point.summary.messages} / {point.summary.memories}</div>
                      </div>
                      <Button variant="secondary" onClick={() => setPendingRestorePoint(point)}>{copy.restore}</Button>
                    </div>
                  ))}
                </div>
              )}
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

      {activeSection === "about" ? <AboutUpdatesPanel language={language} /> : null}

      {confirmingImport && pendingImportFile && backupPreview ? (
        <ConfirmDialog
          cancelLabel={t("common.cancel")}
          confirmLabel={t("common.confirm")}
          loading={loading}
          message={backupPreview.mode === "replace" ? copy.replaceDanger : t("settings.importBackupConfirm")}
          title={t("settings.importBackupTitle")}
          variant={backupPreview.mode === "replace" ? "danger" : "primary"}
          onCancel={() => setConfirmingImport(false)}
          onConfirm={() => void importBackup()}
        />
      ) : null}

      {confirmingSync && pendingSyncDirection && syncPreview ? (
        <ConfirmDialog
          cancelLabel={t("common.cancel")}
          confirmLabel={t("common.confirm")}
          loading={loading}
          message={
            pendingSyncDirection === "pull" ? copy.syncPullConfirm : copy.syncPushConfirm
          }
          title={copy.syncTitle}
          variant={syncPreview.mode === "replace" ? "danger" : "primary"}
          onCancel={() => setConfirmingSync(false)}
          onConfirm={() => void runLanSync()}
        />
      ) : null}

      {pendingRestorePoint ? (
        <ConfirmDialog
          cancelLabel={t("common.cancel")}
          confirmLabel={copy.restore}
          loading={loading}
          message={copy.restoreConfirm}
          title={copy.recoveryTitle}
          variant="danger"
          onCancel={() => setPendingRestorePoint(null)}
          onConfirm={() => void restoreRecoveryPoint()}
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
              moduleModelPreferences: removeModuleModelPreferences(
                current.moduleModelPreferences,
                pendingDeleteProviderId
              ),
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
              moduleModelPreferences: removeModuleModelPreferences(
                current.moduleModelPreferences,
                pendingDeleteModel.providerId,
                new Set([pendingDeleteModel.modelId])
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
                className="fixed z-50 max-h-80 w-64 overflow-y-auto rounded-lg border border-white/10 bg-ink-900 p-1 shadow-xl shadow-black/30"
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
