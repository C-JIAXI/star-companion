import { Download, FileUp, PlugZap, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { languageOptions, useI18n } from "../i18n";
import { api } from "../lib/api";
import { downloadJson, readFileText } from "../lib/files";
import { useAppStore } from "../store/useAppStore";
import type { SettingsInput } from "../types";
import { Badge, Button, ConfirmDialog, ErrorNotice, Field, HelpLabel, Panel, SuccessNotice, TextInput } from "../components/ui";

const defaultForm: SettingsInput = {
  activeProvider: "openai-compatible",
  apiBaseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o-mini",
  temperature: 0.8,
  maxTokens: 800,
  topP: 1,
  language: "zh-CN"
};

export function SettingsPage() {
  const { t } = useI18n();
  const setLanguage = useAppStore((state) => state.setLanguage);
  const [form, setForm] = useState<SettingsInput>(defaultForm);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [importMode, setImportMode] = useState<"merge" | "replace">("merge");
  const [pendingImportFile, setPendingImportFile] = useState<File | null>(null);

  useEffect(() => {
    void api.settings
      .get()
      .then((settings) => {
        setForm({
          activeProvider: settings.activeProvider,
          apiBaseUrl: settings.apiBaseUrl,
          apiKey: "",
          model: settings.model,
          temperature: settings.temperature,
          maxTokens: settings.maxTokens,
          topP: settings.topP,
          language: settings.language
        });
        setLanguage(settings.language);
        setHasApiKey(settings.hasApiKey);
      })
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : t("settings.failedLoad"))
      );
  }, [setLanguage]);

  useEffect(() => {
    if (!status) {
      return;
    }

    const timeoutId = window.setTimeout(() => setStatus(null), 2200);
    return () => window.clearTimeout(timeoutId);
  }, [status]);

  const saveSettings = async () => {
    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const settings = await api.settings.update(form);
      setHasApiKey(settings.hasApiKey);
      setLanguage(settings.language);
      setForm((current) => ({ ...current, apiKey: "" }));
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
          messages: summary.messages,
          lorebooks: summary.lorebooks,
          loreEntries: summary.loreEntries
        })
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("settings.failedImportBackup"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <ErrorNotice message={error} />
      <SuccessNotice message={status} />

      <Panel title={t("settings.panelTitle")} action={hasApiKey ? <Badge>{t("common.apiKeyStored")}</Badge> : <Badge>{t("common.noApiKey")}</Badge>}>
        <div className="space-y-6">
          <div className="grid gap-5 md:grid-cols-2">
            <Field label={<HelpLabel label={t("settings.provider")} description={t("help.provider")} />}><TextInput value={form.activeProvider} onChange={(event) => setForm({ ...form, activeProvider: event.target.value })} /></Field>
            <Field label={<HelpLabel label={t("settings.apiBaseUrl")} description={t("help.apiBaseUrl")} />}><TextInput value={form.apiBaseUrl} onChange={(event) => setForm({ ...form, apiBaseUrl: event.target.value })} /></Field>
          </div>
          <Field label={<HelpLabel label={t("settings.apiKey")} description={t("help.apiKey")} />}><TextInput placeholder={hasApiKey ? t("settings.apiKeyPlaceholderStored") : t("settings.apiKeyPlaceholderEmpty")} type="password" value={form.apiKey} onChange={(event) => setForm({ ...form, apiKey: event.target.value })} /></Field>
          
          <div className="grid gap-5 md:grid-cols-2">
            <Field label={<HelpLabel label={t("settings.model")} description={t("help.model")} />}><TextInput value={form.model} onChange={(event) => setForm({ ...form, model: event.target.value })} /></Field>
            <Field label={t("settings.language")}>
              <select className="min-h-[40px] w-full rounded-lg border border-white/10 bg-ink-950/50 px-3 text-sm text-slate-100 outline-none transition-all hover:border-white/20 focus:border-ember-500 focus:bg-ink-950 focus:ring-1 focus:ring-ember-500/50" value={form.language} onChange={(event) => {
                const language = event.target.value as SettingsInput["language"];
                setForm({ ...form, language });
                setLanguage(language);
              }}>
                {languageOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </Field>
          </div>
          <div className="grid gap-5 md:grid-cols-3">
            <Field label={<HelpLabel label={t("settings.temperature")} description={t("help.temperature")} />}><TextInput step="0.1" type="number" value={form.temperature} onChange={(event) => setForm({ ...form, temperature: Number(event.target.value) })} /></Field>
            <Field label={<HelpLabel label={t("settings.maxTokens")} description={t("help.maxTokens")} />}><TextInput type="number" value={form.maxTokens} onChange={(event) => setForm({ ...form, maxTokens: Number(event.target.value) })} /></Field>
            <Field label={<HelpLabel label={t("settings.topP")} description={t("help.topP")} />}><TextInput step="0.05" type="number" value={form.topP} onChange={(event) => setForm({ ...form, topP: Number(event.target.value) })} /></Field>
          </div>
          <div className="flex flex-wrap gap-3 pt-4 border-t border-white/5">
            <Button disabled={loading} onClick={() => void saveSettings()}>
              <Save size={16} />
              {t("settings.saveSettings")}
            </Button>
            <Button disabled={loading} variant="secondary" onClick={() => void testBackend()}>
              <PlugZap size={16} />
              {t("settings.testModel")}
            </Button>
          </div>
        </div>
      </Panel>

      <Panel title={t("settings.backupPanel")}>
        <div className="space-y-6">
          <p className="text-sm leading-relaxed text-slate-400">{t("settings.backupHelp")}</p>
          <Field label={t("settings.importMode")}>
            <select className="min-h-[40px] w-full rounded-lg border border-white/10 bg-ink-950/50 px-3 text-sm text-slate-100 outline-none transition-all hover:border-white/20 focus:border-ember-500 focus:bg-ink-950 focus:ring-1 focus:ring-ember-500/50" value={importMode} onChange={(event) => setImportMode(event.target.value as "merge" | "replace")}>
              <option value="merge">{t("settings.importModeMerge")}</option>
              <option value="replace">{t("settings.importModeReplace")}</option>
            </select>
          </Field>
          <div className="flex flex-wrap gap-3 pt-2">
            <Button disabled={loading} variant="secondary" onClick={() => void exportBackup()}>
              <Download size={16} />
              {t("settings.exportBackup")}
            </Button>
            <Button disabled={loading} variant="secondary" onClick={() => document.getElementById("backup-import-input")?.click()}>
              <FileUp size={16} />
              {t("settings.importBackup")}
            </Button>
            <input id="backup-import-input" className="sr-only" type="file" accept="application/json,.json" onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              setPendingImportFile(file ?? null);
            }} />
          </div>
        </div>
      </Panel>
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
    </div>
  );
}
