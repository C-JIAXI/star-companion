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
  RefreshCw,
  ShieldCheck,
  type LucideIcon
} from "lucide-react";
import { reopenOnboarding } from "../components/OnboardingDialog";
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
  updates: RefreshCw,
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
              body: "从聊天就绪状态点击缺项可直接进入供应商管理。依次添加模型服务、填写 API Key（本机无鉴权服务可省略）、选择并声明聊天模型能力，然后保存。先运行通常不产生推理费用的元数据检查；只有在确认固定测试文本、最多 4 个输出 token、预算与本机记账影响后，才运行可选最小推理测试。"
            },
            {
              title: "创建原创角色",
              body: "想立即开始时，可在“新建聊天”中使用快速创建。角色工坊的基础模式按身份、核心设定、开场体验、检查与创建四步引导；核心设定直接使用现有 prompt。高级模式显示 prefix、prompt、suffix、内嵌 lore、快捷回复和样式。两种模式共享同一草稿，切换或基础保存不会清空高级字段。编辑器会标记未保存状态并在离开前提醒。"
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
              body: "输入消息后发送。生成期间可继续输入并加入待发送队列；队列可编辑、删除或立即发送，当前回复结束后会合并为下一条消息自动发送。队列只在当前应用会话中保留。停止后仍保留已经流式返回的内容。连接中断时输入区会显示重连状态；未被服务端确认的草稿会自动恢复，重连后刷新当前会话。"
            },
            {
              title: "消息操作",
              body: "用户消息可复制、编辑、删除、重发；角色回复可复制、编辑、删除、重新生成，并在有候选版本时切换变体。每条新生成的角色回复都可打开提示词调试，查看角色设定、用户设定、lore、长期记忆、聊天历史和本轮指令分别占用的 Prompt token。长聊天按页载入并限制同时渲染的消息数量；加载更早记录会保持当前可见位置，搜索、来源引用和书签可以直接定位到未载入的消息。时间线会标出下一轮普通回复的滚动上下文边界；手动排除的消息有独立标记。重发历史用户消息会先提示将替换的后续消息；确认框可直接创建保留完整原剧情的分支，并在分支中重发。"
            },
            {
              title: "聊天设置",
              body: "右上角设置菜单可查看上下文预算，并调整记忆轮数、长期记忆、聊天背景、用户设定、用户画像摘要和当前模型。Persona 预设可同时保存聊天内显示名、可选本地头像与三段用户配置；未上传头像时会生成稳定占位图，但只有前置词、提示词和后置词会进入模型上下文。每个模型可在供应商设置中填写上下文窗口；预算面板会估算下一轮输入与预留回复空间并提示风险，但不会自动裁剪剧情。长期记忆可单独指定向量模型，使用语义与关键词混合召回；面板汇总全部就绪、待刷新和失败状态。“重建索引”按批次更新并显示进度，可随时取消，已经完成的批次仍可使用；未配置或接口失败时自动退回关键词。每次内容或状态变化都会形成不可变版本，可查看字段差异和来源、恢复旧版本，或在冲突预检后事务撤销一次完整整理。"
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
              body: "桌面侧栏和移动抽屉会直接显示最多六段置顶或最近活跃聊天，可一步切换。移动端顶部搜索入口与完整历史可在聊天标题和全部消息之间切换，并直接跳到命中消息；也可按轻量文件夹筛选和整理剧情线，并从当前文件夹筛选直接全局重命名或清空。归档已完成的聊天不会删除消息或长期记忆，管理模式支持批量归档与恢复。"
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
              title: "草稿保存范围（开发中）",
              body: "完整草稿恢复正在接入：后端已支持每个聊天独立保存文字与有序图片引用，但当前输入框还未接入，切换聊天仍可能丢失未发送图片。图片暂存期限为上传后 24 小时，读取不延长；草稿不属于备份或局域网同步内容。待发送队列仍仅在当前应用会话中使用。"
            },
            {
              title: "发送图片给视觉模型",
              body: "可通过文件选择、拖放或粘贴为一条用户消息添加最多 4 张图片，移动端使用系统相册/文件选择器。单张源文件最多 10 MB、每条消息规范化后合计最多 20 MB、解码后最多 2500 万像素。JPEG/PNG 会重新解码、应用方向并移除元数据；浏览器可安全读取的 WebP/GIF/AVIF 会转成静态 PNG/JPEG。SVG、图片网址和普通文件不支持。只有明确标记支持图片输入的聊天模型可发送；图片会经本地后端传给所选第三方模型服务，请同时遵守该服务的隐私与保留政策。"
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
              body: "基础模式的核心角色设定就是现有 prompt：写清身份、行为、语气和边界即可，不需要技术性系统提示包装。保存前检查在本地确定性运行，显示可定位的错误、警告、建议及 prefix / prompt / suffix / 始终启用 lore 的 token 近似估算。封面可填写 HTTPS 图片地址，也可选择 2 MB 内的本地 PNG、JPEG、WebP、GIF 或 AVIF 图片。"
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
              body: "开场页面适合展示角色介绍、序章或欢迎页，并与聊天消息共用清洗和作用域渲染边界。可选创作助手只把当前任务需要的字段类别发送给 Agent 模型，返回可逐项审阅、应用、放弃和撤销的草案；不会自动保存，也不会发送其他角色、聊天、persona、画像或长期记忆。角色卡导入导出、同 cardId 覆盖、私密加密和安全复制协议保持不变。"
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
              title: "外观与无障碍",
              body: "全局外观设置统一作用于聊天、角色、设置与文档页，包含系统/浅色/深色主题、字号、行距、聊天宽度、消息间距、高对比度、动态效果和聊天背景遮罩。系统模式会实时跟随设备；减少动态效果会关闭非必要动画和平滑滚动。角色 CSS 可选择完整、受限或关闭；受限模式不会改写已保存的 CSS，但会阻止隐藏控件、过小文字、极端层级和无限动画。隐私锁会保留这些非敏感外观，但不会显示聊天背景或工作区内容。"
            },
            {
              title: "API Key",
              body: "API Key 只保存在本地配置中，运行时代码会加密保存；界面不会展示已保存密钥的明文。"
            },
            {
              title: "模型服务",
              body: "从模板快速添加模型服务，或自定义创建。每个服务可以单独保存地址、API Key 和模型列表。"
            },
            {
              title: "就绪状态与安全诊断",
              body: "设置页会对已保存的供应商、Base URL、密钥是否存在、聊天模型/能力、备用链、价格和本机预算做只读静态检查。默认连接测试只读取供应商模型元数据，通常不会产生推理费；可选最小推理测试使用固定文本、最多 4 个输出 token，并在确认后进入本机调用账本和预算。常见安全码包括 invalid_url、tls_failed、authentication、permission_denied、model_not_found、rate_limited、quota_exceeded、budget_blocked 和 provider_unavailable。诊断不包含密钥、聊天内容或供应商正文，也不等同于供应商账单或官方状态页。localhost、回环/RFC1918 和 .local 可配置为本机无鉴权服务，但仍只允许安全的 HTTP(S) URL。普通聊天只要求文本能力，图片聊天另需 vision_input。"
            },
            {
              title: "模型切换",
              body: "在设置页选择模型即可切换聊天使用的模型，聊天页也支持快速切换。"
            },
            {
              title: "可靠性与备用模型",
              body: "模型错误会转换为不包含响应正文的安全错误码。自动重试默认关闭，只处理网络、超时、限流和临时不可用；每个模型候选最多两次重试，并且首个 token 输出后不再重试或换模型。备用链必须逐模块显式设置，聊天自动切换还需要单独同意。"
            },
            {
              title: "使用量、费用与预算",
              body: "使用量面板记录每次实际调用的模型、状态、token 和价格快照，并按模块、供应商、模型及聊天汇总。金额是本机根据供应商返回或估算 token 计算的 USD 参考值，不是供应商账单；无法可靠计价会显示“费用未知”，不会按零费用处理。软预算只提醒，硬预算由后端在每次调用前执行。"
            },
            {
              title: "本地存储与数据健康",
              body: "设置页中的存储中心按准确、估算或不可用标记数据库、角色/聊天/消息、记忆历史、聊天媒体及其引用、本地 data URL 图片、向量、恢复点、升级副本、回收站、用量账本和应用私有临时文件。快速检查和可取消深度检查都只读；深检验证 SQLite、引用、媒体哈希/长度/格式/尺寸/解码、向量维度、记忆版本与保留规则。清理必须逐项选择并先由后端生成五分钟有效、一次性且执行前重校验的计划；VACUUM 是独立操作，移动端不能保证安全时会明确显示不支持。异常或仍被消息/恢复点引用的媒体不会自动删除。安全诊断不含本地路径、完整媒体哈希、聊天正文、画像或 API Key。"
            },
            {
              title: "会话隐私锁",
              body: "可为当前应用会话设置轻量解锁码。锁定后整个工作区会卸载，费用明细和聊天关联不留在页面中。解锁码只在当前进程内存中保存，刷新或重启会解除此会话锁。"
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
              body: "完整备份包含角色、角色收藏状态、聊天、消息及图片附件、长期记忆当前状态、记忆版本/操作批次和 chat 用户画像历史；单聊天 JSON 归档也携带该聊天的这些历史与图片。图片二进制按内容去重，只在带哈希、长度、格式和尺寸校验的 media 清单中保存一次。消息会保留实际模型、token、估算费用和完成状态等生成摘要。设置会导出模型服务和参数，但不会导出 API Key。全局调用账本、预算占用和恢复点只保留在本机，不进入备份或局域网同步。角色收藏属于本地偏好，不会写入可分享的角色卡文件。"
            },
            {
              title: "合并导入",
              body: "合并导入先只读预检。新增内容可以直接加入；同一 ID 但内容不同会列为冲突，必须逐项选择保留本机、采用备份或跳过，不会静默覆盖。"
            },
            {
              title: "替换导入",
              body: "替换导入会显示预计删除数量并要求独立危险确认。写入前自动创建本地恢复点，API Key 始终留在当前设备。"
            },
            {
              title: "预检与恢复点",
              body: "流程为选择来源、预检、查看新增/更新/跳过/冲突/无效/删除影响、确认执行、查看结果。预检不写数据库；恢复点列表显示创建时间和数据规模，可事务性恢复。"
            },
            {
              title: "局域网同步",
              body: "拉取和推送都先生成差异预览。合并冲突必须明确选择本机、对端或跳过；替换仍需危险确认。可选的启动自动同步只会对最近成功连接的设备执行 pull+merge，并且仍先预检；遇到冲突、无效载荷或无法连接时不会写入。桌面和移动后端使用同一契约，载荷永不包含 API Key。"
            },
            {
              title: "大型数据操作",
              body: "备份与同步 JSON 上限为 256 MB；对端导出和预检最多等待 3 分钟，执行最多等待 10 分钟。校验、可用空间、冲突和恢复点规则不会因上限提高而放宽。大型替换或恢复可能持续数分钟并暂用较多内存，请保持应用打开。"
            }
          ],
          note: "恢复点最多保留 10 个并清理超过 30 天的旧记录；每条记忆最多保留 30 个版本，每个聊天最多保留 100 次记忆操作。恢复失败时当前数据保持不变。旧 schemaVersion 1 只有当前状态时会建立明确基线，不伪造过去事件。"
        },
        {
          id: "updates",
          title: "版本、更新与安全升级",
          description: "在设置页的“关于与更新”中查看当前构建和数据迁移状态。",
          kind: "guide",
          items: [
            { title: "版本信息", body: "应用会显示应用版本、数据 migration 版本与校验值、平台、构建类型和可选提交标识；这些信息来自统一版本源。" },
            { title: "Windows 更新", body: "正式 Windows 安装包支持手动检查、查看发布说明、下载进度、推迟，以及下载完成后确认重启安装。开发构建不会连接真实更新源，也不会自动下载或静默安装。" },
            { title: "Android 更新", body: "Android 只提供安全的应用商店或发布页跳转边界，不会绕过系统或商店机制静默替换 APK。" },
            { title: "数据库保护", body: "新版本首次启动如需迁移，会先检查数据库完整性、校验迁移历史，并为已有数据库创建升级前安全副本。失败时停止启动并保留原数据库和恢复目录。" },
            { title: "脱敏诊断", body: "可复制版本、平台、构建、迁移和更新状态；诊断不包含 API Key、聊天正文、用户画像、persona 或私密角色提示词。" }
          ],
          note: "校验或签名验证失败时不要继续安装。保留诊断代码，并从可信发布来源重新获取更新。"
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
                    '[data-chat-action="copy|edit|delete|resend|regenerate|guided-regenerate|debug|variant-prev|variant-next|retry|dismiss|send|stop|reconnect"]',
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
            body: "Open a missing item from Chat Readiness to jump to Provider Management. Add a service, enter its API key (optional for unauthenticated local services), choose and declare chat-model capabilities, then save. Start with the metadata check, which normally incurs no inference cost. Run the optional minimal inference test only after confirming its fixed input, four-token output limit, budget check, and local ledger impact."
          },
          {
            title: "Create an original character",
            body: "For the fastest start, use Quick Create in New Chat. Character Studio Basic mode guides Identity, Core, Opening, and Review using the existing prompt as the core definition. Advanced mode exposes prefix, prompt, suffix, embedded lore, quick replies, and styling. Both modes share one draft, so switching or saving in Basic never clears Advanced fields. Unsaved work is protected before leaving."
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
            body: "Send from the composer. While generation streams, new messages can be queued, edited, deleted, or sent immediately. The queue is combined into the next message after the current reply and lasts only for the current app session. Stopping keeps content already received. If the connection drops, the composer reports reconnection progress, restores drafts that the server did not acknowledge, and refreshes the conversation after recovery."
          },
          {
            title: "Message actions",
            body: "User messages can be copied, edited, deleted, or resent. Character replies can be copied, edited, deleted, regenerated directly, regenerated with one-time revision guidance, continued when they are the latest reply, and switched between variants. Each newly generated reply exposes Prompt composition for character instructions, user configuration, lore, recalled memory, chat history, and turn-specific instructions. Long chats load in bounded pages; loading older history preserves the visible position, while search, source references, and bookmarks can jump directly to unloaded turns. The timeline marks the next rolling-context boundary and labels manual exclusions separately. Guided regeneration preserves the current reply as a variant and never stores its guidance as story context."
          },
          {
            title: "Chat settings",
            body: "The top-right menu shows the context budget and controls memory turns, long-term memory, chat background, user notes, profile summary, and the active model. Persona presets can retain a chat display name, an optional local avatar, and the three prompt sections; only prefix, prompt, and suffix enter model context. Each model can store a context-window limit; the budget estimates the next prompt and reserved response space without silently trimming story history. A separate memory embedding model enables hybrid semantic and keyword retrieval. The panel aggregates every ready, stale, and failed vector. Rebuilds commit short batches, show content-free progress, and can be cancelled while completed batches remain usable; keyword recall remains available. Every content/status change creates an immutable revision with field diffs and source links."
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
            title: "Draft persistence scope (in development)",
            body: "Complete draft recovery is being integrated. The backend can now save per-chat text and ordered image references, but the current composer is not connected yet and switching chats can still lose unsent images. Temporary images expire 24 hours after upload; reading does not renew them. Drafts are excluded from backups and LAN sync. The send queue remains limited to the current app session."
          },
          {
            title: "Organize story folders",
            body: "Use the folder action in any History row to group long-running story lines, or leave it empty to return a chat to Unfiled. Select a named folder and use its manage button to rename or clear every chat in that folder, including archived and trashed chats. Folder names stay with branches, full backups, LAN sync, and JSON chat archives."
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
            title: "Send images to a vision model",
            body: "Add up to four images to one user turn with the file picker, drag and drop, or paste; mobile uses the system gallery/file picker. Each source image is limited to 10 MB, normalized images to 20 MB total per message, and decoded images to 25 megapixels. JPEG/PNG are re-decoded, oriented, and stripped of metadata; browser-decodable WebP/GIF/AVIF become a static PNG/JPEG. SVG, image URLs, and arbitrary files are unsupported. Sending requires a chat model explicitly marked for image input. The local backend passes selected images to that third-party model provider, so its privacy and retention policy also applies."
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
            body: "The Basic core character definition maps directly to the existing prompt field: describe identity, behaviour, voice, and boundaries without a technical system wrapper. Deterministic local checks identify focusable errors, warnings, and suggestions, with approximate token budgets for prefix, prompt, suffix, and always-on lore. Covers can use an HTTPS URL or a local PNG, JPEG, WebP, GIF, or AVIF image up to 2 MB."
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
            body: "Opening pages use the same sanitized, scoped renderer as saved chat content. The optional drafting assistant sends only task-minimal field categories through the configured Agent module and returns structured suggestions to review, apply, discard, or undo. It never auto-saves or sends other characters, chat text, personas, profile summaries, or memories. Character-card import/export, same-card updates, encrypted private cards, and safe duplication remain unchanged."
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
            title: "Appearance and accessibility",
            body: "Global appearance preferences apply to Chat, Characters, Settings, and Docs: system/light/dark theme, type size, line height, chat width, message spacing, high contrast, motion, and chat-background masking. System modes follow the device live; reduced motion removes non-essential animation and smooth scrolling. Character CSS can be full, restricted, or off. Restricted mode leaves stored CSS unchanged but blocks hidden controls, tiny text, extreme stacking, and endless animation. Privacy lock keeps this non-sensitive appearance without showing chat backgrounds or workspace content."
          },
          {
            title: "API keys",
            body: "API keys are stored only in local configuration. The interface does not reveal the saved key after it is stored."
          },
          {
            title: "Model services",
            body: "Add model services from templates or create custom ones. Each service can keep its own address, API key, and model list."
          },
          {
            title: "Readiness and safe diagnostics",
            body: "Settings statically checks the saved provider, base URL, key presence, chat model/capabilities, fallback chain, pricing, and local budget without contacting a provider. The default connection test reads model metadata and normally incurs no inference cost. The optional minimal inference test uses fixed text and at most four output tokens, then enters the local ledger and budget lifecycle after confirmation. Common safe codes include invalid_url, tls_failed, authentication, permission_denied, model_not_found, rate_limited, quota_exceeded, budget_blocked, and provider_unavailable. Diagnostics contain no key, chat content, or provider body and are not a provider bill or status page. Localhost, loopback/RFC1918, and .local services may run without authentication but still require safe HTTP(S) URLs. Text chat needs text capability; image chat separately needs vision_input."
          },
          {
            title: "Model switching",
            body: "Choose a model in Settings to switch what chat uses. The chat page also supports quick model switching."
          },
          {
            title: "Reliability and fallbacks",
            body: "Provider failures are converted to safe error codes without response bodies. Automatic retries are off by default and only cover connection, timeout, rate-limit, and temporary availability failures. Each model candidate permits at most two retries, and no retry or model switch occurs after the first output token. Fallback chains must be enabled per module, with separate consent for automatic chat switching."
          },
          {
            title: "Usage, cost, and budgets",
            body: "The usage panel records the actual model, status, tokens, and price snapshot for every real call, with module, provider, model, and chat summaries. USD amounts are local estimates based on provider-reported or estimated tokens, not a provider bill. Unreliably priced work is marked cost unknown rather than zero. Soft budgets warn; hard budgets are enforced by the backend before every call."
          },
          {
            title: "Local storage and data health",
            body: "The Settings storage center labels database, character/chat/message data, memory history, chat media and references, local data-URL images, embeddings, recovery points, upgrade copies, trash, usage ledger, and app-private temporary files as exact, estimated, or unavailable. Fast and cancellable deep checks are read-only. Deep checks validate SQLite, references, media hashes/length/type/dimensions/decode, embedding dimensions, memory revision monotonicity, and retention. Cleanup is selected per action and requires a server-generated five-minute, one-use plan that is revalidated before execution. VACUUM is separate and mobile reports it unsupported when safe atomicity cannot be guaranteed. Referenced or abnormal media is never auto-deleted. Safe diagnostics exclude local paths, full media hashes, chat text, profiles, and API keys."
          },
          {
            title: "Session privacy lock",
            body: "A lightweight unlock code can protect the current app session. Locking unmounts the entire workspace, blocks protected HTTP APIs, and closes or rejects WebSockets so memory/profile history and cost/chat associations are not left accessible. The code is kept only in process memory, so restarting the backend clears this session lock."
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
            body: "Full backups include characters, local favorite state, chats, messages and image attachments, current long-term memories, immutable memory revisions/operations, and chat profile-summary history. Per-chat JSON archives carry the same chat-scoped history and images. Image bytes are content-deduplicated and appear once in a media manifest with hash, length, type, and dimension checks. Messages retain generation summaries such as actual model, tokens, estimated cost, and completion state. Settings export model services and parameters, but not API keys. The global call ledger, active budget reservations, and recovery points remain local and do not enter backups or LAN sync. Favorite state is not written into shareable character card files."
          },
          {
            title: "Merge import",
            body: "Merge starts with a read-only preflight. New records can be added directly. A different record with the same ID is an explicit conflict and must be resolved by keeping this device, using the backup, or skipping it; nothing is silently overwritten."
          },
          {
            title: "Replace import",
            body: "Replace shows expected deletions and requires a separate danger confirmation. A local recovery point is created before writing, while API keys always stay on the current device."
          },
          {
            title: "Preflight and recovery points",
            body: "The flow is choose source, preflight, review add/update/skip/conflict/invalid/delete impact, confirm, then review the result. Preflight never writes the database. Recovery points show creation time and data size and restore transactionally."
          },
          {
            title: "LAN sync",
            body: "Pull and push both generate a difference preview first. Merge conflicts require an explicit local, peer, or skip choice; replace keeps a separate danger confirmation. Optional startup auto-sync only pulls and merges from the last successful peer after the same preview; it writes nothing for conflicts, invalid data, or an unreachable peer and never runs replace. Desktop and mobile use the same contract, and API keys never enter the payload."
          },
          {
            title: "Large data operations",
            body: "Backup and sync JSON is capped at 256 MB. Peer export and preview can wait up to three minutes and execute up to ten. Validation, free-space, conflict, and recovery-point rules are not relaxed by the larger ceiling. A large replace or restore can take several minutes and temporarily use substantial memory, so keep the app open."
          }
        ],
        note: "At most 10 recovery points are retained, and points older than 30 days are cleaned up. Each memory retains at most 30 revisions and each chat at most 100 memory operations. A failed restore leaves current data unchanged. Old schemaVersion 1 current states receive an explicit baseline rather than invented history."
      },
      {
        id: "updates",
        title: "Versions, Updates, and Safe Upgrades",
        description: "Use About & Updates in Settings to review the current build and data migration state.",
        kind: "guide",
        items: [
          { title: "Version information", body: "The app reports its application version, migration version and checksum, platform, build type, and optional commit from one version source." },
          { title: "Windows updates", body: "Packaged Windows installations support manual checks, release notes, download progress, deferral, and confirmation before restart/install. Development builds never contact the real update source, and updates are never downloaded or installed silently." },
          { title: "Android updates", body: "Android only offers a safe link to a configured store or release listing. It never bypasses Android or store protections to replace an APK silently." },
          { title: "Database protection", body: "When first launch needs a migration, the app checks integrity and migration history and creates a pre-upgrade database copy for existing data. Failure stops startup and preserves the original database and recovery folder." },
          { title: "Privacy-safe diagnostics", body: "Copied diagnostics include version, platform, build, migration, and update state, but exclude API keys, chat text, profile summaries, personas, and private character prompts." }
        ],
        note: "Do not continue after checksum or signature verification failure. Keep the diagnostic code and obtain the update again from a trusted release source."
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
                  '[data-chat-action="copy|edit|delete|resend|regenerate|guided-regenerate|debug|variant-prev|variant-next|retry|dismiss|send|stop|reconnect"]',
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
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
          <p className="section-kicker text-ember-300">
            {copy.eyebrow}
          </p>
          <p className="mt-3 max-w-4xl text-sm leading-7 text-slate-300">{copy.intro}</p>
          </div>
          <Button variant="secondary" data-testid="docs-open-onboarding" onClick={reopenOnboarding}>
            {language === "zh-CN" ? "打开首次使用引导" : "Open first-use guide"}
          </Button>
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
