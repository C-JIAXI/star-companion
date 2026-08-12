import { ExternalLink, RotateCcw } from "lucide-react";
import type { ProfileSummaryRevisionDTO } from "../types";
import { Button } from "./ui";

export function ProfileHistoryPanel({ language, revisions, loading, onSource, onRestore }: {
  language: "zh-CN" | "en";
  revisions: ProfileSummaryRevisionDTO[];
  loading: boolean;
  onSource: (messageId: string) => void;
  onRestore: (revision: ProfileSummaryRevisionDTO) => void;
}) {
  const zh = language === "zh-CN";
  return <section className="space-y-2 rounded-lg border border-white/10 bg-ink-950/25 p-3" data-testid="profile-history-panel">
    <h4 className="text-sm font-semibold text-slate-200">{zh ? "画像摘要历史" : "Profile summary history"}</h4>
    <p className="text-xs text-slate-500">{zh ? "最多保留 30 个版本；只保存来源消息 ID，不复制聊天正文。" : "Up to 30 revisions are retained. Only source message IDs are stored; chat text is not copied."}</p>
    {revisions.length ? <div className="max-h-64 space-y-2 overflow-y-auto pr-1">{revisions.map((revision, index) => {
      const newer = index === 0 ? null : revisions[index - 1];
      return <article key={revision.id} className="rounded-md border border-white/5 bg-white/[0.025] p-2 text-xs">
        <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium text-slate-200">v{revision.revision} · {revision.action}{revision.isCurrent ? ` · ${zh ? "当前" : "current"}` : ""}</span><span className="text-slate-500">{new Date(revision.createdAt).toLocaleString(language)}</span></div>
        <div className="mt-2 grid gap-1 sm:grid-cols-2"><p className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words rounded bg-rose-500/[0.05] p-2 text-rose-200">{newer?.summary ?? (zh ? "（无更早对比）" : "(no newer comparison)")}</p><p className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words rounded bg-emerald-500/[0.05] p-2 text-emerald-200">{revision.summary || (zh ? "（已清空）" : "(cleared)")}</p></div>
        <div className="mt-2 flex flex-wrap gap-2">{revision.sources.map((source) => source.available ? <Button key={source.messageId} className="!min-h-[28px] !px-2 text-xs" variant="secondary" onClick={() => onSource(source.messageId)}><ExternalLink size={12}/>{zh ? "来源" : "Source"}</Button> : <span key={source.messageId} className="rounded bg-white/5 px-2 py-1 text-slate-500">{zh ? "来源消息已删除" : "Source message deleted"}</span>)}{!revision.isCurrent ? <Button className="!min-h-[28px] !px-2 text-xs" disabled={loading} onClick={() => onRestore(revision)}><RotateCcw size={12}/>{zh ? "恢复" : "Restore"}</Button> : null}</div>
      </article>;
    })}</div> : <p className="text-xs text-slate-500">{zh ? "暂无画像历史。" : "No profile history yet."}</p>}
  </section>;
}
