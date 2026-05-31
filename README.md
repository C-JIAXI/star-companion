# Local Roleplay Platform

本项目是一个本地优先的 AI 角色扮演聊天平台，当前以可本地运行、持续迭代的单角色聊天产品维护。实现保持原创，不复制 TavernAI、SillyTavern 或其他现成产品的源码、UI、素材、默认角色或品牌命名。

README 以当前仓库实现为准；如果历史说明与代码不一致，请优先参考 `apps/server/prisma/schema.prisma`、`packages/shared/src/index.ts`、前后端路由和页面实现。

## 当前产品边界

- 单用户 + 单角色回复。
- 不做群聊。
- 不做独立 lorebook / world book 页面、API 或 Prisma 模型。
- 角色上下文补充只通过 `Character.loreEntries`。
- 当前前端有 3 个主产品页面：`/`、`/characters`、`/settings`，另有 1 个应用内文档页 `/docs`。
- `Chat` 直接绑定单个 `characterId`。

## 当前已实现

- 角色 CRUD。
- 角色卡导入导出，支持 `public` / `private` 导出和私有角色卡密码解锁。
- 聊天 CRUD、记忆轮数配置、聊天级自定义配置。
- 消息编辑、删除、复制、重新生成、variants 切换。
- WebSocket 流式输出与停止生成。
- OpenAI-compatible 后端代理，以及 Anthropic Claude / Google Gemini 原生适配。
- 供应商模板、模型预设、模型 ID 批量导入、连接测试。
- 界面语言切换（`zh-CN` / `en`）。
- 本地备份导入导出。
- 用户画像摘要自动更新。
- 角色内嵌 `loreEntries` 关键词注入。
- 聊天气泡头像显示开关。
- 不同聊天单独设置背景。
- 应用内文档页 `/docs`，用于承载聊天样式选择器说明和后续教程。

## 技术栈

- 前端：React + TypeScript + Vite
- UI：Tailwind CSS
- 状态管理：Zustand
- 后端：Node.js + Express + TypeScript
- 数据库：SQLite + Prisma
- 实时能力：WebSocket
- 模型接入：OpenAI-compatible API，并支持 Anthropic Claude / Google Gemini 原生适配

## 目录结构

```text
apps/
  web/       React 前端
  server/    Express 后端 + Prisma
packages/
  shared/    前后端共享类型
scripts/
  seed-pagination-test.mjs
```

## 环境要求

- Node.js 20+
- 本仓库通过根目录 `npm` 脚本协调各子项目，不使用 `pnpm workspace`

环境变量模板：

- 根目录：`.env.example`
- 后端：`apps/server/.env.example`

建议先创建后端环境文件：

```powershell
Copy-Item apps/server/.env.example apps/server/.env
```

后端关键变量：

```text
DATABASE_URL="file:./dev.db"
SERVER_PORT=4000
CORS_ORIGIN="http://localhost:5173"
API_KEY_ENCRYPTION_SECRET="replace-with-a-long-local-random-secret"
```

`API_KEY_ENCRYPTION_SECRET` 用于加密本地保存的 API Key。更换该值后，已有密文 Key 需要重新填写。

## 安装与启动

```bash
npm install
npm run db:generate
npm run db:migrate:deploy
npm run dev
```

默认地址：

- Web: `http://localhost:5173`
- Server: `http://localhost:4000`
- Health: `http://localhost:4000/api/health`
- WebSocket: `ws://localhost:4000/ws`

当前页面：

- Chat: `http://localhost:5173/`
- Docs: `http://localhost:5173/docs`
- Characters: `http://localhost:5173/characters`
- Settings: `http://localhost:5173/settings`

历史 hash 路由如 `#/characters` 仍有兼容逻辑，但新的开发和文档应以真实路径为准。

## 常用命令

```bash
npm run dev
npm run build
npm run lint
npm run test:server
npm run test:e2e
npm run db:generate
npm run db:migrate
npm run db:migrate:deploy
```

说明：

- `npm run dev` 会同时启动 `packages/shared`、`apps/server` 和 `apps/web`
- `npm run build` 会依次构建 shared、server、web
- `npm run lint` 会检查 shared、server、web
- `npm run test:server` 会运行服务端测试
- `npm run test:e2e` 会运行 Playwright 前端端到端测试
- 当前仓库没有根级 `npm run test:api`
- 当前仓库也没有 `scripts/smoke-api.mjs`

首次运行 Playwright 可安装浏览器：

```bash
npm exec --prefix apps/web playwright install chromium
```

## API 与实时入口

HTTP API：

- `/api/health`
- `/api/characters`
- `/api/chats`
- `/api/messages`
- `/api/settings`
- `/api/backups`

补充路由：

- `GET /api/characters/page`
- `POST /api/characters/import`
- `POST /api/characters/:id/export`
- `POST /api/characters/:id/unlock`
- `POST /api/settings/test`
- `GET /api/settings/models`
- `PUT /api/settings/user-profile`

实时入口：

- `ws://localhost:4000/ws`

当前没有 `/api/lorebooks` 路由，也没有 `/lore` 页面。

## 当前数据模型

`UserSettings`

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

`Character`

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

`Chat`

- `title`
- `characterId`
- `memoryTurns`
- `backgroundUrl`
- `userPersona`
- `userProfileSummary`
- `userProfileUpdatedAt`

`Message`

- `chatId`
- `role`
- `characterId`
- `content`
- `variants`
- `activeVariantIndex`
- `tokenUsage`
- `loreMatches`

补充说明：

- 当前角色提示词结构是 `prefix` / `prompt` / `suffix`
- `Character.htmlCss` 仍用于角色消息内的 HTML fragment；当该角色在聊天页激活时，同一份 CSS 也会作用于应用内文档约定的官方 Chat UI 选择器
- 当前没有一等持久化字段：`firstMessage`、`exampleDialog`、`tags`、`systemPrompt`
- 角色导入与备份导入按当前字段结构处理，不再兼容旧的 `scenario` / `systemPrompt` 字段映射

## Prompt 组装

聊天生成链路以 `apps/server/src/services/promptBuilder.ts` 为准：

1. 解析当前角色的 `prefix` / `prompt` / `suffix`
2. 根据最近上下文命中角色 `loreEntries`，并按 `scope` 注入对应段落
3. 追加聊天级自定义配置（存储在 `userPersona` 中的 `prefix` / `prompt` / `suffix`）
4. 追加聊天级 `userProfileSummary`
5. 追加最近 N 条聊天记录

约束：

- 当前不再使用额外的硬编码系统提示包装
- 如果修改 prompt 结构，需要同步更新服务端测试

## 模型接入

- 所有 LLM 请求都通过后端代理，前端不直接持有第三方模型 API Key
- 未识别的 `activeProvider` 默认按 OpenAI-compatible 方式调用
- `anthropic` 与 `google-gemini` 使用原生请求与流式适配
- 设置接口不会返回 API Key 明文，只返回 `hasApiKey`

## 备份与迁移

- 备份导出包含：`settings`、`characters`、`chats`、`messages`
- 备份导出不包含 API Key
- 备份导入支持 `merge` 与 `replace`
- `replace` 会清空 `messages`、`chats`、`characters`
- `replace` 不会删除本地设置记录，API Key 也不会通过备份覆盖或泄漏
- 备份导入使用 Zod 校验

## 开发提示

- 涉及数据模型变更时，请同时检查 Prisma schema、Zod schema、serializer、shared types、前端类型、前端 API client、README、测试
- 不要新增群聊相关页面、接口或提示词策略
- 不要新增独立 lorebook 相关页面、接口或 Prisma 模型
- 若发现代码或测试中仍有 lorebook / 群聊相关历史命名，应视为技术债，而不是未来路线

## 验证建议

按改动范围优先运行：

```bash
npm run build
npm run lint
npm run test:server
npm run test:e2e
```

README 不再把测试状态写成固定结论；请以你本次实际运行结果为准。
