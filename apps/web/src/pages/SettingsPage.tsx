import { PlugZap, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { languageOptions, useI18n } from "../i18n";
import { api } from "../lib/api";
import { useAppStore } from "../store/useAppStore";
import type { SettingsInput } from "../types";
import { Badge, Button, ErrorNotice, Field, HelpLabel, Panel, TextInput } from "../components/ui";

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
      const response = await fetch("/api/health");
      if (!response.ok) {
        throw new Error(t("settings.healthFailed", { status: response.status }));
      }
      setStatus(t("settings.backendReachable"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("settings.connectionFailed"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Panel title={t("settings.panelTitle")} action={hasApiKey ? <Badge>{t("common.apiKeyStored")}</Badge> : <Badge>{t("common.noApiKey")}</Badge>}>
      <div className="max-w-3xl space-y-4">
        <ErrorNotice message={error} />
        {status ? <div className="rounded-md border border-emerald-400/30 bg-emerald-500/10 p-3 text-sm text-emerald-100">{status}</div> : null}
        <div className="grid gap-3 md:grid-cols-2">
          <Field label={<HelpLabel label={t("settings.provider")} description={t("help.provider")} />}><TextInput value={form.activeProvider} onChange={(event) => setForm({ ...form, activeProvider: event.target.value })} /></Field>
          <Field label={<HelpLabel label={t("settings.apiBaseUrl")} description={t("help.apiBaseUrl")} />}><TextInput value={form.apiBaseUrl} onChange={(event) => setForm({ ...form, apiBaseUrl: event.target.value })} /></Field>
        </div>
        <Field label={<HelpLabel label={t("settings.apiKey")} description={t("help.apiKey")} />}><TextInput placeholder={hasApiKey ? t("settings.apiKeyPlaceholderStored") : t("settings.apiKeyPlaceholderEmpty")} type="password" value={form.apiKey} onChange={(event) => setForm({ ...form, apiKey: event.target.value })} /></Field>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label={<HelpLabel label={t("settings.model")} description={t("help.model")} />}><TextInput value={form.model} onChange={(event) => setForm({ ...form, model: event.target.value })} /></Field>
          <Field label={t("settings.language")}>
            <select className="min-h-10 rounded-md border border-white/10 bg-ink-950 px-3 text-sm text-slate-100" value={form.language} onChange={(event) => {
              const language = event.target.value as SettingsInput["language"];
              setForm({ ...form, language });
              setLanguage(language);
            }}>
              {languageOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </Field>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <Field label={<HelpLabel label={t("settings.temperature")} description={t("help.temperature")} />}><TextInput step="0.1" type="number" value={form.temperature} onChange={(event) => setForm({ ...form, temperature: Number(event.target.value) })} /></Field>
          <Field label={<HelpLabel label={t("settings.maxTokens")} description={t("help.maxTokens")} />}><TextInput type="number" value={form.maxTokens} onChange={(event) => setForm({ ...form, maxTokens: Number(event.target.value) })} /></Field>
          <Field label={<HelpLabel label={t("settings.topP")} description={t("help.topP")} />}><TextInput step="0.05" type="number" value={form.topP} onChange={(event) => setForm({ ...form, topP: Number(event.target.value) })} /></Field>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button disabled={loading} onClick={() => void saveSettings()}><Save size={16} />{t("settings.saveSettings")}</Button>
          <Button disabled={loading} variant="ghost" onClick={() => void testBackend()}><PlugZap size={16} />{t("settings.testBackend")}</Button>
        </div>
      </div>
    </Panel>
  );
}
