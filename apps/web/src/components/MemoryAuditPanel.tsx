import { ChevronDown, ChevronRight, ExternalLink, History, RotateCcw, ShieldAlert } from "lucide-react";
import { useState } from "react";
import type { ChatMemoryDTO, MemoryOperationDTO, MemoryRevisionDTO, MemorySnapshotDTO, MemoryUndoPreviewDTO } from "../types";
import { Button } from "./ui";

type Copy = {
  history: string; recentOperations: string; undoLatest: string; viewHistory: string; source: string;
  sourceDeleted: string; current: string; restore: string; restored: string; deleted: string;
  noHistory: string; noOperations: string; created: string; updated: string; disabled: string;
  unchanged: string; conflict: string; skip: string; forceRestore: string; confirmUndo: string;
  failed: string; running: string; partial: string; retireCreated: string; restoreUpdated: string; restoreDisabled: string;
  actor: Record<string, string>; action: Record<string, string>; fields: Record<string, string>;
};

const copyFor = (language: "zh-CN" | "en"): Copy => language === "zh-CN" ? {
  history: "版本历史", recentOperations: "最近记忆操作", undoLatest: "撤销最近整理", viewHistory: "查看历史",
  source: "查看来源", sourceDeleted: "来源消息已删除", current: "当前状态", restore: "恢复此版本",
  restored: "恢复", deleted: "已删除", noHistory: "暂无版本历史", noOperations: "暂无整理记录",
  created: "创建", updated: "更新", disabled: "禁用", unchanged: "未变化", conflict: "后续修改冲突",
  skip: "跳过", forceRestore: "仍然恢复", confirmUndo: "确认撤销",
  failed: "失败", running: "处理中", partial: "部分完成", retireCreated: "退役本次新建", restoreUpdated: "恢复整理前内容", restoreDisabled: "恢复启用状态",
  actor: { user: "用户", automatic_memory: "自动整理", agent_confirmed: "AI Agent 确认", timeline_cleanup: "时间线清理", restore: "历史恢复" },
  action: { baseline: "基线", automatic_create: "自动创建", automatic_update: "自动更新", automatic_disable: "自动禁用", manual_create: "手动创建", manual_edit: "手动编辑", manual_enable: "手动启用", manual_disable: "手动禁用", manual_delete: "删除", agent_confirmed_create: "Agent 确认创建", timeline_disable: "时间线禁用", restore: "恢复", undo_create: "撤销创建", undo_update: "撤销更新", undo_disable: "撤销禁用" },
  fields: { title: "标题", content: "内容", keywords: "关键词", importance: "重要度", enabled: "启用状态", sourceMessageIds: "来源消息" }
} : {
  history: "Version history", recentOperations: "Recent memory operations", undoLatest: "Undo latest maintenance", viewHistory: "View history",
  source: "View source", sourceDeleted: "Source message deleted", current: "Current state", restore: "Restore this version",
  restored: "Restore", deleted: "Deleted", noHistory: "No version history yet", noOperations: "No maintenance operations yet",
  created: "created", updated: "updated", disabled: "disabled", unchanged: "unchanged", conflict: "Conflicts with a later edit",
  skip: "Skip", forceRestore: "Restore anyway", confirmUndo: "Confirm undo",
  failed: "Failed", running: "Running", partial: "Partially completed", retireCreated: "Retire item created by this run", restoreUpdated: "Restore pre-maintenance content", restoreDisabled: "Restore enabled state",
  actor: { user: "User", automatic_memory: "Automatic maintenance", agent_confirmed: "AI Agent confirmed", timeline_cleanup: "Timeline cleanup", restore: "History restore" },
  action: { baseline: "Baseline", automatic_create: "Automatic create", automatic_update: "Automatic update", automatic_disable: "Automatic disable", manual_create: "Manual create", manual_edit: "Manual edit", manual_enable: "Manual enable", manual_disable: "Manual disable", manual_delete: "Deleted", agent_confirmed_create: "Agent-confirmed create", timeline_disable: "Timeline disabled", restore: "Restored", undo_create: "Create undone", undo_update: "Update undone", undo_disable: "Disable undone" },
  fields: { title: "Title", content: "Content", keywords: "Keywords", importance: "Importance", enabled: "Enabled", sourceMessageIds: "Source messages" }
};

const formatValue = (value: unknown) => Array.isArray(value) ? value.join(", ") || "—" : typeof value === "boolean" ? value ? "✓" : "—" : String(value ?? "—");
const diffFields = (before: MemorySnapshotDTO | null, after: MemorySnapshotDTO | null) => (Object.keys(copyFor("en").fields) as Array<keyof MemorySnapshotDTO>).filter((field) => JSON.stringify(before?.[field]) !== JSON.stringify(after?.[field]));

export function MemoryAuditPanel({
  language, memories, operations, revisions, selectedMemoryId, undoPreview, loading,
  onSelectMemory, onSource, onRestore, onPreviewUndo, onResolveConflict, onExecuteUndo
}: {
  language: "zh-CN" | "en";
  memories: ChatMemoryDTO[];
  operations: MemoryOperationDTO[];
  revisions: MemoryRevisionDTO[];
  selectedMemoryId: string | null;
  undoPreview: MemoryUndoPreviewDTO | null;
  loading: boolean;
  onSelectMemory: (memory: ChatMemoryDTO) => void;
  onSource: (messageId: string) => void;
  onRestore: (revision: MemoryRevisionDTO) => void;
  onPreviewUndo: (operation: MemoryOperationDTO) => void;
  onResolveConflict: (memoryId: string, action: "skip" | "restore") => void;
  onExecuteUndo: () => void;
}) {
  const copy = copyFor(language);
  const [expanded, setExpanded] = useState<number | null>(null);
  return <div className="space-y-3" data-testid="memory-audit-panel">
    <section className="rounded-lg border border-white/10 bg-ink-950/25 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h4 className="flex items-center gap-2 text-sm font-semibold text-slate-200"><History size={15} />{copy.recentOperations}</h4>
      </div>
      {operations.length ? <div className="space-y-2">{operations.slice(0, 5).map((operation) => <div key={operation.id} className="rounded-md border border-white/5 bg-white/[0.025] p-2 text-xs text-slate-400">
        <div className="flex flex-wrap items-center justify-between gap-2"><span>{new Date(operation.completedAt ?? operation.startedAt).toLocaleString(language)}</span><span>{copy.actor[operation.actor] ?? operation.actor}</span></div>
        <p className="mt-1">{copy.created} {operation.created} · {copy.updated} {operation.updated} · {copy.disabled} {operation.disabled} · {copy.unchanged} {operation.unchanged}</p>
        {operation.status !== "succeeded" ? <p className={`mt-1 ${operation.status === "failed" ? "text-rose-300" : "text-amber-300"}`}>{operation.status === "failed" ? copy.failed : operation.status === "running" ? copy.running : copy.partial}{operation.errorCode ? ` · ${operation.errorCode}` : ""}</p> : null}
        {operation.type === "automatic_maintenance" && !operation.undoneAt && operation.status !== "failed" && operation.status !== "running" ? <Button className="mt-2 !min-h-[30px] !px-2 text-xs" variant="secondary" disabled={loading} onClick={() => onPreviewUndo(operation)}><RotateCcw size={13} />{copy.undoLatest}</Button> : null}
      </div>)}</div> : <p className="text-xs text-slate-500">{copy.noOperations}</p>}
      {undoPreview ? <div className="mt-3 space-y-2 rounded-md border border-amber-500/20 bg-amber-500/[0.05] p-3" data-testid="memory-undo-preview">
        {undoPreview.items.map((item) => <div key={item.memoryId} className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <span className="text-slate-300"><span className="block font-medium">{memories.find((memory) => memory.id === item.memoryId)?.title ?? item.memoryId}</span><span className="text-slate-500">{item.effect === "retire_created" ? copy.retireCreated : item.effect === "restore_disabled" ? copy.restoreDisabled : copy.restoreUpdated}{item.current && item.restored ? ` · ${diffFields(item.current, item.restored).map((field) => copy.fields[field]).join(", ") || copy.unchanged}` : ""}</span></span>
          {item.conflict ? <div className="flex items-center gap-2"><span className="flex items-center gap-1 text-amber-300"><ShieldAlert size={13}/>{copy.conflict}</span><select className="rounded border border-white/10 bg-ink-900 px-2 py-1" defaultValue="skip" onChange={(event) => onResolveConflict(item.memoryId, event.target.value as "skip" | "restore")}><option value="skip">{copy.skip}</option><option value="restore">{copy.forceRestore}</option></select></div> : <span className="text-emerald-300">{copy.restored}</span>}
        </div>)}
        <div className="flex justify-end"><Button className="!min-h-[32px] text-xs" disabled={loading || !undoPreview.canExecute} onClick={onExecuteUndo}>{copy.confirmUndo}</Button></div>
      </div> : null}
    </section>
    <section className="rounded-lg border border-white/10 bg-ink-950/25 p-3">
      <h4 className="mb-2 text-sm font-semibold text-slate-200">{copy.history}</h4>
      <div className="mb-3 flex flex-wrap gap-2">{memories.map((memory) => <button key={memory.id} type="button" className={`rounded-full px-3 py-1 text-xs ${selectedMemoryId === memory.id ? "bg-ember-500/20 text-ember-200" : "bg-white/5 text-slate-400"}`} onClick={() => onSelectMemory(memory)}>{memory.title}{memory.deletedAt ? ` · ${copy.deleted}` : ""}</button>)}</div>
      {selectedMemoryId && revisions.length ? <div className="max-h-80 space-y-2 overflow-y-auto pr-1">{revisions.map((revision) => {
        const fields = diffFields(revision.beforeSnapshot, revision.afterSnapshot);
        const isExpanded = expanded === revision.revision;
        return <article key={revision.id} className="rounded-md border border-white/5 bg-white/[0.025] p-2" data-testid={`memory-revision-${revision.revision}`}>
          <button type="button" className="flex w-full items-start gap-2 text-left" onClick={() => setExpanded(isExpanded ? null : revision.revision)}>{isExpanded ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}<span className="min-w-0 flex-1"><span className="block text-xs font-medium text-slate-200">v{revision.revision} · {copy.action[revision.action] ?? revision.action}{revision.isCurrent ? ` · ${copy.current}` : ""}</span><span className="block text-xs text-slate-500">{new Date(revision.createdAt).toLocaleString(language)} · {copy.actor[revision.actor] ?? revision.actor} · {revision.sourceMessageIds.length} {copy.source}</span></span></button>
          {isExpanded ? <div className="mt-2 space-y-2 border-t border-white/5 pt-2">
            {fields.map((field) => <div key={field} className="grid gap-1 text-xs sm:grid-cols-[6rem_minmax(0,1fr)]"><span className="text-slate-500">{copy.fields[field]}</span><div className="min-w-0"><p className="max-h-20 overflow-y-auto break-words rounded bg-rose-500/[0.05] p-1.5 text-rose-200 line-through">{formatValue(revision.beforeSnapshot?.[field])}</p><p className="mt-1 max-h-20 overflow-y-auto break-words rounded bg-emerald-500/[0.05] p-1.5 text-emerald-200">{formatValue(revision.afterSnapshot?.[field])}</p></div></div>)}
            <div className="flex flex-wrap gap-2">{revision.sources.map((source) => source.available ? <Button key={source.messageId} className="!min-h-[30px] !px-2 text-xs" variant="secondary" onClick={() => onSource(source.messageId)}><ExternalLink size={12}/>{copy.source}</Button> : <span key={source.messageId} className="rounded bg-white/5 px-2 py-1 text-xs text-slate-500">{copy.sourceDeleted}</span>)}{!revision.isCurrent && revision.afterSnapshot ? <Button className="!min-h-[30px] !px-2 text-xs" disabled={loading} onClick={() => onRestore(revision)}><RotateCcw size={12}/>{copy.restore}</Button> : null}</div>
          </div> : null}
        </article>;
      })}</div> : <p className="text-xs text-slate-500">{copy.noHistory}</p>}
    </section>
  </div>;
}
