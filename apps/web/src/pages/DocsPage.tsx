import { Copy } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "../components/ui";
import { useI18n } from "../i18n";

type DocsSection =
  | {
      id: string;
      title: string;
      description: string;
      kind: "overview";
      items: Array<{ label: string; value: string }>;
    }
  | {
      id: string;
      title: string;
      description: string;
      kind: "selectors";
      groups: Array<{
        title: string;
        items: Array<{ selector: string; detail: string }>;
      }>;
    }
  | {
      id: string;
      title: string;
      description: string;
      kind: "examples";
      examples: Array<{
        id: string;
        title: string;
        description: string;
        code: string;
      }>;
    };

const copyWithFallback = async (value: string) => {
  try {
    await navigator.clipboard.writeText(value);
    return;
  } catch {}

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
};

export function DocsPage() {
  const { language } = useI18n();
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const copy = useMemo(() => {
    if (language === "zh-CN") {
      return {
        intro:
          "这里先收纳聊天样式相关文档。后续继续添加使用教程、FAQ 或进阶案例时，直接追加新的 section 即可。",
        sections: [
          {
            id: "overview",
            title: "概览",
            description: "先确认编辑入口和生效规则，避免把样式写到错误的位置。",
            kind: "overview",
            items: [
              {
                label: "编辑入口",
                value: "角色页 -> 内置css"
              },
              {
                label: "生效范围",
                value: "当前角色的所有聊天共享同一套样式"
              },
              {
                label: "支持内容",
                value: "角色消息 HTML fragment + 聊天页官方选择器"
              },
              {
                label: "稳定承诺",
                value: "只保证本页列出的 id 和 data-chat-* 选择器长期稳定"
              }
            ]
          },
          {
            id: "selectors",
            title: "聊天样式选择器",
            description:
              "单例节点用 id，重复节点用 data 属性。后续扩展样式时优先使用这里的选择器。",
            kind: "selectors",
            groups: [
              {
                title: "官方 id",
                items: [
                  { selector: "#chat-page-root", detail: "聊天页根容器" },
                  { selector: "#chat-panel", detail: "主聊天面板容器" },
                  { selector: "#chat-title", detail: "聊天标题区域" },
                  { selector: "#chat-settings-trigger", detail: "右上角聊天设置按钮" },
                  { selector: "#chat-message-viewport", detail: "消息滚动视口" },
                  { selector: "#chat-message-list", detail: "消息列表容器" },
                  { selector: "#chat-pagination", detail: "消息分页条" },
                  { selector: "#chat-scroll-bottom", detail: "回到底部按钮" },
                  { selector: "#chat-quick-replies", detail: "快捷指令整体区域" },
                  { selector: "#chat-quick-replies-toggle", detail: "快捷指令折叠按钮" },
                  { selector: "#chat-composer", detail: "输入区外层容器" },
                  { selector: "#chat-message-input", detail: "消息输入框" },
                  { selector: "#chat-primary-action", detail: "发送或停止按钮" },
                  { selector: "#chat-empty-state", detail: "空状态区域" },
                  { selector: "#chat-opening-frame", detail: "开场 iframe" }
                ]
              },
              {
                title: "官方 data 属性",
                items: [
                  {
                    selector: '[data-chat-message="user|assistant|streaming|error|system"]',
                    detail: "每条消息的类型标记"
                  },
                  { selector: "[data-chat-bubble]", detail: "消息气泡主体" },
                  { selector: "[data-chat-avatar]", detail: "消息头像节点" },
                  { selector: "[data-chat-actions]", detail: "消息操作区" },
                  {
                    selector:
                      '[data-chat-action="copy|edit|delete|resend|regenerate|debug|variant-prev|variant-next|retry|dismiss|send|stop"]',
                    detail: "具体操作按钮"
                  },
                  { selector: "[data-chat-token-info]", detail: "token 统计信息" },
                  { selector: "[data-chat-quick-reply]", detail: "单个快捷指令按钮" }
                ]
              }
            ]
          },
          {
            id: "examples",
            title: "示例代码",
            description: "从这些片段开始最稳。先小范围改颜色和间距，再逐步加动画或版式。",
            kind: "examples",
            examples: [
              {
                id: "composer",
                title: "输入区和发送按钮",
                description: "统一输入区边框、背景和主按钮状态。",
                code: `#chat-composer {\n  border-color: rgba(251, 146, 60, 0.5) !important;\n  background: rgba(15, 23, 42, 0.9) !important;\n}\n\n#chat-message-input {\n  color: rgb(248, 250, 252) !important;\n}\n\n#chat-primary-action[data-chat-action="send"] {\n  background: linear-gradient(135deg, rgb(251, 146, 60), rgb(245, 158, 11));\n}`
              },
              {
                id: "assistant-bubble",
                title: "角色气泡和操作区",
                description: "只改 assistant 气泡，不影响 user 气泡。",
                code: `[data-chat-message="assistant"] [data-chat-bubble] {\n  background: rgba(30, 41, 59, 0.92) !important;\n  border-color: rgba(56, 189, 248, 0.25) !important;\n}\n\n[data-chat-message="assistant"] [data-chat-actions] {\n  border-top-color: rgba(56, 189, 248, 0.18) !important;\n}\n\n[data-chat-message="assistant"] [data-chat-action="copy"] {\n  color: rgb(125, 211, 252) !important;\n}`
              },
              {
                id: "quick-replies",
                title: "快捷指令区域",
                description: "调整快捷指令标签的层次感和交互反馈。",
                code: `#chat-quick-replies-toggle {\n  color: rgb(226, 232, 240) !important;\n}\n\n[data-chat-quick-reply] {\n  border-color: rgba(148, 163, 184, 0.28) !important;\n  background: rgba(15, 23, 42, 0.82) !important;\n}\n\n[data-chat-quick-reply]:hover {\n  border-color: rgba(251, 146, 60, 0.5) !important;\n}`
              }
            ]
          }
        ] satisfies DocsSection[],
        copied: "已复制",
        copy: "复制代码"
      };
    }

    return {
      intro:
        "This page starts with chat styling docs. Future tutorials, FAQs, and advanced examples can be added by appending new sections to the same page.",
      sections: [
        {
          id: "overview",
          title: "Overview",
          description:
            "Lock down the editing path and scope first so styles end up in the right place.",
          kind: "overview",
          items: [
            {
              label: "Edit path",
              value: "Characters -> Built-in CSS"
            },
            {
              label: "Scope",
              value: "All chats for the current character share the same style sheet"
            },
            {
              label: "Supported targets",
              value: "Character message HTML fragments + documented chat page selectors"
            },
            {
              label: "Stability promise",
              value: "Only the selectors listed on this page are treated as stable"
            }
          ]
        },
        {
          id: "selectors",
          title: "Chat Style Selectors",
          description:
            "Use ids for singletons and data attributes for repeated nodes. Prefer these selectors for all future styling work.",
          kind: "selectors",
          groups: [
            {
              title: "Official ids",
              items: [
                { selector: "#chat-page-root", detail: "Chat page root container" },
                { selector: "#chat-panel", detail: "Primary chat panel shell" },
                { selector: "#chat-title", detail: "Chat title region" },
                { selector: "#chat-settings-trigger", detail: "Top-right chat settings button" },
                { selector: "#chat-message-viewport", detail: "Scrollable message viewport" },
                { selector: "#chat-message-list", detail: "Message list container" },
                { selector: "#chat-pagination", detail: "Message pagination bar" },
                { selector: "#chat-scroll-bottom", detail: "Scroll-to-bottom button" },
                { selector: "#chat-quick-replies", detail: "Quick command area" },
                { selector: "#chat-quick-replies-toggle", detail: "Quick command collapse toggle" },
                { selector: "#chat-composer", detail: "Composer outer container" },
                { selector: "#chat-message-input", detail: "Message input field" },
                { selector: "#chat-primary-action", detail: "Send or stop button" },
                { selector: "#chat-empty-state", detail: "Empty-state container" },
                { selector: "#chat-opening-frame", detail: "Opening iframe" }
              ]
            },
            {
              title: "Official data attributes",
              items: [
                {
                  selector: '[data-chat-message="user|assistant|streaming|error|system"]',
                  detail: "Message type marker"
                },
                { selector: "[data-chat-bubble]", detail: "Message bubble body" },
                { selector: "[data-chat-avatar]", detail: "Avatar node" },
                { selector: "[data-chat-actions]", detail: "Message action row" },
                {
                  selector:
                    '[data-chat-action="copy|edit|delete|resend|regenerate|debug|variant-prev|variant-next|retry|dismiss|send|stop"]',
                  detail: "Specific action button"
                },
                { selector: "[data-chat-token-info]", detail: "Token usage display" },
                { selector: "[data-chat-quick-reply]", detail: "Single quick command button" }
              ]
            }
          ]
        },
        {
          id: "examples",
          title: "Example CSS",
          description:
            "Start with small visual changes first. Then add motion or layout once the selector scope is stable.",
          kind: "examples",
          examples: [
            {
              id: "composer",
              title: "Composer and primary action",
              description: "Restyle the input shell, field, and send state together.",
              code: `#chat-composer {\n  border-color: rgba(251, 146, 60, 0.5) !important;\n  background: rgba(15, 23, 42, 0.9) !important;\n}\n\n#chat-message-input {\n  color: rgb(248, 250, 252) !important;\n}\n\n#chat-primary-action[data-chat-action="send"] {\n  background: linear-gradient(135deg, rgb(251, 146, 60), rgb(245, 158, 11));\n}`
            },
            {
              id: "assistant-bubble",
              title: "Assistant bubble and actions",
              description: "Target only assistant messages without changing user bubbles.",
              code: `[data-chat-message="assistant"] [data-chat-bubble] {\n  background: rgba(30, 41, 59, 0.92) !important;\n  border-color: rgba(56, 189, 248, 0.25) !important;\n}\n\n[data-chat-message="assistant"] [data-chat-actions] {\n  border-top-color: rgba(56, 189, 248, 0.18) !important;\n}\n\n[data-chat-message="assistant"] [data-chat-action="copy"] {\n  color: rgb(125, 211, 252) !important;\n}`
            },
            {
              id: "quick-replies",
              title: "Quick command strip",
              description: "Adjust the quick command affordance and chip treatment.",
              code: `#chat-quick-replies-toggle {\n  color: rgb(226, 232, 240) !important;\n}\n\n[data-chat-quick-reply] {\n  border-color: rgba(148, 163, 184, 0.28) !important;\n  background: rgba(15, 23, 42, 0.82) !important;\n}\n\n[data-chat-quick-reply]:hover {\n  border-color: rgba(251, 146, 60, 0.5) !important;\n}`
            }
          ]
        }
      ] satisfies DocsSection[],
      copied: "Copied",
      copy: "Copy CSS"
    };
  }, [language]);

  const copyExample = async (id: string, code: string) => {
    await copyWithFallback(code);
    setCopiedId(id);
    window.setTimeout(() => {
      setCopiedId((current) => (current === id ? null : current));
    }, 1400);
  };

  return (
    <div
      id="docs-page-root"
      className="mx-auto flex max-w-5xl min-w-0 flex-col gap-6"
      data-testid="docs-page-root"
    >
      <section className="overflow-hidden rounded-2xl border border-white/5 bg-ink-900/80 p-5 shadow-lg shadow-black/20 backdrop-blur-sm sm:p-6">
        <p className="max-w-3xl text-sm leading-7 text-slate-300">{copy.intro}</p>
        <nav className="mt-4 flex flex-wrap gap-2">
          {copy.sections.map((section) => (
            <a
              key={section.id}
              href={`#${section.id}`}
              className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:border-ember-500/40 hover:text-ember-200"
            >
              {section.title}
            </a>
          ))}
        </nav>
      </section>

      {copy.sections.map((section) => (
        <section
          key={section.id}
          id={section.id}
          className="overflow-hidden rounded-2xl border border-white/5 bg-ink-900/80 p-5 shadow-lg shadow-black/20 backdrop-blur-sm sm:p-6"
        >
          <div className="max-w-3xl">
            <h3 className="text-lg font-semibold tracking-tight text-slate-100">{section.title}</h3>
            <p className="mt-2 text-sm leading-7 text-slate-400">{section.description}</p>
          </div>

          {section.kind === "overview" ? (
            <div className="mt-5 grid gap-3 md:grid-cols-2">
              {section.items.map((item) => (
                <article
                  key={item.label}
                  className="rounded-xl border border-white/5 bg-white/[0.03] p-4"
                >
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                    {item.label}
                  </p>
                  <p className="mt-2 text-sm leading-6 text-slate-200">{item.value}</p>
                </article>
              ))}
            </div>
          ) : null}

          {section.kind === "selectors" ? (
            <div className="mt-5 grid min-w-0 gap-4 xl:grid-cols-2">
              {section.groups.map((group) => (
                <article
                  key={group.title}
                  className="min-w-0 rounded-xl border border-white/5 bg-white/[0.03] p-4"
                >
                  <h4 className="text-sm font-semibold text-slate-100">{group.title}</h4>
                  <div className="mt-3 space-y-3">
                    {group.items.map((item) => (
                      <div
                        key={item.selector}
                        className="rounded-lg border border-white/5 bg-ink-950/50 px-3 py-2.5"
                      >
                        <code className="block overflow-x-auto whitespace-nowrap text-xs text-ember-200">
                          {item.selector}
                        </code>
                        <p className="mt-1 text-sm leading-6 text-slate-300">{item.detail}</p>
                      </div>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          ) : null}

          {section.kind === "examples" ? (
            <div className="mt-5 grid min-w-0 gap-4 xl:grid-cols-2">
              {section.examples.map((example) => (
                <article
                  key={example.id}
                  className="min-w-0 rounded-xl border border-white/5 bg-white/[0.03] p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <h4 className="text-sm font-semibold text-slate-100">{example.title}</h4>
                      <p className="mt-1 text-sm leading-6 text-slate-400">{example.description}</p>
                    </div>
                    <Button
                      className="!min-h-[34px] !px-3 text-xs"
                      variant="secondary"
                      onClick={() => void copyExample(example.id, example.code)}
                    >
                      <Copy size={13} />
                      {copiedId === example.id ? copy.copied : copy.copy}
                    </Button>
                  </div>
                  <pre className="custom-scrollbar mt-4 overflow-x-auto rounded-xl border border-white/5 bg-ink-950/80 p-4 text-xs leading-6 text-slate-200">
                    <code>{example.code}</code>
                  </pre>
                </article>
              ))}
            </div>
          ) : null}
        </section>
      ))}
    </div>
  );
}
