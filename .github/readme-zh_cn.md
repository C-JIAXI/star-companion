# Star Companion / 星伴

![Star Companion 标志](../apps/web/public/app-logo-v2.png)

Star Companion 是一个本地优先的 AI 角色聊天平台，面向单用户、单角色回复的角色扮演对话。

这个仓库适合希望在本地拥有可检查、可备份、可扩展聊天工作台的用户和开发者：角色卡、流式回复、角色内嵌 lore、模型供应商配置、桌面打包、移动端同步脚手架都在同一个代码库中维护。

## 界面预览

![聊天工作台](assets/screenshots/chat-workbench.png)

![模型设置](assets/screenshots/model-settings.png)

## 功能概览

- 本地优先数据：SQLite + Prisma。
- 单用户、单角色聊天模型，不包含群聊路线。
- 角色 CRUD、导入导出、私有角色卡解锁、标签、快捷回复、头像显示。
- 角色三段提示词：`prefix`、`prompt`、`suffix`。
- 角色内嵌 `loreEntries` 关键词命中注入，不提供独立世界书页面或 API。
- WebSocket 流式回复、停止生成、重新生成、消息编辑、删除、复制、variants 切换。
- OpenAI-compatible 后端代理，并提供 Anthropic Claude / Google Gemini 原生适配。
- 模型预设、供应商模板、模型 ID 批量导入、连接测试。
- 聊天背景、用户 persona、用户画像摘要自动更新。
- 本地备份导入导出，以及桌面端和移动端的局域网手动同步。
- Electron Windows 桌面打包和 Android 移动端构建脚手架。


## 技术栈

- 前端：React + TypeScript + Vite
- UI：Tailwind CSS
- 状态管理：Zustand
- 后端：Node.js + Express + TypeScript
- 数据库：SQLite + Prisma
- 实时能力：WebSocket
- 桌面端：Electron
- 移动端：Capacitor Android 脚手架

## 快速开始

环境要求：

- Node.js 20+
- npm 11+

首次运行前安装依赖并准备数据库：

```bash
npm install
npm run db:generate
npm run db:migrate:deploy
npm run dev
```

Windows 用户也可以直接运行：

```powershell
.\start.cmd
```

默认地址：

- Web：`http://localhost:5173`
- Server：`http://localhost:4000`
- Health：`http://localhost:4000/api/health`
- WebSocket：`ws://localhost:4000/ws`

后端环境变量模板位于 [`../apps/server/.env.example`](../apps/server/.env.example)。至少需要准备：

```text
DATABASE_URL="file:./dev.db"
SERVER_PORT=4000
CORS_ORIGIN="http://localhost:5173"
API_KEY_ENCRYPTION_SECRET="replace-with-a-long-local-random-secret"
```

`API_KEY_ENCRYPTION_SECRET` 用于以 AES-256-GCM 加密本地保存的 API Key。设置接口不会返回 API Key 明文，只会返回是否已配置。

## 常用命令

```bash
npm run dev
npm run build
npm run lint
npm run test:server
npm run test:api
npm run test:e2e
npm run desktop:dev
npm run desktop:pack
npm run desktop:build
npm run mobile:sync
npm run mobile:build:android
```

说明：

- `npm run dev` 会同时启动 shared、server 和 web。
- `npm run build` 会构建 shared、server 和 web。
- `npm run test:api` 会在 fresh SQLite 数据库中回放已提交 migration SQL，再运行 API smoke 检查。
- `npm run test:e2e` 会运行 Playwright 前端端到端测试。
- `npm run desktop:build` 会生成 Windows 桌面安装包。
- `npm run mobile:build:android` 会生成 Android debug APK。

首次运行 Playwright 前可能需要安装 Chromium：

```bash
npm exec --prefix apps/web playwright install chromium
```

## 目录速览

```text
apps/
  web/             React 前端
  server/          Express 后端 + Prisma
  desktop/         Electron 入口
  mobile-backend/  移动端后端辅助服务
packages/
  shared/          前后端共享类型
scripts/
  desktop/         桌面端打包辅助脚本
  dev/             本地开发辅助脚本
  mobile/          移动端打包与 smoke 脚本
docs/
  platforms/       平台说明
.github/
  workflows/       GitHub Actions 工作流
```

## API 与数据模型

主要 HTTP 路由：

- `/api/health`
- `/api/characters`
- `/api/chats`
- `/api/messages`
- `/api/settings`
- `/api/backups`
- `/api/sync`

实时入口：

- `ws://localhost:4000/ws`

数据模型以这些文件为准：

- [`../apps/server/prisma/schema.prisma`](../apps/server/prisma/schema.prisma)
- [`../packages/shared/src/index.ts`](../packages/shared/src/index.ts)

核心模型：

- `UserSettings`：模型供应商、模型参数、语言、加密 API Key、模型预设、用户画像摘要等。
- `Character`：`cardId`、`name`、`avatar`、`description`、`prefix`、`prompt`、`suffix`、`htmlCss`、`openingHtml`、`tags`、`loreEntries`、`quickReplies`。
- `Chat`：`title`、`characterId`、`memoryTurns`、`backgroundUrl`、`userPersona`、`userProfileSummary`。
- `Message`：`chatId`、`role`、`characterId`、`content`、`variants`、`activeVariantIndex`、`tokenUsage`、`loreMatches`。

## 开发注意事项

- 所有第三方 LLM 请求必须通过后端代理。
- 前端不能直接持有或调用第三方模型 API Key。
- 日志中不要泄漏 API Key、用户画像摘要或真实聊天内容。
- 修改数据模型时，需要同步检查 Prisma schema、Zod schema、serializer、shared types、web API client、README、smoke test 和 E2E。
- 修改 prompt 结构时，需要同步更新服务端测试。
- 贡献内容应保持在当前产品边界内：单角色聊天 + 角色内嵌 lore。

## 许可证

本项目采用 [`AGPL-3.0-or-later`](../LICENSE)。
