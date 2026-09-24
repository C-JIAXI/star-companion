import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { McpConnectionDTO } from "../types";
import { ConfirmDialog } from "./ui";

export function McpConnectionsPanel({ language }: { language: string }) {
  const zh = language === "zh-CN";
  const [connections, setConnections] = useState<McpConnectionDTO[]>([]);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<McpConnectionDTO | null>(null);
  const [name, setName] = useState("");
  const [endpointUrl, setEndpointUrl] = useState("");
  const [bearerToken, setBearerToken] = useState("");
  const [clearBearerToken, setClearBearerToken] = useState(false);
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
  const closeForm = () => {
    setFormOpen(false); setEditing(null); setName(""); setEndpointUrl(""); setBearerToken("");
    setClearBearerToken(false); setAllowPrivateNetwork(false);
  };
  const openEdit = (connection: McpConnectionDTO) => {
    setEditing(connection); setName(connection.name); setEndpointUrl(connection.endpointUrl);
    setBearerToken(""); setClearBearerToken(false); setAllowPrivateNetwork(connection.allowPrivateNetwork);
    setFormOpen(true); setError("");
  };
  return <div className="space-y-4 text-sm text-ink-200" data-testid="mcp-connections-panel">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h3 className="font-semibold text-ink-50">{zh ? "MCP 服务器" : "MCP servers"}</h3>
        <p className="mt-1 max-w-2xl text-xs leading-5 text-ink-300">{zh ? "先添加服务器并检查连接，再选择工具。外部调用仍需授权。" : "Add a server, check its connection, then choose tools. External calls still require approval."}</p></div>
      {!formOpen ? <button type="button" className="rounded-lg bg-ember-500 px-3 py-2 text-xs font-semibold text-white hover:bg-ember-400" onClick={() => setFormOpen(true)}>{zh ? "+ 添加服务器" : "+ Add server"}</button> : null}
    </div>
    {error ? <p role="alert" className="rounded-md bg-rose-500/10 p-2 text-rose-300">{error}</p> : null}
    {formOpen ? <div className="space-y-3 rounded-xl border border-white/10 bg-white/[0.03] p-4" data-testid="mcp-connection-form">
      <h4 className="font-semibold text-ink-50">{editing ? (zh ? "编辑服务器" : "Edit server") : (zh ? "添加服务器" : "Add server")}</h4>
      <label className="block">{zh ? "连接名称" : "Connection name"}<input className="native-input mt-1 w-full rounded-md border border-white/15 bg-ink-950 p-2" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} /></label>
      <label className="block">{zh ? "MCP URL" : "MCP URL"}<input className="native-input mt-1 w-full rounded-md border border-white/15 bg-ink-950 p-2" value={endpointUrl} maxLength={2048} placeholder="https://example.com/mcp" onChange={(event) => setEndpointUrl(event.target.value)} /></label>
      <label className="block">{zh ? "Bearer Token（可选）" : "Bearer token (optional)"}<input className="native-input mt-1 w-full rounded-md border border-white/15 bg-ink-950 p-2" type="password" autoComplete="off" value={bearerToken} maxLength={4096} placeholder={editing?.hasBearerToken ? (zh ? "留空保留现有密钥" : "Leave blank to keep saved token") : undefined} onChange={(event) => { setBearerToken(event.target.value); setClearBearerToken(false); }} /></label>
      {editing?.hasBearerToken ? <label className="flex items-center gap-2"><input type="checkbox" checked={clearBearerToken} onChange={(event) => { setClearBearerToken(event.target.checked); if (event.target.checked) setBearerToken(""); }} />{zh ? "移除已保存的密钥" : "Remove saved token"}</label> : null}
      <label className="flex items-center gap-2"><input type="checkbox" checked={allowPrivateNetwork} onChange={(event) => setAllowPrivateNetwork(event.target.checked)} />{zh ? "允许此连接访问局域网地址" : "Allow local network addresses for this connection"}</label>
      <p className="text-xs leading-5 text-ink-300">{zh ? "公网需 HTTPS。更改地址、密钥或局域网权限后需重新检查并启用工具。" : "Public URLs require HTTPS. Recheck and enable tools after changing the URL, token, or local access."}</p>
      <div className="flex justify-end gap-2"><button type="button" className="rounded-lg border border-white/15 px-3 py-2 text-xs" onClick={closeForm}>{zh ? "取消" : "Cancel"}</button>
        <button type="button" className="rounded-lg bg-ember-500 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50" disabled={busy || !name.trim() || !endpointUrl.trim()} onClick={() => void run(async () => {
          if (editing) await api.mcp.update(editing.id, { expectedVersion: editing.version, name: name.trim(), endpointUrl: endpointUrl.trim(), allowPrivateNetwork,
            ...(clearBearerToken ? { bearerToken: null } : bearerToken ? { bearerToken } : {}) });
          else await api.mcp.create({ name: name.trim(), endpointUrl: endpointUrl.trim(), allowPrivateNetwork, ...(bearerToken ? { bearerToken } : {}) });
          closeForm();
        })}>{busy ? (zh ? "保存中…" : "Saving…") : editing ? (zh ? "保存修改" : "Save changes") : (zh ? "保存连接" : "Save connection")}</button></div>
    </div> : null}
    {connections.length === 0 ? <div className="rounded-xl border border-dashed border-white/15 p-5 text-center text-xs text-ink-300">{zh ? "还没有 MCP 服务器。添加 Streamable HTTP 地址开始。" : "No MCP servers yet. Add a Streamable HTTP endpoint to begin."}</div> : null}
    <div className="space-y-3">
      {connections.map((connection) => <div key={connection.id} className="rounded-xl border border-white/10 bg-white/[0.025] p-4" data-testid={`mcp-connection-${connection.id}`}>
        <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h4 className="font-semibold text-ink-50">{connection.name}</h4><span className="rounded-full border border-white/15 px-2 py-0.5 text-[11px]">{!connection.lastCheckedAt ? (zh ? "待检查" : "Needs check") : connection.enabled ? (zh ? "已启用" : "Enabled") : (zh ? "已停用" : "Disabled")}</span></div>
          <p className="mt-1 break-all text-xs text-ink-300">{connection.endpointUrl}</p><p className="mt-1 text-xs text-ink-300">{connection.hasBearerToken ? (zh ? "密钥已配置" : "Token configured") : (zh ? "无密钥" : "No token")}{connection.lastCheckedAt ? ` · ${zh ? "上次检查" : "Last checked"} ${new Date(connection.lastCheckedAt).toLocaleString()}` : ""}</p></div>
          <label className="flex min-h-9 items-center gap-2 text-xs"><input type="checkbox" disabled={busy || !connection.lastCheckedAt} checked={connection.enabled} onChange={() => void run(() => api.mcp.update(connection.id, { expectedVersion: connection.version, enabled: !connection.enabled }))} />{zh ? "启用" : "Enable"}</label></div>
        <div className="mt-3 flex flex-wrap items-center gap-4 border-t border-white/10 pt-3 text-xs">
          <button type="button" disabled={busy} className="text-blue-300 hover:underline" onClick={() => void run(() => api.mcp.check(connection.id, connection.version))}>{zh ? "检查连接" : "Check connection"}</button>
          <button type="button" disabled={busy} className="text-ink-100 hover:underline" onClick={() => openEdit(connection)}>{zh ? "编辑" : "Edit"}</button>
          <button type="button" disabled={busy} className="text-rose-300 hover:underline" onClick={() => setPendingDelete(connection)}>{zh ? "删除" : "Delete"}</button>
        </div>
        {connection.tools.length ? <details className="mt-3 border-t border-white/10 pt-3 text-xs"><summary className="cursor-pointer font-medium text-ink-100">{zh ? "工具" : "Tools"} · {connection.tools.filter((tool) => tool.enabled).length}/{connection.tools.length} {zh ? "已启用" : "enabled"}</summary>
          {connection.tools.map((tool) => <label key={tool.name} className="mt-2 flex min-h-11 items-start gap-2 rounded-lg px-2 py-2 hover:bg-white/[0.04]">
          <input type="checkbox" disabled={busy} checked={tool.enabled} onChange={() => void run(() => api.mcp.enableTool(connection.id, { expectedVersion: connection.version,
            toolName: tool.name, definitionDigest: tool.definitionDigest, enabled: !tool.enabled }))} />
          <span><strong className="text-ink-50">{tool.name}</strong>{tool.readOnlyHint ? ` · ${zh ? "服务声明只读" : "Server claims read-only"}` : ""}<span className="mt-1 block leading-5 text-ink-300">{tool.description}</span></span>
          </label>)}
        </details> : connection.lastCheckedAt ? <p className="mt-3 text-xs text-ink-300">{zh ? "此服务器没有发现工具。" : "No tools discovered on this server."}</p> : null}
      </div>)}
    </div>
    {pendingDelete ? <ConfirmDialog title={zh ? "删除 MCP 连接" : "Delete MCP connection"}
      message={zh ? `删除 ${pendingDelete.name} 的本机配置与密钥？` : `Delete local configuration and token for ${pendingDelete.name}?`}
      cancelLabel={zh ? "取消" : "Cancel"} confirmLabel={zh ? "删除" : "Delete"} loading={busy}
      onCancel={() => setPendingDelete(null)} onConfirm={() => void run(async () => { await api.mcp.delete(pendingDelete.id, pendingDelete.version); setPendingDelete(null); })} /> : null}
  </div>;
}
