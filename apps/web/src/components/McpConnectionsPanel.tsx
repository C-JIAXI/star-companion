import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { McpConnectionDTO } from "../types";
import { ConfirmDialog } from "./ui";

export function McpConnectionsPanel({ language }: { language: string }) {
  const zh = language === "zh-CN";
  const [connections, setConnections] = useState<McpConnectionDTO[]>([]);
  const [name, setName] = useState("");
  const [endpointUrl, setEndpointUrl] = useState("");
  const [bearerToken, setBearerToken] = useState("");
  const [allowPrivateNetwork, setAllowPrivateNetwork] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<McpConnectionDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refresh = async () => setConnections(await api.mcp.list());
  useEffect(() => { void refresh().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught))); }, []);
  const run = async (task: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try { await task(); await refresh(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); await refresh().catch(() => undefined); }
    finally { setBusy(false); }
  };
  return <div className="space-y-3 text-xs text-ink-200" data-testid="mcp-connections-panel">
    <p className="leading-5 text-ink-300">{zh ? "仅连接你配置的 URL；公开地址使用 HTTPS，局域网地址需单独启用。每个外部调用仍需授权。" : "Connect only to URLs you configure. Public endpoints require HTTPS; local network access must be enabled. External calls still require approval."}</p>
    {error ? <p role="alert" className="rounded-md bg-rose-500/10 p-2 text-rose-300">{error}</p> : null}
    <div className="space-y-2 rounded-lg border border-white/10 p-2">
      <label className="block">{zh ? "连接名称" : "Connection name"}<input className="native-input mt-1 w-full rounded-md border border-white/15 bg-ink-950 p-2" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} /></label>
      <label className="block">{zh ? "MCP URL" : "MCP URL"}<input className="native-input mt-1 w-full rounded-md border border-white/15 bg-ink-950 p-2" value={endpointUrl} maxLength={2048} placeholder="https://example.com/mcp" onChange={(event) => setEndpointUrl(event.target.value)} /></label>
      <label className="block">{zh ? "Bearer Token（可选）" : "Bearer token (optional)"}<input className="native-input mt-1 w-full rounded-md border border-white/15 bg-ink-950 p-2" type="password" autoComplete="off" value={bearerToken} maxLength={4096} onChange={(event) => setBearerToken(event.target.value)} /></label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={allowPrivateNetwork} onChange={(event) => setAllowPrivateNetwork(event.target.checked)} />{zh ? "允许此连接访问局域网地址" : "Allow local network addresses for this connection"}</label>
      <button type="button" className="rounded-md border border-white/15 px-2 py-1 hover:bg-white/[0.06]" disabled={busy || !name.trim() || !endpointUrl.trim()} onClick={() => void run(async () => {
        await api.mcp.create({ name: name.trim(), endpointUrl: endpointUrl.trim(), allowPrivateNetwork, ...(bearerToken ? { bearerToken } : {}) });
        setName(""); setEndpointUrl(""); setBearerToken(""); setAllowPrivateNetwork(false);
      })}>{zh ? "保存连接" : "Save connection"}</button>
    </div>
    <div className="max-h-72 space-y-2 overflow-y-auto">
      {connections.map((connection) => <div key={connection.id} className="rounded-lg border border-white/10 p-2">
        <p className="font-semibold text-ink-50">{connection.name}</p>
        <p className="mt-1 break-all text-ink-300">{connection.endpointUrl}</p>
        <p className="mt-1 text-ink-300">{connection.hasBearerToken ? (zh ? "密钥已配置" : "Token configured") : (zh ? "无密钥" : "No token")}</p>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <button type="button" disabled={busy} className="text-blue-300 hover:underline" onClick={() => void run(() => api.mcp.check(connection.id, connection.version))}>{zh ? "检查连接并发现工具" : "Check connection and discover tools"}</button>
          <label className="flex items-center gap-1"><input type="checkbox" disabled={busy || !connection.lastCheckedAt} checked={connection.enabled} onChange={() => void run(() => api.mcp.update(connection.id, { expectedVersion: connection.version, enabled: !connection.enabled }))} />{zh ? "启用连接" : "Enable connection"}</label>
          <button type="button" disabled={busy} className="text-rose-300 hover:underline" onClick={() => setPendingDelete(connection)}>{zh ? "删除" : "Delete"}</button>
        </div>
        {connection.lastCheckedAt ? <p className="mt-1 text-ink-300">{zh ? "上次检查" : "Last checked"}: {new Date(connection.lastCheckedAt).toLocaleString()}</p> : null}
        {connection.tools.map((tool) => <label key={tool.name} className="mt-2 flex items-start gap-2 border-t border-white/10 pt-2">
          <input type="checkbox" disabled={busy} checked={tool.enabled} onChange={() => void run(() => api.mcp.enableTool(connection.id, { expectedVersion: connection.version,
            toolName: tool.name, definitionDigest: tool.definitionDigest, enabled: !tool.enabled }))} />
          <span><strong>{tool.name}</strong>{tool.readOnlyHint ? ` · ${zh ? "服务声明只读" : "Server claims read-only"}` : ""}<br />{tool.description}</span>
        </label>)}
      </div>)}
    </div>
    {pendingDelete ? <ConfirmDialog title={zh ? "删除 MCP 连接" : "Delete MCP connection"}
      message={zh ? `删除 ${pendingDelete.name} 的本机配置与密钥？` : `Delete local configuration and token for ${pendingDelete.name}?`}
      cancelLabel={zh ? "取消" : "Cancel"} confirmLabel={zh ? "删除" : "Delete"} loading={busy}
      onCancel={() => setPendingDelete(null)} onConfirm={() => void run(async () => { await api.mcp.delete(pendingDelete.id, pendingDelete.version); setPendingDelete(null); })} /> : null}
  </div>;
}
