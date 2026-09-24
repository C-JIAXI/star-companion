import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { ConfirmDialog } from "./ui";

export function WebSearchPanel({ language }: { language: string }) {
  const zh = language === "zh-CN";
  const [hasKey, setHasKey] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [removeOpen, setRemoveOpen] = useState(false);
  useEffect(() => { void api.webSearch.status().then((status) => setHasKey(status.hasApiKey)).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught))); }, []);
  const save = async (value: string | null) => {
    setBusy(true); setError("");
    try { const status = await api.webSearch.saveKey(value); setHasKey(status.hasApiKey); setKey(""); setRemoveOpen(false); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };
  return <div className="space-y-4 text-sm text-ink-200" data-testid="web-search-panel">
    <p className="text-xs leading-5 text-ink-300">{zh ? "模型可读取公开 HTTPS 网页。要搜索整个网络，请配置 Brave Search API Key。每次联网前都会显示将发送的参数并请求确认。" : "Models can read public HTTPS pages. Configure a Brave Search API key for general web search. Every network call shows the arguments and requires approval."}</p>
    <div className="flex flex-wrap items-center gap-2"><span className="rounded-full border border-white/15 px-2 py-1 text-xs">{hasKey ? (zh ? "搜索密钥已配置" : "Search key configured") : (zh ? "搜索密钥未配置" : "Search key not configured")}</span>
      <a className="text-xs text-blue-300 hover:underline" href="https://brave.com/search/api/" target="_blank" rel="noreferrer">{zh ? "获取 Brave Search API Key ↗" : "Get a Brave Search API key ↗"}</a></div>
    {error ? <p role="alert" className="rounded-md bg-rose-500/10 p-2 text-rose-300">{error}</p> : null}
    <label className="block text-xs">{zh ? "Brave Search API Key" : "Brave Search API key"}
      <input type="password" autoComplete="off" value={key} onChange={(event) => setKey(event.target.value)} placeholder={hasKey ? (zh ? "输入新密钥以替换" : "Enter a new key to replace") : "BSA..."}
        className="native-input mt-1 w-full rounded-lg border border-white/15 bg-ink-950 p-2 text-sm" /></label>
    <div className="flex flex-wrap gap-2"><button type="button" disabled={busy || !key.trim()} onClick={() => void save(key.trim())} className="min-h-11 rounded-lg bg-ember-500 px-4 text-xs font-semibold text-white disabled:opacity-50">{zh ? "保存密钥" : "Save key"}</button>
      {hasKey ? <button type="button" disabled={busy} onClick={() => setRemoveOpen(true)} className="min-h-11 rounded-lg border border-white/15 px-4 text-xs text-rose-300">{zh ? "移除密钥" : "Remove key"}</button> : null}</div>
    <p className="text-xs leading-5 text-ink-400">{zh ? "密钥只在本机加密保存，不返回前端，也不进入备份或同步。Brave 搜索用量由 Brave 单独计费，不计入本机模型预算；网页内容视为不可信资料。" : "The key is encrypted locally, never returned to the browser, and excluded from backup and sync. Brave search usage is billed separately and is not included in the local model budget. Web content is untrusted reference material."}</p>
    {removeOpen ? <ConfirmDialog title={zh ? "移除搜索密钥" : "Remove search key"} message={zh ? "移除后，模型将无法搜索网页；读取公开网页仍可用。" : "Web search will stop working; reading public pages remains available."}
      cancelLabel={zh ? "取消" : "Cancel"} confirmLabel={zh ? "移除" : "Remove"} loading={busy} onCancel={() => setRemoveOpen(false)} onConfirm={() => void save(null)} /> : null}
  </div>;
}
