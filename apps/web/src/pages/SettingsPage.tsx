import {
  ChevronDown,
  ChevronRight,
  Download,
  FileUp,
  Plus,
  Save,
  ServerCog,
  Trash2,
  Wrench
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { languageOptions, useI18n } from "../i18n";
import { api } from "../lib/api";
import { downloadJson, readFileText } from "../lib/files";
import { generateId } from "../lib/uuid";
import { useAppStore } from "../store/useAppStore";
import type { AppLanguage, ModelPreset, SettingsInput } from "../types";
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
  model: "gpt-4o-mini",
  temperature: 0.8,
  maxTokens: 800,
  topP: 1,
  language: "zh-CN",
  models: [],
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

const serializeForm = (form: SettingsInput) => JSON.stringify(form);

const isValidUrl = (value: string) => {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
};

const getPresetDisplayName = (preset: ModelPreset, language: AppLanguage) => {
  const label = preset.label.trim();
  if (label) {
    return label;
  }

  const model = preset.model.trim();
  if (model) {
    return model;
  }

  return language === "zh-CN" ? "未命名预设" : "Untitled preset";
};

const createPresetLabel = (form: SettingsInput, language: AppLanguage) =>
  form.model.trim() || (language === "zh-CN" ? "新预设" : "New Preset");

const getPageCopy = (language: AppLanguage) =>
  language === "zh-CN"
    ? {
        runtimeTitle: "当前运行配置",
        runtimeHelp: "这里决定当前聊天实际使用的供应商、模型与采样参数。",
        providerStatus: "当前供应商",
        modelStatus: "当前模型",
        apiKeyStatus: "API Key",
        changesStatus: "更改状态",
        presetsStatus: "预设数量",
        keyStored: "已保存",
        keyPendingRemoval: "待清除",
        keyMissing: "未保存",
        changesDirty: "未保存更改",
        changesClean: "已同步",
        presetCount: (count: number) => `${count} 个`,
        proxyNote: "所有模型请求都通过后端代理发出，前端不会直连模型供应商。",
        clearKey: "清除已保存 Key",
        clearKeyUndo: "保留已保存 Key",
        runtimeBlockTitle: "连接信息",
        samplingBlockTitle: "采样参数",
        presetsTitle: "模型预设库",
        presetsHelp: "保存常用组合，聊天页会直接读取这里的预设进行模型切换。",
        addPreset: "添加预设",
        applyPreset: "应用到当前配置",
        activePreset: "当前使用",
        presetLabel: "预设名称",
        presetProvider: "供应商",
        presetUrl: "API Base URL",
        presetModel: "模型",
        presetKey: "专用 API Key（可选）",
        presetEmpty: "还没有预设。把当前运行配置保存成一个常用组合会更顺手。",
        presetDeleteTitle: "删除模型预设",
        presetDeleteConfirm: (name: string) => `删除预设“${name}”？`,
        presetApplied: (name: string) => `已载入预设“${name}”`,
        backupTitle: "备份与迁移",
        backupHelp:
          "完整备份会导出角色、聊天、消息和世界书；设置仅导出模型参数，不包含 API Key。",
        saveReady: "保存到本地",
        noPendingChanges: "当前没有待保存更改",
        validationPreset:
          "请先补全每个预设的名称、供应商、API Base URL 和模型，且 API Base URL 必须是有效地址。"
      }
    : {
        runtimeTitle: "Active Runtime",
        runtimeHelp: "These values define the provider, model, and sampling settings used by chat right now.",
        providerStatus: "Provider",
        modelStatus: "Model",
        apiKeyStatus: "API Key",
        changesStatus: "Change State",
        presetsStatus: "Preset Count",
        keyStored: "Stored",
        keyPendingRemoval: "Pending removal",
        keyMissing: "Not stored",
        changesDirty: "Unsaved changes",
        changesClean: "Synced",
        presetCount: (count: number) => `${count}`,
        proxyNote: "All model requests go through the backend proxy. The frontend never calls providers directly.",
        clearKey: "Clear stored key",
        clearKeyUndo: "Keep stored key",
        runtimeBlockTitle: "Connection",
        samplingBlockTitle: "Sampling",
        presetsTitle: "Model Presets",
        presetsHelp: "Save reusable provider/model combinations. The chat page reads this list directly for model switching.",
        addPreset: "Add Preset",
        applyPreset: "Apply to Runtime",
        activePreset: "Active",
        presetLabel: "Preset Name",
        presetProvider: "Provider",
        presetUrl: "API Base URL",
        presetModel: "Model",
        presetKey: "Dedicated API Key (optional)",
        presetEmpty: "No presets yet. Saving the current runtime as a reusable combination will help here.",
        presetDeleteTitle: "Delete Model Preset",
        presetDeleteConfirm: (name: string) => `Delete preset "${name}"?`,
        presetApplied: (name: string) => `Loaded preset "${name}"`,
        backupTitle: "Backup & Migration",
        backupHelp:
          "Full backups export characters, chats, messages, and lorebooks. Settings export model parameters but never the API key.",
        saveReady: "Save locally",
        noPendingChanges: "No pending changes",
        validationPreset:
          "Complete every preset name, provider, API base URL, and model before saving. API base URLs must be valid URLs."
      };

type SettingsSection = "runtime" | "presets" | "backup";

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

export function SettingsPage() {
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
  const [pendingImportFile, setPendingImportFile] = useState<File | null>(null);
  const [pendingDeletePresetId, setPendingDeletePresetId] = useState<string | null>(null);
  const [expandedPresetId, setExpandedPresetId] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<SettingsSection>("runtime");

  useEffect(() => {
    void api.settings
      .get()
      .then((settings) => {
        const nextForm: SettingsInput = {
          activeProvider: settings.activeProvider,
          apiBaseUrl: settings.apiBaseUrl,
          apiKey: "",
          model: settings.model,
          temperature: settings.temperature,
          maxTokens: settings.maxTokens,
          topP: settings.topP,
          language: settings.language,
          models: settings.models ?? [],
          showMessageAvatars: settings.showMessageAvatars,
          userProfileSummary: settings.userProfileSummary ?? ""
        };
        setForm(nextForm);
        setSavedSnapshot(serializeForm(nextForm));
        setLanguage(settings.language);
        setShowMessageAvatars(settings.showMessageAvatars);
        setHasApiKey(settings.hasApiKey);
        setClearStoredApiKey(false);
      })
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : "Failed to load settings")
      );
  }, [setLanguage, setShowMessageAvatars]);

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

  const activePreset = useMemo(
    () =>
      form.models.find(
        (preset) =>
          preset.provider === form.activeProvider &&
          preset.apiBaseUrl === form.apiBaseUrl &&
          preset.model === form.model
      ) ?? null,
    [form.activeProvider, form.apiBaseUrl, form.model, form.models]
  );

  const pendingDeletePreset = useMemo(
    () =>
      pendingDeletePresetId
        ? form.models.find((preset) => preset.id === pendingDeletePresetId) ?? null
        : null,
    [form.models, pendingDeletePresetId]
  );

  useEffect(() => {
    setExpandedPresetId((current) => {
      const currentStillExists = current ? form.models.some((preset) => preset.id === current) : false;
      if (currentStillExists) {
        return current;
      }

      return (
        form.models.find(
          (preset) =>
            preset.provider === form.activeProvider &&
            preset.apiBaseUrl === form.apiBaseUrl &&
            preset.model === form.model
        )?.id ??
        form.models[0]?.id ??
        null
      );
    });
  }, [form.activeProvider, form.apiBaseUrl, form.model, form.models]);

  const saveSettings = async () => {
    const hasInvalidPreset = form.models.some(
      (preset) =>
        !preset.label.trim() ||
        !preset.provider.trim() ||
        !preset.model.trim() ||
        !isValidUrl(preset.apiBaseUrl)
    );

    if (hasInvalidPreset) {
      setError(copy.validationPreset);
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
        models: settings.models ?? [],
        showMessageAvatars: settings.showMessageAvatars
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

  const applyPreset = (preset: ModelPreset) => {
    setForm((current) => ({
      ...current,
      activeProvider: preset.provider,
      apiBaseUrl: preset.apiBaseUrl,
      model: preset.model,
      apiKey: preset.key ?? ""
    }));
    setClearStoredApiKey(false);
    setExpandedPresetId(preset.id);
    setStatus(copy.presetApplied(getPresetDisplayName(preset, language)));
  };

  const addPreset = () => {
    const nextPreset: ModelPreset = {
      id: generateId(),
      label: createPresetLabel(form, language),
      provider: form.activeProvider,
      apiBaseUrl: form.apiBaseUrl,
      model: form.model,
      key: form.apiKey?.trim() ? form.apiKey : undefined
    };

    setForm((current) => ({
      ...current,
      models: [...current.models, nextPreset]
    }));
    setExpandedPresetId(nextPreset.id);
    setActiveSection("presets");
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
              value={form.activeProvider || t("common.unknown")}
            />
            <SummaryCard
              label={copy.modelStatus}
              value={form.model || t("common.unknown")}
              tone={activePreset ? "emerald" : "default"}
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
              label={copy.presetsStatus}
              value={copy.presetCount(form.models.length)}
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
            ["presets", copy.presetsTitle],
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
            activePreset ? (
              <div
                className={`max-w-full truncate rounded-full px-3 py-1 text-xs font-medium text-slate-200 ${settingsSurfaceClassName}`}
                title={`${copy.activePreset}: ${getPresetDisplayName(activePreset, language)}`}
              >
                {`${copy.activePreset}: ${getPresetDisplayName(activePreset, language)}`}
              </div>
            ) : undefined
          }
        >
          <div className="space-y-6">
            <SettingsSectionHeading title={copy.runtimeBlockTitle} description={copy.runtimeHelp} />

            <div className="grid gap-5 md:grid-cols-2">
              <Field
                label={<HelpLabel label={t("settings.provider")} description={t("help.provider")} />}
              >
                <TextInput
                  value={form.activeProvider}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, activeProvider: event.target.value }))
                  }
                />
              </Field>
              <Field
                label={
                  <HelpLabel
                    label={t("settings.apiBaseUrl")}
                    description={t("help.apiBaseUrl")}
                  />
                }
              >
                <TextInput
                  value={form.apiBaseUrl}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, apiBaseUrl: event.target.value }))
                  }
                />
              </Field>
            </div>

            <Field label={<HelpLabel label={t("settings.apiKey")} description={t("help.apiKey")} />}>
              <div className="space-y-3">
                <TextInput
                  placeholder={
                    hasApiKey
                      ? t("settings.apiKeyPlaceholderStored")
                      : t("settings.apiKeyPlaceholderEmpty")
                  }
                  type="password"
                  value={form.apiKey}
                  onChange={(event) => {
                    const value = event.target.value;
                    setForm((current) => ({ ...current, apiKey: value }));
                    if (value.trim()) {
                      setClearStoredApiKey(false);
                    }
                  }}
                />
                {hasApiKey ? (
                  <div className="flex flex-wrap items-center gap-3">
                    <SettingsBadge>
                      {clearStoredApiKey ? copy.keyPendingRemoval : copy.keyStored}
                    </SettingsBadge>
                    <Button
                      className="!min-h-[34px] !px-3 text-xs"
                      variant={clearStoredApiKey ? "secondary" : "ghost"}
                      onClick={() => {
                        setClearStoredApiKey((current) => !current);
                        setForm((current) => ({ ...current, apiKey: "" }));
                      }}
                    >
                      {clearStoredApiKey ? copy.clearKeyUndo : copy.clearKey}
                    </Button>
                  </div>
                ) : null}
              </div>
            </Field>

            <div className="grid gap-5 md:grid-cols-2">
              <Field label={<HelpLabel label={t("settings.model")} description={t("help.model")} />}>
                <TextInput
                  value={form.model}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, model: event.target.value }))
                  }
                />
              </Field>
              <Field label={t("settings.language")}>
                <select
                  className={selectClassName}
                  value={form.language}
                  onChange={(event) => {
                    const nextLanguage = event.target.value as SettingsInput["language"];
                    setForm((current) => ({ ...current, language: nextLanguage }));
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
                    type="number"
                    value={form.temperature}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        temperature: Number(event.target.value)
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
                    type="number"
                    value={form.maxTokens}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        maxTokens: Number(event.target.value)
                      }))
                    }
                  />
                </Field>
                <Field
                  label={<HelpLabel label={t("settings.topP")} description={t("help.topP")} />}
                >
                  <TextInput
                    step="0.05"
                    type="number"
                    value={form.topP}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, topP: Number(event.target.value) }))
                    }
                  />
                </Field>
              </div>
            </div>
          </div>
        </Panel>
      ) : null}

      {activeSection === "presets" ? (
        <Panel
          className={settingsPanelClassName}
          title={copy.presetsTitle}
          action={
            <Button
              className="!min-h-[34px] !px-3 text-xs"
              variant="secondary"
              onClick={addPreset}
            >
              <Plus size={14} />
              {copy.addPreset}
            </Button>
          }
        >
          <div className="space-y-4">
            <p className="text-sm leading-6 text-slate-400">{copy.presetsHelp}</p>

            {form.models.length === 0 ? (
              <div className={`rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-8 text-center text-sm text-slate-500`}>
                {copy.presetEmpty}
              </div>
            ) : (
              <div className="space-y-3">
                {form.models.map((preset, index) => {
                  const isActive =
                    preset.provider === form.activeProvider &&
                    preset.apiBaseUrl === form.apiBaseUrl &&
                    preset.model === form.model;
                  const isExpanded = expandedPresetId === preset.id;
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
                      key={preset.id}
                      className={`rounded-xl border px-4 py-4 transition-all duration-200 ${cardClassName}`}
                    >
                      <div className={`flex flex-col gap-3 border-b pb-4 md:flex-row md:items-start md:justify-between ${settingsDividerClassName}`}>
                        <div className="min-w-0 flex-1 space-y-3">
                          <button
                            className="flex w-full items-start gap-3 rounded-lg text-left outline-none transition-colors hover:text-slate-100 focus:text-slate-100"
                            type="button"
                            onClick={() =>
                              setExpandedPresetId((current) => (current === preset.id ? null : preset.id))
                            }
                          >
                            <span
                              className={`mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-colors ${toggleIconClassName}`}
                            >
                              {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                            </span>
                            <div className="min-w-0 space-y-2">
                              <div className="truncate text-sm font-semibold text-slate-100">
                                {getPresetDisplayName(preset, language)}
                              </div>
                              <div className="flex flex-wrap items-center gap-2">
                                {isActive ? <SettingsBadge>{copy.activePreset}</SettingsBadge> : null}
                                <SettingsBadge>{preset.provider || t("common.unknown")}</SettingsBadge>
                                <SettingsBadge>{preset.model || t("common.unknown")}</SettingsBadge>
                              </div>
                              <div className="truncate text-xs leading-5 text-slate-500">
                                {preset.apiBaseUrl}
                              </div>
                            </div>
                          </button>
                        </div>

                        <div className="flex flex-wrap items-center gap-2 md:shrink-0">
                          <Button
                            className="!min-h-[34px] !px-3 text-xs whitespace-nowrap hover:!bg-ink-800/75 focus:!ring-ink-700/40"
                            variant="ghost"
                            onClick={() => applyPreset(preset)}
                          >
                            <Wrench size={14} />
                            {copy.applyPreset}
                          </Button>
                          <Button
                            className="!min-h-[34px] !w-9 !p-0"
                            variant="danger"
                            onClick={() => setPendingDeletePresetId(preset.id)}
                          >
                            <Trash2 size={14} />
                          </Button>
                        </div>
                      </div>

                      <div
                        className={`overflow-hidden transition-all duration-200 ${isExpanded ? "mt-4" : ""}`}
                        aria-hidden={!isExpanded}
                        style={{
                          maxHeight: isExpanded ? "48rem" : "0px",
                          opacity: isExpanded ? 1 : 0,
                          pointerEvents: isExpanded ? "auto" : "none"
                        }}
                      >
                        <div className={`grid gap-4 border-t pt-4 md:grid-cols-2 xl:grid-cols-4 ${settingsDividerClassName}`}>
                          <Field label={copy.presetLabel}>
                            <TextInput
                              value={preset.label}
                              onChange={(event) => {
                                const nextModels = [...form.models];
                                nextModels[index] = { ...nextModels[index], label: event.target.value };
                                setForm((current) => ({ ...current, models: nextModels }));
                              }}
                            />
                          </Field>
                          <Field label={copy.presetProvider}>
                            <TextInput
                              value={preset.provider}
                              onChange={(event) => {
                                const nextModels = [...form.models];
                                nextModels[index] = { ...nextModels[index], provider: event.target.value };
                                setForm((current) => ({ ...current, models: nextModels }));
                              }}
                            />
                          </Field>
                          <Field label={copy.presetUrl}>
                            <TextInput
                              value={preset.apiBaseUrl}
                              onChange={(event) => {
                                const nextModels = [...form.models];
                                nextModels[index] = { ...nextModels[index], apiBaseUrl: event.target.value };
                                setForm((current) => ({ ...current, models: nextModels }));
                              }}
                            />
                          </Field>
                          <Field label={copy.presetModel}>
                            <TextInput
                              value={preset.model}
                              onChange={(event) => {
                                const nextModels = [...form.models];
                                nextModels[index] = { ...nextModels[index], model: event.target.value };
                                setForm((current) => ({ ...current, models: nextModels }));
                              }}
                            />
                          </Field>
                          <Field label={copy.presetKey}>
                            <TextInput
                              type="password"
                              value={preset.key ?? ""}
                              onChange={(event) => {
                                const nextModels = [...form.models];
                                nextModels[index] = {
                                  ...nextModels[index],
                                  key: event.target.value || undefined
                                };
                                setForm((current) => ({ ...current, models: nextModels }));
                              }}
                            />
                          </Field>
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

      {pendingDeletePreset ? (
        <ConfirmDialog
          cancelLabel={t("common.cancel")}
          confirmLabel={t("common.delete")}
          loading={loading}
          message={copy.presetDeleteConfirm(getPresetDisplayName(pendingDeletePreset, language))}
          title={copy.presetDeleteTitle}
          onCancel={() => setPendingDeletePresetId(null)}
          onConfirm={() => {
            setForm((current) => ({
              ...current,
              models: current.models.filter((preset) => preset.id !== pendingDeletePreset.id)
            }));
            setPendingDeletePresetId(null);
          }}
        />
      ) : null}
    </div>
  );
}
