import { AlertTriangle, CheckCircle2, Clipboard, Database, Download, RefreshCw, Search, ShieldCheck, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { storageHealthApi } from "../lib/storageHealthApi";
import { saveJsonFile } from "../lib/files";
import { queueChatMessageJump } from "../lib/messageNavigation";
import type { AppLanguage, StorageCleanupAction, StorageCleanupPlanDTO, StorageCleanupResultDTO, StorageDeepScanDTO, StorageHealthIssueDTO, StorageHealthSnapshotDTO } from "../types";
import { Button, ConfirmDialog, ErrorNotice, Panel, SuccessNotice } from "./ui";

const cleanupActions: StorageCleanupAction[] = ["expired_drafts", "orphan_media", "clear_embeddings", "expired_recovery_points", "old_upgrade_recovery", "usage_ledger", "app_temp_cache", "rebuild_database_indexes", "vacuum_database"];
const destructiveActions = new Set<StorageCleanupAction>(["expired_drafts", "orphan_media", "expired_recovery_points", "old_upgrade_recovery", "usage_ledger", "app_temp_cache"]);

const formatBytes = (bytes: number | null, language: AppLanguage) => {
  if (bytes === null) return language === "zh-CN" ? "不可用" : "Unavailable";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024; let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[unit]}`;
};

export function StorageHealthPanel({ language }: { language: AppLanguage }) {
  const zh = language === "zh-CN";
  const [snapshot, setSnapshot] = useState<StorageHealthSnapshotDTO | null>(null);
  const [scan, setScan] = useState<StorageDeepScanDTO | null>(null);
  const [selected, setSelected] = useState<StorageCleanupAction[]>([]);
  const [plan, setPlan] = useState<StorageCleanupPlanDTO | null>(null);
  const [result, setResult] = useState<StorageCleanupResultDTO | null>(null);
  const [severity, setSeverity] = useState<"all" | StorageHealthIssueDTO["severity"]>("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const copy = {
    title: zh ? "本地存储与数据健康" : "Local storage & data health",
    description: zh ? "统计仅涵盖本应用拥有的数据。快速检查只读；深度检查会验证媒体、引用和派生状态，但不会修复或删除任何内容。" : "Only app-owned data is counted. Fast checks are read-only; deep checks validate media, references, and derived state without repairing or deleting anything.",
    refresh: zh ? "刷新统计" : "Refresh stats", deep: zh ? "运行深度检查" : "Run deep check", cancel: zh ? "取消检查" : "Cancel check",
    storage: zh ? "空间概览" : "Storage overview", issues: zh ? "健康问题" : "Health issues", cleanup: zh ? "分项清理与维护" : "Per-action cleanup & maintenance",
    noIssues: zh ? "未发现需要处理的问题。" : "No issues need attention.", preview: zh ? "生成清理预览" : "Preview selected actions", execute: zh ? "确认执行计划" : "Confirm plan execution",
    selectHint: zh ? "默认不选择任何破坏性操作。每次只执行当前预览中的项目。" : "No destructive action is selected by default. Only items in the current preview are executed.",
    diagnostics: zh ? "安全诊断" : "Safe diagnostic", copyDiagnostic: zh ? "复制诊断" : "Copy diagnostic", downloadDiagnostic: zh ? "下载诊断" : "Download diagnostic"
  };
  const actionLabels: Record<StorageCleanupAction, string> = {
    expired_drafts: zh ? "过期且未发送的草稿图片" : "Expired unattached draft images",
    orphan_media: zh ? "无任何引用的媒体资产" : "Unreferenced media assets",
    clear_embeddings: zh ? "清除并标记待重建的向量" : "Clear and mark embeddings for rebuild",
    expired_recovery_points: zh ? "超出保留策略的恢复点" : "Recovery points outside retention",
    old_upgrade_recovery: zh ? "旧版升级恢复副本" : "Old upgrade recovery copies",
    usage_ledger: zh ? "已结束的模型调用账本" : "Completed model usage ledger",
    app_temp_cache: zh ? "应用临时文件与缓存" : "Application temp files and cache",
    rebuild_database_indexes: zh ? "重建数据库索引" : "Rebuild database indexes",
    vacuum_database: zh ? "压缩数据库（独立操作）" : "Compact database (separate operation)"
  };
  const categoryZh: Record<string, string> = {
    database: "SQLite 数据库", core: "角色、聊天与消息", memory_current: "当前长期记忆", memory_revisions: "记忆版本", memory_operations: "记忆操作", profile_revisions: "画像摘要版本",
    media: "聊天图片媒体", media_sent: "已发送图片引用", media_drafts: "草稿图片引用", media_recovery_refs: "恢复点媒体引用", media_orphans: "无引用媒体", character_images: "本地角色图片", persona_images: "本地用户头像", background_images: "本地聊天背景",
    embeddings: "记忆向量与索引", recovery_points: "本地恢复点", upgrade_recovery: "升级恢复副本", trash: "聊天回收站与记忆墓碑", usage: "模型请求与用量账本", temp_cache: "应用临时文件与缓存", other_private_files: "其他应用私有文件"
  };

  const refresh = useCallback(async () => {
    setError("");
    try { setSnapshot(await storageHealthApi.summary()); } catch (value) { setError(value instanceof Error ? value.message : (zh ? "读取存储统计失败。" : "Failed to read storage statistics.")); }
  }, [zh]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!scan || scan.state !== "running") return;
    const timer = window.setInterval(() => { void storageHealthApi.deepScan(scan.id).then((next) => { setScan(next); if (next.state !== "running") void refresh(); }).catch((value) => setError(value instanceof Error ? value.message : "Scan failed")); }, 500);
    return () => window.clearInterval(timer);
  }, [refresh, scan]);

  const issues = useMemo(() => [...(snapshot?.issues ?? []), ...(scan?.issues ?? [])].filter((entry) => severity === "all" || entry.severity === severity), [scan?.issues, severity, snapshot?.issues]);
  const diagnostic = useMemo(() => snapshot ? { generatedAt: snapshot.generatedAt, platform: snapshot.platform, overall: snapshot.overall, databaseBytes: snapshot.databaseBytes, reclaimableDatabaseBytes: snapshot.reclaimableDatabaseBytes, freeDiskBytes: snapshot.freeDiskBytes, categories: snapshot.categories, issues: [...snapshot.issues, ...(scan?.issues ?? [])].map(({ code, severity: issueSeverity, category, message, count }) => ({ code, severity: issueSeverity, category, message, count: count ?? null })), deepScan: scan ? { state: scan.state, checkedItems: scan.checkedItems, totalItems: scan.totalItems, errorCode: scan.errorCode } : null, capabilities: snapshot.capabilities } : null, [scan, snapshot]);

  const startDeepScan = async () => { setBusy(true); setError(""); try { setScan(await storageHealthApi.startDeepScan()); } catch (value) { setError(value instanceof Error ? value.message : "Scan failed"); } finally { setBusy(false); } };
  const cancelDeepScan = async () => { if (!scan) return; try { setScan(await storageHealthApi.cancelDeepScan(scan.id)); } catch (value) { setError(value instanceof Error ? value.message : "Cancel failed"); } };
  const previewCleanup = async () => { setBusy(true); setError(""); setResult(null); try { setPlan(await storageHealthApi.createCleanupPlan(selected)); } catch (value) { setError(value instanceof Error ? value.message : "Plan failed"); } finally { setBusy(false); } };
  const executeCleanup = async () => { if (!plan) return; setBusy(true); setError(""); try { setResult(await storageHealthApi.executeCleanupPlan(plan.id)); setPlan(null); setSelected([]); await refresh(); } catch (value) { setError(value instanceof Error ? value.message : "Cleanup failed"); setPlan(null); } finally { setBusy(false); } };
  const openIssue = (entry: StorageHealthIssueDTO) => { if (!entry.chatId || !entry.messageId) return; queueChatMessageJump({ chatId: entry.chatId, messageId: entry.messageId, index: entry.messageIndex ?? 0 }); try { window.localStorage.setItem("star-companion:selected-chat", entry.chatId); } catch { /* navigation still opens chat */ } window.location.assign("/"); };

  return <div className="space-y-4" data-testid="storage-health-center">
    <Panel title={copy.title} action={<span className={`rounded-full border px-2 py-1 text-xs font-semibold ${snapshot?.overall === "error" ? "border-rose-400/30 text-rose-300" : snapshot?.overall === "attention" ? "border-amber-400/30 text-amber-200" : "border-emerald-400/30 text-emerald-200"}`}>{snapshot?.overall === "healthy" ? (zh ? "健康" : "Healthy") : snapshot?.overall === "error" ? (zh ? "需处理" : "Needs action") : (zh ? "请留意" : "Attention")}</span>}>
      <p className="text-sm leading-6 text-ink-300">{copy.description}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button disabled={busy} variant="secondary" onClick={() => void refresh()}><RefreshCw size={16}/>{copy.refresh}</Button>
        <Button disabled={busy || scan?.state === "running"} onClick={() => void startDeepScan()}><Search size={16}/>{copy.deep}</Button>
        {scan?.state === "running" ? <Button variant="ghost" onClick={() => void cancelDeepScan()}><X size={16}/>{copy.cancel}</Button> : null}
      </div>
      {scan ? <div className="mt-4" role="status" aria-live="polite"><div className="flex justify-between text-xs text-ink-300"><span>{zh ? "深度检查" : "Deep check"} · {scan.state}</span><span>{scan.progress}%</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-ink-950"><div className="h-full bg-ember-500 transition-[width]" style={{ width: `${scan.progress}%` }}/></div></div> : null}
      {error ? <div className="mt-4"><ErrorNotice message={error}/></div> : null}
      {result ? <div className="mt-4"><SuccessNotice message={`${zh ? "维护完成：" : "Maintenance finished: "}${result.items.map((item) => `${actionLabels[item.action]} ${item.status} (${item.count})`).join(" · ")}`}/></div> : null}
    </Panel>

    <Panel title={copy.storage}>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {(snapshot?.categories ?? []).map((entry) => <div key={entry.id} className="rounded-lg border border-white/[0.08] bg-ink-950/45 p-3" data-testid={`storage-category-${entry.id}`}><div className="flex items-start justify-between gap-2"><span className="text-sm font-semibold text-ink-100">{zh ? categoryZh[entry.id] ?? entry.label : entry.label}</span><span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-300">{entry.measurement === "exact" ? (zh ? "准确" : "Exact") : entry.measurement === "estimated" ? (zh ? "估算" : "Estimated") : (zh ? "不可用" : "Unavailable")}</span></div><p className="mt-2 text-xl font-semibold text-ink-50">{formatBytes(entry.bytes, language)}</p><p className="mt-1 text-xs text-ink-400">{entry.count === null ? (zh ? "数量不可用" : "Count unavailable") : `${entry.count} ${zh ? "项" : "items"}`}{entry.reclaimableBytes ? ` · ${zh ? "可回收" : "reclaimable"} ${formatBytes(entry.reclaimableBytes, language)}` : ""}</p></div>)}
      </div>
      <div className="mt-3 flex flex-wrap gap-4 text-xs text-ink-300"><span>{zh ? "数据库文件" : "Database"}: {formatBytes(snapshot?.databaseBytes ?? null, language)}</span><span>{zh ? "预计可回收" : "Estimated reclaimable"}: {formatBytes(snapshot?.reclaimableDatabaseBytes ?? null, language)}</span><span>{zh ? "可用磁盘" : "Free disk"}: {formatBytes(snapshot?.freeDiskBytes ?? null, language)}</span></div>
    </Panel>

    <Panel title={copy.issues} action={<select aria-label={zh ? "按严重程度筛选" : "Filter by severity"} className="min-h-10 rounded-md border border-white/[0.1] bg-ink-950 px-2 text-xs text-ink-100" value={severity} onChange={(event) => setSeverity(event.target.value as typeof severity)}><option value="all">{zh ? "全部" : "All"}</option><option value="error">{zh ? "错误" : "Error"}</option><option value="warning">{zh ? "警告" : "Warning"}</option><option value="info">{zh ? "提示" : "Info"}</option></select>}>
      {issues.length ? <ul className="space-y-2">{issues.map((entry, index) => <li key={`${entry.code}-${index}`} className="flex items-start gap-3 rounded-lg border border-white/[0.07] bg-ink-950/45 p-3">{entry.severity === "error" ? <AlertTriangle className="mt-0.5 shrink-0 text-rose-400" size={17}/> : entry.severity === "warning" ? <AlertTriangle className="mt-0.5 shrink-0 text-amber-300" size={17}/> : <ShieldCheck className="mt-0.5 shrink-0 text-sky-300" size={17}/>}<div className="min-w-0"><p className="text-sm text-ink-100">{entry.message}{entry.count ? ` (${entry.count})` : ""}</p><p className="mt-1 text-xs text-ink-400">{entry.code}</p>{entry.chatId && entry.messageId ? <button className="mt-2 text-xs font-semibold text-sky-300 hover:underline" type="button" onClick={() => openIssue(entry)}>{zh ? "前往相关消息" : "Go to related message"}</button> : null}</div></li>)}</ul> : <div className="flex items-center gap-2 rounded-lg border border-emerald-400/20 bg-emerald-500/[0.06] p-3 text-sm text-emerald-100"><CheckCircle2 size={17}/>{copy.noIssues}</div>}
    </Panel>

    <Panel title={copy.cleanup}>
      <p className="text-sm text-ink-300">{copy.selectHint}</p>
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {cleanupActions.map((action) => { const supported = action === "vacuum_database" ? snapshot?.capabilities.vacuum !== false : action === "old_upgrade_recovery" ? snapshot?.capabilities.upgradeRecoveryCleanup !== false : action === "app_temp_cache" ? snapshot?.capabilities.appTempCleanup !== false : true; return <label key={action} className={`flex min-h-12 items-start gap-3 rounded-lg border border-white/[0.08] bg-ink-950/45 p-3 ${supported ? "cursor-pointer" : "opacity-60"}`}><input className="mt-1 accent-ember-500" type="checkbox" checked={selected.includes(action)} disabled={!supported || busy} onChange={(event) => { setPlan(null); setSelected((current) => event.target.checked ? (action === "vacuum_database" ? [action] : [...current.filter((entry) => entry !== "vacuum_database"), action]) : current.filter((entry) => entry !== action)); }}/><span><span className="block text-sm font-medium text-ink-100">{actionLabels[action]}</span>{destructiveActions.has(action) ? <span className="mt-0.5 block text-xs text-amber-200">{zh ? "删除操作；执行前会再次确认" : "Deletes data; confirmation is required"}</span> : null}{!supported ? <span className="mt-0.5 block text-xs text-ink-400">{zh ? "当前平台不支持" : "Unsupported on this platform"}</span> : null}</span></label>; })}
      </div>
      <div className="mt-4 flex flex-wrap gap-2"><Button disabled={!selected.length || busy} onClick={() => void previewCleanup()}><Database size={16}/>{copy.preview}</Button></div>
    </Panel>

    <Panel title={copy.diagnostics}>
      <p className="text-sm text-ink-300">{zh ? "诊断只包含类别、数量、状态码和容量；不包含本地路径、完整媒体哈希、聊天正文、画像或 API Key。" : "Diagnostics contain categories, counts, status codes, and sizes only—never local paths, full media hashes, chat text, profiles, or API keys."}</p>
      <div className="mt-3 flex flex-wrap gap-2"><Button variant="secondary" disabled={!diagnostic} onClick={() => void navigator.clipboard.writeText(JSON.stringify(diagnostic, null, 2)).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1800); })}><Clipboard size={16}/>{copied ? (zh ? "已复制" : "Copied") : copy.copyDiagnostic}</Button><Button variant="secondary" disabled={!diagnostic} onClick={() => diagnostic && void saveJsonFile(`star-companion-storage-diagnostic-${new Date().toISOString().slice(0, 10)}.json`, diagnostic)}><Download size={16}/>{copy.downloadDiagnostic}</Button></div>
    </Panel>

    {plan ? <ConfirmDialog title={zh ? "确认存储维护计划" : "Confirm storage maintenance plan"} message={<span>{zh ? "服务器已重新计算本次影响。计划将在 5 分钟后过期且只能执行一次。" : "The server recalculated this impact. The plan expires in 5 minutes and can be used only once."}<span className="mt-3 block space-y-1">{plan.items.map((item) => <span className="block" key={item.action}>• {actionLabels[item.action]}: {item.count} · {formatBytes(item.estimatedBytes, language)}{!item.supported ? ` (${zh ? "不支持" : "unsupported"})` : ""}</span>)}</span></span>} confirmLabel={copy.execute} cancelLabel={zh ? "取消" : "Cancel"} loading={busy} variant="danger" onCancel={() => setPlan(null)} onConfirm={() => void executeCleanup()}/> : null}
  </div>;
}
