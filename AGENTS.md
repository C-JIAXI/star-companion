# AGENTS.md

你是这个仓库的全栈高级工程师。当前项目已经是一个可运行、持续迭代中的本地优先 AI 角色聊天平台。你的工作是在现有实现上继续维护和演进，并保持代码、文档、测试、产品边界一致。

## 项目定位

- 产品类型：本地优先的 AI 角色扮演聊天平台。
- 实现要求：必须是原创实现，不复制 TavernAI、SillyTavern 或其他现有项目的源码、UI、素材、默认角色、默认背景或品牌命名。
- 运行方式：支持本地运行，后续可扩展为服务器部署。
- 安全边界：
  - API Key 只保存在本地配置中。
  - 所有 LLM 请求必须通过后端代理。
  - 前端不能直接持有或调用第三方模型 API Key。

## 产品边界

以下边界在没有新指令前视为固定范围：

1. 不做群聊。
2. 不做独立世界书页面、独立世界书 API、独立世界书 Prisma 模型。
3. 角色相关上下文补充只保留“角色内嵌 `loreEntries`”这条路线。
4. 聊天产品模型按“单用户 + 单角色回复”维护。

如果代码里仍然存在与群聊或独立世界书有关的历史残留，应视为技术债，而不是未来路线。

## 当前仓库事实

以下内容以当前代码为准，高于历史计划或过时文档。

1. 当前仓库使用 `npm` 脚本组织，不是 `pnpm workspace`。
2. 前端当前有 3 个主产品页面 + 1 个应用内文档页：
   - `/` 聊天页
   - `/characters` 角色页
   - `/settings` 设置页
   - `/docs` 应用内文档页
3. 当前没有 `/lore` 页面，也没有启用 `/api/lorebooks` 路由。
4. 角色提示词当前采用三段结构：
   - `prefix`
   - `prompt`
   - `suffix`
5. 聊天生成链路中的硬编码系统提示包装已经移除。当前系统消息主要来自：
   - 角色卡原始字段
   - 用户 persona
   - 用户画像摘要
   - 命中的角色 `loreEntries`
6. 代码里仍保留了一些与旧方向有关的历史测试与迁移资产，例如旧 lorebook 字段历史等。

## 技术栈与目录

- 前端：React + TypeScript + Vite
- UI：Tailwind CSS
- 状态管理：Zustand
- 后端：Node.js + Express + TypeScript
- 数据库：SQLite + Prisma
- 实时能力：WebSocket
- 模型接入：OpenAI-compatible API，并支持 Anthropic Claude / Google Gemini 原生适配

目录结构：

```text
apps/
  web/       React 前端
  server/    Express 后端 + Prisma
packages/
  shared/    前后端共享类型
scripts/
  smoke-api.mjs
  seed-pagination-test.mjs
```

## 启动与常用命令

安装与启动：

```bash
npm install
npm run db:generate
npm run db:migrate:deploy
npm run dev
```

常用命令：

```bash
npm run build
npm run lint
npm run test:server
npm run test:api
npm run test:e2e
npm run db:migrate
```

默认地址：

- Web: `http://localhost:5173`
- Server: `http://localhost:4000`
- Health: `http://localhost:4000/api/health`

环境变量示例：

- 根目录：`.env.example`
- 后端：`apps/server/.env.example`

后端关键变量：

```text
DATABASE_URL="file:./dev.db"
SERVER_PORT=4000
CORS_ORIGIN="http://localhost:5173"
API_KEY_ENCRYPTION_SECRET="replace-with-a-long-local-random-secret"
```

## 当前数据模型

请以 `apps/server/prisma/schema.prisma` 和 `packages/shared/src/index.ts` 为准。

### UserSettings

- `activeProvider`
- `apiBaseUrl`
- `apiKey`
- `model`
- `temperature`
- `maxTokens`
- `topP`
- `language`
- `models`
- `userProfileSummary`
- `autoSummarizeUser`
- `showMessageAvatars`
- `userProfileUpdatedAt`

说明：

- Prisma 注释里仍有“明文保存”的旧说明，但运行时代码已经使用 `AES-256-GCM` 加密 API Key。
- 设置接口不会返回 API Key 明文，只会返回 `hasApiKey`。
- 未识别的 `activeProvider` 默认按 OpenAI-compatible 调用；`anthropic` 和 `google-gemini` 走原生请求/流式响应适配。

### Character

- `name`
- `avatar`
- `description`
- `prefix`
- `prompt`
- `suffix`
- `htmlCss`
- `openingHtml`
- `loreEntries`
- `quickReplies`

说明：

- 当前没有一等字段：
  - `personality`
  - `scenario`
  - `firstMessage`
  - `exampleDialog`
  - `systemPrompt`
  - `tags`
- 上述字段只应作为历史兼容语境理解，不应默认视为当前待补的一等持久化路线。
- `htmlCss` 既可样式化角色消息里的 HTML fragment，也会在该角色激活聊天时作用于应用内文档约定的官方 Chat UI 选择器。
- 导入角色与备份数据按当前字段结构处理，不再兼容旧的 `scenario/systemPrompt` 字段映射。

### Chat

- `title`
- `characterId`
- `memoryTurns`
- `backgroundUrl`
- `userPersona`
- `userProfileSummary`
- `userProfileUpdatedAt`

说明：

- 当前产品边界只支持单角色聊天。
- `characterId` 是聊天绑定角色的唯一来源。

### Message

- `chatId`
- `role`
- `characterId`
- `content`
- `variants`
- `activeVariantIndex`
- `tokenUsage`
- `loreMatches`

## 当前功能边界

### 已落地

- 角色 CRUD
- 聊天 CRUD
- 消息编辑、删除、复制
- assistant 回复重新生成
- message variants 切换
- 不同聊天单独设置背景
- WebSocket 流式输出
- 停止生成
- OpenAI-compatible API 代理，以及 Anthropic Claude / Google Gemini 原生代理
- 模型预设、供应商模板、模型 ID 批量导入
- 语言切换
- 本地备份导入导出
- 用户画像摘要自动更新
- 角色内嵌 `loreEntries` 关键词注入

### 未完成或仅部分完成

- 角色首条消息自动开场
- E2E / smoke test 与后续 UI、schema 演进的持续同步维护
- 历史 `firstMessage / exampleDialog / tags / systemPrompt` 残留的继续清理

## Prompt 组装规则

当前聊天 prompt 组装顺序以 `apps/server/src/services/promptBuilder.ts` 为准：

1. 角色卡原始系统内容：
   - `prefix`
   - `prompt`
   - `suffix`
2. 聊天级 `userPersona`
3. 聊天级 `userProfileSummary`
4. 命中的角色 `loreEntries`
5. 最近 N 条聊天记录

约束：

- 不要在未明确要求的情况下重新引入硬编码系统提示包装。
- 如果修改 prompt 结构，必须同步更新服务端测试。

## 开发约束

1. 任何数据模型变更都要同时检查这些层是否同步：
   - Prisma schema
   - Zod schema
   - serializer
   - shared types
   - web types
   - web API client
   - README
   - AGENTS.md
   - smoke test
   - Playwright E2E
2. 不要新增群聊相关页面、接口、提示词策略或文档描述。
3. 不要新增独立世界书相关页面、接口、Prisma 模型或备份协议。
4. 如果你清理历史残留，请优先把范围收敛到“单角色聊天 + 角色内嵌 lore”。
5. 任何涉及 API Key、用户画像摘要、真实聊天内容的日志都要避免泄漏敏感信息。
6. 所有关键操作保持确认弹窗和清晰错误提示。

## 已知不一致与技术债

以下问题已经存在，后续修改时不要忽略：

1. 迁移目录中仍保留旧 lorebook / 兼容字段历史，属于历史债务，不代表当前产品方向。
2. 当前 Windows 环境下 fresh SQLite 的 `prisma db push` / `prisma migrate deploy` 仍会报 schema engine error；`scripts/smoke-api.mjs` 已改为回放 `prisma/migrations/*/migration.sql` 来启动空库 smoke。
3. 历史 `firstMessage / exampleDialog / tags / systemPrompt` 概念仍可能在旧测试、旧示例或历史讨论语境中出现；继续清理时应保持为兼容说明，而不是新功能路线。

## 当前验证状态

截至目前，建议把以下结论当成仓库现状：

- `npm run build`：通过
- `npm run test:server`：通过
- `npm run test:api`：通过
- `npm run test:e2e`：通过；当前为 `24 passed`

因此：

- 当前 E2E 已无 legacy skip，后续改 UI 或 schema 时仍需要同步维护 Playwright 断言与夹具。
- 做功能改动前后，优先跑与你改动范围直接相关的检查。

## 近期优先事项

如果没有新的用户指令，优先级建议如下：

1. 保持 E2E / smoke tests 与当前 UI、schema 同步
2. 继续打磨单角色聊天体验
3. 让 README、代码实现保持同步
4. 清理 `firstMessage / exampleDialog / tags / systemPrompt` 相关的遗留代码

## 交付标准

每次完成一段工作后，优先给出：

1. 做了什么
2. 改了哪些关键文件
3. 如何运行或验证
4. 剩余风险或下一步

不要再把群聊或独立世界书当成未来路线。这个项目当前按“单角色聊天 + 角色内嵌 lore”继续维护。
