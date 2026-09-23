import { ChevronDown, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type { CharacterRegexScriptDTO } from "@local-roleplay/shared";
import { api } from "../lib/api";
import { Button, Field, TextArea, TextInput } from "./ui";
import { LoreReorderHandle } from "./LoreReorderHandle";
import { useLoreOrderAnimation } from "./useLoreOrderAnimation";

export function CharacterRegexEditor({ scripts, language, onChange }: {
  scripts: CharacterRegexScriptDTO[];
  language: string;
  onChange: (scripts: CharacterRegexScriptDTO[]) => void;
}) {
  const zh = language === "zh-CN";
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const animation = useLoreOrderAnimation(scripts.map((script) => script.id).join(","), "regex");
  const [sample, setSample] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [role, setRole] = useState<"assistant" | "user">("assistant");
  const [stage, setStage] = useState<"stored" | "render">("stored");
  const [busy, setBusy] = useState(false);
  const ids = scripts.map((script) => script.id);

  const update = (index: number, patch: Partial<CharacterRegexScriptDTO>) =>
    onChange(scripts.map((script, position) => position === index ? { ...script, ...patch } : script));
  const move = (id: string, targetId: string) => {
    const next = [...scripts];
    const from = next.findIndex((script) => script.id === id);
    const to = next.findIndex((script) => script.id === targetId);
    if (from < 0 || to < 0 || from === to) return;
    animation.capture();
    next.splice(to, 0, next.splice(from, 1)[0]!);
    onChange(next);
  };
  const add = () => {
    const id = crypto.randomUUID();
    onChange([...scripts, { id, title: "", pattern: "", replacement: "", enabled: true, scope: "both", renderOnly: false }]);
    setExpandedId(id);
  };
  const preview = async () => {
    setBusy(true);
    setError("");
    try {
      const response = await api.characters.previewRegex({ scripts, content: sample, role, stage });
      setResult(response.content);
    } catch (caught) {
      setResult(null);
      setError(caught instanceof Error ? caught.message : (zh ? "预览失败" : "Preview failed"));
    } finally {
      setBusy(false);
    }
  };

  return <section className="space-y-4" data-character-field="regexScripts" data-testid="character-regex-editor">
    <div>
      <h3 className="text-sm font-semibold text-ink-100">{zh ? "正则脚本" : "Regex scripts"}</h3>
      <p className="mt-1 text-xs leading-5 text-ink-400">{zh ? "按列表顺序处理消息。入库规则影响后续提示词；仅渲染规则只改变聊天界面的显示。匹配模式使用 JavaScript 正则，替换文本支持 $1 等捕获组引用。" : "Rules run in list order. Stored rules affect future prompts; render-only rules change only chat display. Patterns use JavaScript regex and replacements support captures such as $1."}</p>
    </div>
    <div className="space-y-3" data-regex-list ref={animation.listRef}>
      {scripts.map((script, index) => {
        const expanded = expandedId === script.id;
        return <div
          className={`rounded-lg border transition-colors ${dropTarget === script.id ? "ring-2 ring-ember-500" : ""} ${script.enabled ? "border-white/10 bg-ink-950/40" : "border-white/5 bg-ink-950/20 opacity-60"}`}
          key={script.id}
          data-testid="character-regex-script"
          data-regex-order-id={script.id}
          data-regex-dragging={dragging === script.id || undefined}
          data-regex-drop-target={dropTarget === script.id || undefined}
          data-regex-expanded={expanded}
        >
          <div className="flex items-center justify-between gap-2 px-4 py-2">
            <div className="flex min-w-0 flex-1 items-center gap-1">
              <LoreReorderHandle kind="regex" id={script.id} ids={ids} language={language} onMove={move} onTarget={setDropTarget} onDragging={setDragging} />
              <button type="button" className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-left" aria-expanded={expanded} aria-label={zh ? `编辑正则脚本 ${index + 1}` : `Edit regex script ${index + 1}`} onClick={() => setExpandedId(expanded ? null : script.id)}>
                <ChevronDown className={`shrink-0 text-slate-500 transition-transform duration-200 ${expanded ? "" : "-rotate-90"}`} size={14} />
                <span className="truncate text-xs font-medium text-amber-200/80">{script.title || (zh ? `正则脚本 ${index + 1}` : `Regex script ${index + 1}`)}</span>
                {!expanded && script.pattern ? <span className="hidden truncate text-xs text-slate-500 sm:inline">— {script.pattern}</span> : null}
              </button>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <label className="flex cursor-pointer items-center gap-1.5 rounded-lg px-1.5 py-1 text-xs text-slate-400 hover:bg-white/5">
                <input type="checkbox" checked={script.enabled} onChange={(event) => update(index, { enabled: event.target.checked })} />{zh ? "启用" : "Enabled"}
              </label>
              <button type="button" aria-label={zh ? "删除脚本" : "Delete script"} className="rounded-lg p-1 text-slate-500 transition-colors hover:bg-red-500/10 hover:text-red-400" onClick={() => { onChange(scripts.filter((item) => item.id !== script.id)); if (expanded) setExpandedId(null); }}><Trash2 size={15} /></button>
            </div>
          </div>
          <div className={`overflow-hidden transition-all duration-200 ease-out ${expanded ? "max-h-[1000px] border-t border-white/5 opacity-100" : "max-h-0 border-t-0 opacity-0"}`} aria-hidden={!expanded} inert={!expanded}>
            <div className="space-y-3 px-4 pb-4 pt-3">
              <Field label={zh ? "标题" : "Title"}><TextInput value={script.title} onChange={(event) => update(index, { title: event.target.value })} /></Field>
              <Field label={zh ? "匹配模式" : "Match pattern"}><TextInput className="font-mono" value={script.pattern} onChange={(event) => update(index, { pattern: event.target.value })} /></Field>
              <Field label={zh ? "替换文本（留空会删除匹配内容）" : "Replacement (empty deletes matches)"}><TextArea className="min-h-20 font-mono" value={script.replacement} onChange={(event) => update(index, { replacement: event.target.value })} /></Field>
              <div className="flex flex-wrap items-center gap-4 text-sm text-ink-200">
                <label className="flex items-center gap-2"><input type="checkbox" checked={script.renderOnly} onChange={(event) => update(index, { renderOnly: event.target.checked })} />{zh ? "仅渲染" : "Render only"}</label>
                <label className="flex items-center gap-2">{zh ? "作用范围" : "Scope"}<select className="rounded-lg border border-white/10 bg-ink-900 px-2 py-2" value={script.scope} onChange={(event) => update(index, { scope: event.target.value as CharacterRegexScriptDTO["scope"] })}><option value="assistant">{zh ? "AI 输出" : "AI output"}</option><option value="user">{zh ? "用户输入" : "User input"}</option><option value="both">{zh ? "全部" : "Both"}</option></select></label>
              </div>
            </div>
          </div>
        </div>;
      })}
    </div>
    <Button variant="secondary" onClick={add}><Plus size={15} />{zh ? "新增脚本" : "Add script"}</Button>
    <div className="space-y-3 rounded-xl border border-white/10 bg-ink-950/35 p-4">
      <h4 className="text-sm font-semibold text-ink-100">{zh ? "测试输入" : "Test input"}</h4>
      <TextArea aria-label={zh ? "测试输入" : "Test input"} className="min-h-24" value={sample} onChange={(event) => setSample(event.target.value)} />
      <div className="flex flex-wrap gap-2">
        <select aria-label={zh ? "测试范围" : "Test role"} className="rounded-lg border border-white/10 bg-ink-900 px-2" value={role} onChange={(event) => setRole(event.target.value as typeof role)}><option value="assistant">{zh ? "AI 输出" : "AI output"}</option><option value="user">{zh ? "用户输入" : "User input"}</option></select>
        <select aria-label={zh ? "测试阶段" : "Test stage"} className="rounded-lg border border-white/10 bg-ink-900 px-2" value={stage} onChange={(event) => setStage(event.target.value as typeof stage)}><option value="stored">{zh ? "入库" : "Stored"}</option><option value="render">{zh ? "仅渲染" : "Render only"}</option></select>
        <Button disabled={busy} variant="secondary" onClick={() => void preview()}>{zh ? "预览结果" : "Preview"}</Button>
      </div>
      {error ? <p role="alert" className="text-xs text-rose-300">{error}</p> : null}
      {result !== null ? <pre className="whitespace-pre-wrap break-words rounded-lg bg-ink-900 p-3 text-xs text-ink-100" data-testid="character-regex-result">{result}</pre> : null}
    </div>
  </section>;
}
