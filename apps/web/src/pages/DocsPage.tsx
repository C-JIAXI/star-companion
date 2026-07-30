import {
  BookOpen,
  Bot,
  Brush,
  Check,
  ClipboardList,
  Code2,
  Copy,
  Database,
  MessageSquareText,
  ShieldCheck,
  type LucideIcon
} from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "../components/ui";
import { useI18n } from "../i18n";

type GuideSection = {
  id: string;
  title: string;
  description: string;
  kind: "guide";
  items: Array<{
    title: string;
    body: string;
  }>;
  note?: string;
};

type SelectorSection = {
  id: string;
  title: string;
  description: string;
  kind: "selectors";
  groups: Array<{
    title: string;
    items: Array<{ selector: string; detail: string }>;
  }>;
  examples: Array<{
    id: string;
    title: string;
    description: string;
    code: string;
  }>;
};

type DocsSection = GuideSection | SelectorSection;

type DocsCopy = {
  eyebrow: string;
  intro: string;
  navLabel: string;
  copy: string;
  copied: string;
  quickFacts: Array<{
    label: string;
    value: string;
  }>;
  sections: DocsSection[];
};

const sectionIcons: Record<string, LucideIcon> = {
  "quick-start": ClipboardList,
  "chat-workbench": MessageSquareText,
  "characters-guide": Bot,
  "settings-security": ShieldCheck,
  backup: Database,
  appearance: Brush
};

const composerCss = `#chat-composer {
  border-color: rgba(251, 146, 60, 0.5) !important;
  background: rgba(15, 23, 42, 0.9) !important;
}

#chat-message-input {
  color: rgb(248, 250, 252) !important;
}

#chat-primary-action[data-chat-action="send"] {
  background: linear-gradient(135deg, rgb(251, 146, 60), rgb(245, 158, 11));
}`;

const assistantBubbleCss = `[data-chat-message="assistant"] [data-chat-bubble] {
  background: rgba(30, 41, 59, 0.92) !important;
  border-color: rgba(56, 189, 248, 0.25) !important;
}

[data-chat-message="assistant"] [data-chat-actions] {
  border-top-color: rgba(56, 189, 248, 0.18) !important;
}

[data-chat-message="assistant"] [data-chat-action="copy"] {
  color: rgb(125, 211, 252) !important;
}`;

const quickRepliesCss = `#chat-quick-replies-toggle {
  color: rgb(226, 232, 240) !important;
}

[data-chat-quick-reply] {
  border-color: rgba(148, 163, 184, 0.28) !important;
  background: rgba(15, 23, 42, 0.82) !important;
}

[data-chat-quick-reply]:hover {
  border-color: rgba(251, 146, 60, 0.5) !important;
}`;

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

const getDocsCopy = (language: string): DocsCopy => {
  if (language === "zh-CN") {
    return {
      eyebrow: "应用内手册",
      intro:
        "按日常工作流整理模型设置、角色创建、聊天管理、记忆、备份迁移和界面样式。新用户可以顺序阅读，熟悉后也可以直接跳到样式参考。",
      navLabel: "文档章节",
      copy: "复制 CSS",
      copied: "已复制",
      quickFacts: [
        { label: "使用范围", value: "本应用专注你和一个角色的一对一聊天，不提供群聊或单独世界书页面。" },
        { label: "密钥安全", value: "API Key 只在设置页填写和保存，不要写进角色设定或聊天内容。" },
        { label: "外观定制", value: "想调整聊天外观时，可以在角色里填写内置 CSS；下方样式参考列出可使用的位置。" }
      ],
      sections: [
        {
          id: "quick-start",
          title: "快速上手",
          description: "第一次使用时，按这个顺序完成基础配置。",
          kind: "guide",
          items: [
            {
              title: "连接模型服务",
              body: "从聊天就绪状态点击缺项可直接进入供应商管理的对应步骤。依次添加模型服务、填写 API Key（本机无鉴权服务可省略）、选择聊天模型，保存后运行真实模型连接测试。"
            },
            {
              title: "创建原创角色",
              body: "想立即开始时，可在“新建聊天”中使用快速创建，只填写名称和核心设定；需要标签、提示词分段、lore、快捷回复或样式时，再进入角色工坊使用高级编辑器。编辑器会标记未保存状态，并在返回、新建角色、切换页面或刷新前提醒。"
            },
            {
              title: "开始聊天",
              body: "可从桌面侧栏、移动端顶部或聊天空状态点击“新建聊天”，选择已有角色或快速创建角色后立即进入对话；也可以在角色卡上直接点击游玩。"
            },
            {
              title: "逐步调整",
              body: "如果回复不稳定，优先调整角色提示词；如果是本段聊天的用户身份或偏好，放进聊天设置里的用户设定。"
            }
          ],
          note: "API Key 只需要在设置页填写一次，聊天时不需要重复输入。"
        },
        {
          id: "chat-workbench",
          title: "聊天工作台",
          description: "聊天页负责消息管理、回复生成、聊天设置和单段聊天外观。",
          kind: "guide",
          items: [
            {
              title: "发送与停止",
              body: "输入消息后发送。生成期间可继续输入并加入待发送队列；队列可编辑、删除或立即发送，当前回复结束后会合并为下一条消息自动发送。队列只在当前应用会话中保留。停止后仍保留已经流式返回的内容。"
            },
            {
              title: "消息操作",
              body: "用户消息可复制、编辑、删除、重发；角色回复可复制、编辑、删除、重新生成，并在有候选版本时切换变体。重发历史用户消息会先提示将替换的后续消息；确认框可直接创建保留完整原剧情的分支，并在分支中重发。"
            },
            {
              title: "聊天设置",
              body: "右上角设置菜单可调整记忆轮数、长期记忆、聊天背景、用户设定、用户画像摘要和当前模型。长期记忆可在设置页单独指定记忆向量模型，使用语义与关键词混合召回；未配置或接口失败时会自动退回关键词。"
            },
            {
              title: "剧情路径",
              body: "可从任意消息创建分支或保存检查点。聊天工具栏中的剧情路径会展示当前聊天的来路和直接子分支；返回原聊天时会自动定位并高亮当时的分叉消息。"
            },
            {
              title: "AI 标题草案",
              body: "聊天工具栏可根据当前已纳入上下文的消息生成简短标题草案。草案会先放入标题编辑框，确认后才会保存。默认新聊天在首轮对话完成后会自动生成一次标题，手动命名不会被覆盖。"
            },
            {
              title: "继续上次聊天",
              body: "刷新页面或重新打开应用后，会自动恢复上次选择的聊天；已经删除的聊天不会继续占用当前工作区。"
            },
            {
              title: "聊天归档",
              body: "桌面侧栏和移动抽屉会直接显示最多六段置顶或最近活跃聊天，可一步切换。移动端顶部搜索入口与完整历史可在聊天标题和全部消息之间切换，并直接跳到命中消息；也可归档已完成的聊天而不删除消息或长期记忆，管理模式支持批量归档与恢复。"
            },
            {
              title: "聊天回收站",
              body: "删除聊天会先移入回收站并保留消息与长期记忆，可单个或批量恢复。永久删除只在回收站中提供，并有独立确认；回收站状态会进入完整备份和局域网同步。"
            },
            {
              title: "可读聊天记录",
              body: "聊天设置可预览并导出 Markdown 或纯文本记录，也可直接复制。导出内容包含标题、角色和消息，可选择是否附带每条消息时间；历史列表的一键下载默认使用 Markdown。JSON 聊天归档仍用于完整恢复。"
            },
            {
              title: "语音与图片",
              body: "输入框工具可录音转写、朗读最近回复和生成图片；每条助手回复也可单独朗读或停止。尚未配置兼容模型时，这些入口会直接定位到设置页对应的模块模型下拉框。设置页可指定文字朗读的声音 ID、0.5–2 倍播放速度，并选择是否自动朗读当前聊天中新收到的助手回复。图片会先在预览中展示，确认后才插入输入框。"
            },
            {
              title: "快捷指令",
              body: "角色配置快捷回复后，会显示在输入区上方。点击指令会把预设内容填入输入框，适合常用动作或开场问题。"
            }
          ],
          note: "删除助手回复只影响当前一条；删除用户消息会同时删除其后的全部消息，确认框会显示总数与目标预览。重发历史用户消息会保留该条消息但替换其后的剧情；可在确认框中直接创建完整原剧情的分支并在分支中重发。两种操作都会停用来源于已移除剧情的长期记忆。"
        },
        {
          id: "characters-guide",
          title: "角色工坊",
          description: "角色卡决定角色如何说话、如何回应，以及何时补充背景信息。",
          kind: "guide",
          items: [
            {
              title: "角色设定",
              body: "把角色身份、背景、目标、语气、关系和互动边界写清楚。封面可填写 HTTPS 图片地址，也可选择 2 MB 内的本地 PNG、JPEG、WebP、GIF 或 AVIF 图片。"
            },
            {
              title: "标签与筛选",
              body: "为角色添加标签后，角色列表会显示标签筛选；搜索框只按角色名称和简介查找，不会匹配提示词内容。批量管理可为当前选中的角色统一添加或移除标签。常用角色可收藏，并可按收藏、最近聊天、聊天数量、更新时间或名称整理角色库。"
            },
            {
              title: "背景词条",
              body: "需要在特定关键词出现时补充背景信息，可以为角色添加背景词条，让聊天自动带入相关设定。"
            },
            {
              title: "列表信息",
              body: "角色卡片会显示标签、创建时间和最后更新时间，方便按维护状态和整理维度快速判断。"
            },
            {
              title: "内置 CSS",
              body: "内置样式可美化角色回复里的卡片和排版，也能在该角色聊天中调整气泡、输入区和快捷指令外观。"
            },
            {
              title: "开场 HTML 与导入导出",
              body: "开场页面适合展示角色介绍、序章或欢迎页；角色卡支持导入导出和复制。副本会获得新的角色卡身份，私密角色的副本仍保持加密。再次导入同一张角色卡会更新原角色，即使角色名称已变更。"
            }
          ],
          note: "建议先完善角色设定、标签和背景词条，再按需要添加快捷指令和视觉样式。"
        },
        {
          id: "settings-security",
          title: "设置与安全",
          description: "模型连接、界面语言和显示偏好都在设置页维护。",
          kind: "guide",
          items: [
            {
              title: "API Key",
              body: "API Key 只保存在本地配置中，运行时代码会加密保存；界面不会展示已保存密钥的明文。"
            },
            {
              title: "模型服务",
              body: "从模板快速添加模型服务，或自定义创建。每个服务可以单独保存地址、API Key 和模型列表。"
            },
            {
              title: "模型切换",
              body: "在设置页选择模型即可切换聊天使用的模型，聊天页也支持快速切换。"
            },
            {
              title: "语言与头像",
              body: "支持中文和英文界面，也可以控制聊天消息头像是否显示。"
            }
          ],
          note: "请只在设置页填写 API Key，不要把密钥写进角色设定、聊天内容或样式代码。"
        },
        {
          id: "backup",
          title: "备份与恢复",
          description: "备份功能用于保存本地数据，也可以把数据带到另一台设备或新的本地环境。",
          kind: "guide",
          items: [
            {
              title: "导出范围",
              body: "完整备份包含角色、角色收藏状态、聊天和消息；设置会导出模型服务和参数，但不会导出 API Key。角色收藏属于本地偏好，不会写入可分享的角色卡文件。"
            },
            {
              title: "合并导入",
              body: "合并导入会保留现有数据，更新本地已有且备份中也包含的内容，并添加新的内容，适合补充导入。"
            },
            {
              title: "替换导入",
              body: "替换导入会清空现有角色、聊天和消息后再导入，但不会清除本地 API Key。"
            },
            {
              title: "导入前检查",
              body: "导入前确认备份来源可信，并理解当前模式会怎样影响本地内容。"
            }
          ],
          note: "导入前建议先导出现有备份，方便需要时恢复。"
        },
        {
          id: "appearance",
          title: "样式参考",
          description:
            "如果你会写 CSS，可以用这里列出的位置来调整聊天界面外观。",
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
                { selector: "#chat-primary-action", detail: "发送或加入队列按钮" },
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
          ],
          examples: [
            {
              id: "composer",
              title: "输入区和发送按钮",
              description: "统一输入区边框、背景和主按钮状态。",
              code: composerCss
            },
            {
              id: "assistant-bubble",
              title: "角色气泡和操作区",
              description: "只改 assistant 气泡，不影响 user 气泡。",
              code: assistantBubbleCss
            },
            {
              id: "quick-replies",
              title: "快捷指令区域",
              description: "调整快捷指令标签的层次感和交互反馈。",
              code: quickRepliesCss
            }
          ]
        }
      ]
    };
  }

  return {
    eyebrow: "In-App Manual",
    intro:
      "A practical guide for model setup, character creation, chat management, memory, backups, and appearance styling. Read it in order when getting started, or jump straight to the styling reference when refining a character.",
    navLabel: "Documentation sections",
    copy: "Copy CSS",
    copied: "Copied",
    quickFacts: [
      {
        label: "Product scope",
        value:
          "The app focuses on one-on-one chats between you and one character. It does not include group chat or a separate worldbook page."
      },
      {
        label: "Key safety",
        value:
          "Enter API keys only in Settings. Do not place keys in character setup or chat messages."
      },
      {
        label: "Appearance",
        value: "Use a character's built-in CSS to adjust chat appearance. The styling reference lists the available places to target."
      }
    ],
    sections: [
      {
        id: "quick-start",
        title: "Quick Start",
        description: "Complete the foundation in this order the first time you use the app.",
        kind: "guide",
        items: [
          {
            title: "Connect a model service",
            body: "Open a missing item from Chat Readiness to jump directly to the matching Provider Management step. Add a service, enter its API key (optional for unauthenticated local services), choose a chat model, save, then run the real model connection test."
          },
          {
            title: "Create an original character",
            body: "For the fastest start, use Quick Create in New Chat and enter only a name and core definition. Open Character Studio when you need tags, prompt sections, lore, quick replies, or styling. The editor marks unsaved work and warns before returning, starting another character, changing pages, or refreshing."
          },
          {
            title: "Start chatting",
            body: "Use New Chat from the desktop sidebar, mobile header, or empty chat state to choose an existing character or quick-create one and enter the conversation immediately. You can also click Play on a character card."
          },
          {
            title: "Refine gradually",
            body: "If replies drift, adjust the character prompt first. Put chat-specific user identity or preferences in chat settings."
          }
        ],
        note: "Enter your API key once in Settings. You do not need to paste it again while chatting."
      },
      {
        id: "chat-workbench",
        title: "Chat Workbench",
        description:
          "The chat page handles message management, reply generation, chat settings, and per-chat appearance.",
        kind: "guide",
        items: [
          {
            title: "Send and stop",
            body: "Send from the composer. While generation streams, new messages can be queued, edited, deleted, or sent immediately. The queue is combined into the next message after the current reply and lasts only for the current app session. Stopping keeps content already received."
          },
          {
            title: "Message actions",
            body: "User messages can be copied, edited, deleted, or resent. Character replies can be copied, edited, deleted, regenerated, continued when they are the latest reply, and switched between variants. Resending a historical user message first previews the following messages it will replace; the confirmation can create a branch that preserves the full original path, then resend in that branch."
          },
          {
            title: "Chat settings",
            body: "The top-right menu controls memory turns, long-term memory, chat background, user notes, profile summary, and the active model. Settings can assign a separate memory embedding model for hybrid semantic and keyword retrieval, with automatic keyword fallback."
          },
          {
            title: "AI title draft",
            body: "The chat toolbar can generate a concise title from messages included in context. The suggestion stays in the title editor until you confirm it. Default new chats also receive one title automatically after their first exchange, without overwriting manual names."
          },
          {
            title: "Resume the last chat",
            body: "After a refresh or restart, the app restores the last selected chat and clears the selection if that chat no longer exists."
          },
            {
              title: "Chat archives",
              body: "History can export a single chat archive with its character, messages, and long-term memories. Importing always creates a separate chat and never replaces the source."
            },
            {
              title: "Chat Trash",
              body: "Deleting a chat first moves it to Trash while keeping its messages and long-term memories. Chats can be restored individually or in batches. Permanent deletion is only available in Trash behind a separate confirmation, and Trash state is included in full backups and LAN sync."
            },
          {
            title: "Readable transcripts",
            body: "Chat settings can preview, copy, or download Markdown and plain-text transcripts with the title, character, and messages. Per-message timestamps are optional, while the History shortcut downloads Markdown by default. JSON chat archives remain the complete restore format."
          },
          {
            title: "Search every chat",
            body: "The desktop sidebar and mobile drawer expose up to six pinned or recently active chats for one-step switching. The mobile header offers direct global search, while full History can switch from chat titles to message content and open a matching conversation at that exact message."
          },
          {
            title: "Pin important chats",
            body: "Use the pin action in History to keep frequently used chats above newer conversations. Pin state is included in backups and manual LAN sync."
          },
          {
            title: "Archive completed chats",
            body: "Archive hides a completed chat from active History without deleting its messages or memories. History management mode can archive or restore several chats together; global message search still includes archived chats."
          },
          {
            title: "Story checkpoints",
            body: "Save a checkpoint from any user or assistant message to preserve a story snapshot without switching away from the current chat. Checkpoints stay linked to their source and can be opened later from History."
          },
          {
            title: "Story paths",
            body: "Open Story paths from the chat toolbar to see the current ancestry and every direct branch or checkpoint. Returning to the source chat jumps to and highlights the message where the path split."
          },
          {
            title: "Message bookmarks",
            body: "Bookmark any user or assistant message, then open the chat toolbar bookmarks list to return to that turn. Bookmarks are saved with backups, chat archives, and branches, but never change model or Agent context."
          },
          {
            title: "Voice and images",
            body: "Composer tools transcribe recordings, read the latest reply, and generate images; each assistant reply can also be narrated or stopped individually. When no compatible model is configured, these controls jump directly to the matching module-model selector in Settings. Settings let you choose a speech voice ID, a 0.5–2x playback rate, and automatic playback for new assistant replies in the current chat. Images are previewed before you insert one into the composer."
          },
          {
            title: "Quick commands",
            body: "When a character defines quick replies, they appear above the composer and fill the input with reusable actions or prompts."
          }
        ],
        note: "Deleting an assistant reply removes only that message. Deleting a user message also removes every message after it; the confirmation shows the total and a target preview. Resending a historical user message keeps it but replaces everything after it. The confirmation can create a branch with the complete original path and resend there instead. Both operations disable long-term memories sourced from the removed path."
      },
      {
        id: "characters-guide",
        title: "Character Workshop",
        description:
          "Character cards decide how a character speaks, responds, and brings in background details.",
        kind: "guide",
        items: [
          {
            title: "Character setup",
            body: "Describe the character's identity, background, goals, voice, relationship, and interaction boundaries. Covers can use an HTTPS URL or a local PNG, JPEG, WebP, GIF, or AVIF image up to 2 MB."
          },
          {
            title: "Tags and filtering",
            body: "Add tags to organize characters. Search only matches names and descriptions. Batch management can add or remove tags across the current selection. Favorite frequent characters, then sort the library by favorites, recent chats, chat count, update time, or name."
          },
          {
            title: "Background entries",
            body: "Add background entries when certain keywords should bring extra character details into the chat automatically."
          },
          {
            title: "List metadata",
            body: "Character cards show tags, creation time, and last updated time so you can scan organization and maintenance state quickly."
          },
          {
            title: "Built-in CSS",
            body: "Built-in styles can shape cards and formatting in character replies, and can adjust bubbles, the composer, and quick commands for that character's chats."
          },
          {
            title: "Opening HTML and import/export",
            body: "Opening pages are useful for introductions, prologues, or welcome screens. Character cards support import, export, and duplication. A duplicate receives a new card identity, while private duplicates stay encrypted. Re-importing the same card updates the existing character even if its name changed."
          }
        ],
        note: "Start with the character setup, tags, and background entries, then add quick commands and visual styling as needed."
      },
      {
        id: "settings-security",
        title: "Settings and Security",
        description:
          "Settings manages model connection, language, and display preferences.",
        kind: "guide",
        items: [
          {
            title: "API keys",
            body: "API keys are stored only in local configuration. The interface does not reveal the saved key after it is stored."
          },
          {
            title: "Model services",
            body: "Add model services from templates or create custom ones. Each service can keep its own address, API key, and model list."
          },
          {
            title: "Model switching",
            body: "Choose a model in Settings to switch what chat uses. The chat page also supports quick model switching."
          },
          {
            title: "Language and avatars",
            body: "Switch between Chinese and English, and choose whether message avatars are shown."
          }
        ],
        note: "Only enter API keys in Settings. Do not place keys in character setup, chat messages, or style code."
      },
      {
        id: "backup",
        title: "Backups and Restore",
        description: "Backups save local data and can help move it to another device or local environment.",
        kind: "guide",
        items: [
          {
            title: "Export contents",
            body: "Full backups include characters, local favorite state, chats, and messages. Settings export model services and parameters, but not the API key. Favorite state is not written into shareable character card files."
          },
          {
            title: "Merge import",
            body: "Merge import keeps existing data, updates local content that also appears in the backup, and adds new content. Use it when you want to add to what you already have."
          },
          {
            title: "Replace import",
            body: "Replace import clears existing characters, chats, and messages before importing, but it does not clear the local API key."
          },
          {
            title: "Check before importing",
            body: "Confirm the backup source is trusted and understand how the selected mode will affect your local content."
          }
        ],
        note: "Export a backup before importing so you can restore the previous state if needed."
      },
      {
        id: "appearance",
        title: "Appearance Reference",
        description:
          "If you write CSS, use these available places to adjust the chat interface.",
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
              { selector: "#chat-primary-action", detail: "Send or queue button" },
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
        ],
        examples: [
          {
            id: "composer",
            title: "Composer and primary action",
            description: "Restyle the input shell, field, and send state together.",
            code: composerCss
          },
          {
            id: "assistant-bubble",
            title: "Assistant bubble and actions",
            description: "Target only assistant messages without changing user bubbles.",
            code: assistantBubbleCss
          },
          {
            id: "quick-replies",
            title: "Quick command strip",
            description: "Adjust the quick command affordance and chip treatment.",
            code: quickRepliesCss
          }
        ]
      }
    ]
  };
};

function SectionHeading({ section }: { section: DocsSection }) {
  const Icon = sectionIcons[section.id] ?? BookOpen;

  return (
    <div className="flex min-w-0 items-start gap-3">
      <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-md border border-white/[0.1] bg-white/[0.04] text-ember-200">
        <Icon size={18} />
      </span>
      <div className="min-w-0">
        <h3 className="text-lg font-semibold text-ink-50">{section.title}</h3>
        <p className="mt-2 max-w-3xl text-sm leading-7 text-slate-400">{section.description}</p>
      </div>
    </div>
  );
}

function GuideSectionView({ section }: { section: GuideSection }) {
  return (
    <>
      <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {section.items.map((item, index) => (
          <article
            key={item.title}
            className="min-w-0 rounded-lg border border-white/[0.08] bg-ink-900 p-4 transition-colors hover:border-white/[0.14] hover:bg-ink-800"
          >
            <p className="text-xs font-semibold tabular-nums text-ember-300">
              {String(index + 1).padStart(2, "0")}
            </p>
            <h4 className="mt-2 text-sm font-semibold text-slate-100">{item.title}</h4>
            <p className="mt-2 text-sm leading-6 text-slate-300">{item.body}</p>
          </article>
        ))}
      </div>
      {section.note ? (
        <p className="mt-4 rounded-lg border border-emerald-400/15 bg-emerald-400/[0.06] px-4 py-3 text-sm leading-6 text-emerald-50/90">
          {section.note}
        </p>
      ) : null}
    </>
  );
}

function SelectorSectionView({
  section,
  copiedId,
  copyLabel,
  copiedLabel,
  onCopy
}: {
  section: SelectorSection;
  copiedId: string | null;
  copyLabel: string;
  copiedLabel: string;
  onCopy: (id: string, code: string) => void;
}) {
  return (
    <div className="mt-5 space-y-6">
      <div className="grid min-w-0 gap-4 xl:grid-cols-2">
        {section.groups.map((group) => (
          <article
            key={group.title}
            className="min-w-0 rounded-lg border border-white/5 bg-white/[0.035] p-4"
          >
            <h4 className="text-sm font-semibold text-slate-100">{group.title}</h4>
            <div className="mt-4 divide-y divide-white/5 overflow-hidden rounded-lg border border-white/5 bg-ink-950/45">
              {group.items.map((item) => (
                <div key={item.selector} className="grid gap-1 px-3 py-3">
                  <code className="custom-scrollbar block overflow-x-auto whitespace-nowrap font-mono text-xs text-ember-200">
                    {item.selector}
                  </code>
                  <p className="text-sm leading-6 text-slate-300">{item.detail}</p>
                </div>
              ))}
            </div>
          </article>
        ))}
      </div>

      <div className="grid min-w-0 gap-4 xl:grid-cols-2">
        {section.examples.map((example) => {
          const copied = copiedId === example.id;
          return (
            <article
              key={example.id}
              className="min-w-0 rounded-lg border border-white/5 bg-white/[0.035] p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Code2 size={15} className="shrink-0 text-cyan-300" />
                    <h4 className="text-sm font-semibold text-slate-100">{example.title}</h4>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-slate-400">{example.description}</p>
                </div>
                <Button
                  className="!min-h-[34px] !px-3 text-xs"
                  variant="secondary"
                  onClick={() => onCopy(example.id, example.code)}
                >
                  {copied ? <Check size={13} /> : <Copy size={13} />}
                  {copied ? copiedLabel : copyLabel}
                </Button>
              </div>
              <pre className="custom-scrollbar mt-4 max-h-[360px] overflow-auto rounded-lg border border-white/5 bg-ink-950/80 p-4 font-mono text-xs leading-6 text-slate-200">
                <code>{example.code}</code>
              </pre>
            </article>
          );
        })}
      </div>
    </div>
  );
}

export function DocsPage() {
  const { language } = useI18n();
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copy = useMemo(() => getDocsCopy(language), [language]);

  const copyExample = async (id: string, code: string) => {
    try {
      await copyWithFallback(code);
    } catch {}
    setCopiedId(id);
    window.setTimeout(() => {
      setCopiedId((current) => (current === id ? null : current));
    }, 1400);
  };

  return (
    <div
      id="docs-page-root"
      className="mx-auto flex max-w-7xl min-w-0 flex-col gap-6"
      data-testid="docs-page-root"
    >
      <section className="border-b border-white/[0.08] pb-6">
        <div className="min-w-0">
          <p className="section-kicker text-ember-300">
            {copy.eyebrow}
          </p>
          <p className="mt-3 max-w-4xl text-sm leading-7 text-slate-300">{copy.intro}</p>
        </div>
        <div className="mt-5 grid divide-y divide-white/[0.08] border-y border-white/[0.08] md:grid-cols-3 md:divide-x md:divide-y-0">
          {copy.quickFacts.map((fact) => (
            <div
              key={fact.label}
              className="px-3 py-3 md:px-4"
            >
              <p className="section-kicker">{fact.label}</p>
              <p className="mt-1 text-sm leading-6 text-slate-200">{fact.value}</p>
            </div>
          ))}
        </div>
      </section>

      <div className="grid min-w-0 gap-6 lg:grid-cols-[14rem_minmax(0,1fr)]">
        <aside className="min-w-0 lg:sticky lg:top-0 lg:self-start">
          <nav
            className="custom-scrollbar flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:border-l lg:border-white/[0.08] lg:pl-3"
            aria-label={copy.navLabel}
          >
            {copy.sections.map((section) => {
              const Icon = sectionIcons[section.id] ?? BookOpen;
              return (
                <a
                  key={section.id}
                  href={`#${section.id}`}
                  className="inline-flex min-h-[40px] shrink-0 items-center gap-2 rounded-md border border-white/[0.1] bg-white/[0.03] px-3 text-xs font-medium text-ink-300 transition-colors hover:border-ember-500/40 hover:bg-ember-500/[0.06] hover:text-ember-200 lg:border-transparent lg:bg-transparent"
                >
                  <Icon size={14} className="shrink-0" />
                  <span className="whitespace-nowrap">{section.title}</span>
                </a>
              );
            })}
          </nav>
        </aside>

        <div className="min-w-0 space-y-7">
          {copy.sections.map((section) => (
            <section
              key={section.id}
              id={section.id}
              className="scroll-mt-28 border-b border-white/5 pb-7 last:border-b-0"
            >
              <SectionHeading section={section} />

              {section.kind === "guide" ? <GuideSectionView section={section} /> : null}

              {section.kind === "selectors" ? (
                <SelectorSectionView
                  section={section}
                  copiedId={copiedId}
                  copyLabel={copy.copy}
                  copiedLabel={copy.copied}
                  onCopy={(id, code) => void copyExample(id, code)}
                />
              ) : null}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
