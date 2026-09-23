import { useEffect, useRef, useState } from "react";
import type { SkillDetailDTO, SkillImportInputDTO, SkillImportPreviewDTO, SkillSummaryDTO } from "../types";
import { api } from "../lib/api";
import { ConfirmDialog } from "./ui";

export function AgentSkillsPanel({ chatId, language }: { chatId: string; language: string }) {
  const zh = language === "zh-CN";
  const fileRef = useRef<HTMLInputElement>(null);
  const [skills, setSkills] = useState<SkillSummaryDTO[]>([]);
  const [selected, setSelected] = useState<SkillDetailDTO | null>(null);
  const [reference, setReference] = useState<{ path: string; content: string } | null>(null);
  const [pendingImport, setPendingImport] = useState<{ input: SkillImportInputDTO; preview: SkillImportPreviewDTO } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<SkillSummaryDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = async () => setSkills(await api.skills.list());
  useEffect(() => { void refresh().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught))); }, []);

  const updateSummary = (updated: SkillSummaryDTO) => {
    setSkills((current) => current.map((skill) => skill.name === updated.name ? updated : skill));
    setSelected((current) => current?.name === updated.name ? { ...current, ...updated } : current);
  };

  const chooseFile = async (file: File | undefined) => {
    if (!file) return;
    setError("");
    setBusy(true);
    try {
      const isZip = file.name.toLowerCase().endsWith(".zip");
      if (!isZip && file.name.toLowerCase() !== "skill.md") throw new Error(zh ? "仅支持 SKILL.md 或 ZIP。" : "Choose SKILL.md or a ZIP package.");
      if (file.size > (isZip ? 2 * 1024 * 1024 : 512_000)) throw new Error(zh ? "文件超出大小限制。" : "File exceeds the size limit.");
      let input: SkillImportInputDTO;
      if (isZip) {
        const dataBase64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(reader.error ?? new Error("Unable to read Skill ZIP"));
          reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
          reader.readAsDataURL(file);
        });
        input = { format: "zip", dataBase64 };
      } else input = { format: "markdown", markdown: await file.text() };
      const preview = await api.skills.previewImport(input);
      if (!preview.canReplace) throw new Error(zh ? "内置 Skill 不能替换。" : "A built-in Skill cannot be replaced.");
      setPendingImport({ input, preview });
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  };

  const finishImport = async () => {
    if (!pendingImport) return;
    setBusy(true);
    setError("");
    try {
      const input = pendingImport.preview.existingVersion === null ? pendingImport.input
        : { ...pendingImport.input, replaceVersion: pendingImport.preview.existingVersion };
      const skill = await api.skills.import(input);
      await refresh();
      setSelected(await api.skills.get(skill.name));
      setPendingImport(null);
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };

  const toggle = async (skill: SkillSummaryDTO, input: { agentEnabled?: boolean; chatId?: string; chatEnabled?: boolean }) => {
    setBusy(true);
    setError("");
    try { updateSummary(await api.skills.enable(skill.name, { expectedVersion: skill.version, ...input })); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); await refresh().catch(() => undefined); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    if (!pendingDelete) return;
    setBusy(true);
    setError("");
    try {
      await api.skills.delete(pendingDelete.name, pendingDelete.version);
      setPendingDelete(null);
      setSelected((current) => current?.name === pendingDelete.name ? null : current);
      await refresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };

  return <div className="space-y-3 text-xs text-ink-200" data-testid="agent-skills-panel">
    <div className="flex items-center justify-between gap-2">
      <span className="font-semibold">{zh ? "Skill 任务方法" : "Skill methods"}</span>
      <label className="cursor-pointer rounded-md border border-white/15 px-2 py-1 hover:bg-white/[0.06]">
        {busy ? (zh ? "处理中…" : "Working…") : (zh ? "导入 Skill" : "Import Skill")}
        <input ref={fileRef} className="sr-only" type="file" accept=".md,.zip,text/markdown,application/zip" disabled={busy} onChange={(event) => void chooseFile(event.target.files?.[0])} />
      </label>
    </div>
    <p className="leading-5 text-ink-300">{zh ? "只读取已启用的方法；脚本与依赖不会运行。" : "Only enabled methods can be read. Scripts and dependencies are never run."}</p>
    {error ? <p className="rounded-md bg-rose-500/10 p-2 text-rose-300" role="alert">{error}</p> : null}
    <div className="max-h-64 space-y-2 overflow-y-auto">
      {skills.map((skill) => <div key={skill.name} className="rounded-lg border border-white/10 p-2">
        <button type="button" className="text-left font-medium text-ink-50 underline-offset-2 hover:underline" onClick={() => void api.skills.get(skill.name).then((detail) => { setSelected(detail); setReference(null); }).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)))}>{skill.name}</button>
        <p className="mt-1 leading-5">{skill.description}</p>
        {skill.compatibility || skill.unsupportedFiles.length ? <p className="mt-1 text-amber-200">{zh ? "兼容性限制" : "Compatibility limit"}: {[skill.compatibility, ...skill.unsupportedFiles].filter(Boolean).join(", ")}</p> : null}
        <div className="mt-2 flex flex-wrap gap-3">
          <label className="flex items-center gap-1"><input type="checkbox" checked={skill.agentEnabled} disabled={busy} onChange={() => void toggle(skill, { agentEnabled: !skill.agentEnabled })} />{zh ? "剧情助手" : "Story assistant"}</label>
          <label className="flex items-center gap-1"><input type="checkbox" checked={skill.enabledChatIds.includes(chatId)} disabled={busy} onChange={() => void toggle(skill, { chatId, chatEnabled: !skill.enabledChatIds.includes(chatId) })} />{zh ? "当前聊天" : "Current chat"}</label>
          {skill.source === "imported" ? <button type="button" className="text-rose-300 hover:underline" disabled={busy} onClick={() => setPendingDelete(skill)}>{zh ? "删除" : "Delete"}</button> : null}
        </div>
      </div>)}
    </div>
    {selected ? <div className="rounded-lg border border-white/10 p-2">
      <p className="font-semibold">{selected.name}</p>
      <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words text-ink-300">{selected.skillMd}</pre>
      {selected.referencePaths.map((path) => <button key={path} type="button" className="mt-2 block text-left text-blue-300 hover:underline" onClick={() => void api.skills.reference(selected.name, path).then((item) => setReference({ path, content: item.content })).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)))}>{path}</button>)}
      {reference ? <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words border-t border-white/10 pt-2 text-ink-300">{reference.path}{"\n"}{reference.content}</pre> : null}
    </div> : null}
    {pendingImport ? <ConfirmDialog
      title={pendingImport.preview.existingVersion === null ? (zh ? "导入 Skill" : "Import Skill") : (zh ? "更新同名 Skill" : "Replace existing Skill")}
      message={<span className="block space-y-2">
        <span className="block">{pendingImport.preview.name}: {pendingImport.preview.description}</span>
        <span className="block">{zh ? "参考文件" : "References"}: {pendingImport.preview.referencePaths.length}</span>
        {pendingImport.preview.unsupportedFiles.length ? <span className="block text-amber-200">{zh ? "不会运行的文件" : "Files that cannot run"}: {pendingImport.preview.unsupportedFiles.join(", ")}</span> : null}
        {pendingImport.preview.existingVersion !== null ? <span className="block">{zh ? "将替换现有版本，并关闭其启用状态。" : "This replaces the current version and disables it."}</span> : null}
        {!pendingImport.preview.canReplace ? <span className="block text-rose-300">{zh ? "内置 Skill 不能替换。" : "A built-in Skill cannot be replaced."}</span> : null}
      </span>}
      cancelLabel={zh ? "取消" : "Cancel"} confirmLabel={zh ? "确认导入" : "Import"}
      loading={busy} variant="primary" onCancel={() => setPendingImport(null)}
      onConfirm={() => { if (pendingImport.preview.canReplace) void finishImport(); }}
    /> : null}
    {pendingDelete ? <ConfirmDialog title={zh ? "删除 Skill" : "Delete Skill"}
      message={zh ? `删除 ${pendingDelete.name} 的本机方法和参考文件？` : `Delete local method and references for ${pendingDelete.name}?`}
      cancelLabel={zh ? "取消" : "Cancel"} confirmLabel={zh ? "删除" : "Delete"}
      loading={busy} onCancel={() => setPendingDelete(null)} onConfirm={() => void remove()} /> : null}
  </div>;
}
