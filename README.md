# Star Companion / 星伴

English | [中文](#中文)

![Star Companion logo](apps/web/public/app-logo-v2.png)

Star Companion is a local-first AI character chat platform for single-character roleplay conversations. It is an original implementation: it does not copy TavernAI, SillyTavern, or any other existing project's source code, UI, assets, default characters, backgrounds, or branding.

The project is built for people who want a private, inspectable local chat workspace with character cards, streaming replies, embedded lore, backups, and desktop/mobile-friendly workflows.

## Highlights

- Local-first data with SQLite and Prisma.
- Single-user, single-character chat model.
- Character CRUD, import/export, private character-card unlocks, tags, quick replies, avatar display, and per-character HTML/CSS styling.
- Streaming assistant replies over WebSocket, stop generation, regenerate, edit, delete, copy, and switch message variants.
- OpenAI-compatible backend proxy plus native Anthropic Claude and Google Gemini adapters.
- Model presets, provider templates, batch model ID import, and connection testing.
- Chat-level background images, persona/profile memory, automatic user-profile summaries, and embedded character `loreEntries` keyword injection.
- Local backup import/export and manual LAN sync between desktop and mobile devices.
- In-app docs page for supported chat UI selectors and future tutorials.
- Electron desktop packaging and Android mobile build scaffolding.

## Product Scope

Star Companion currently follows a fixed product boundary:

- One user + one assistant character reply.
- No group chat.
- No standalone lorebook/world book page, API, Prisma model, or backup protocol.
- Character context expansion stays inside `Character.loreEntries`.
- Current app pages are `/`, `/characters`, `/settings`, and `/docs`.

Historical references to group chat, lorebooks, `firstMessage`, `exampleDialog`, `scenario`, or `systemPrompt` are compatibility/history context, not the current product direction.

## Tech Stack

- Frontend: React, TypeScript, Vite
- UI: Tailwind CSS
- State: Zustand
- Backend: Node.js, Express, TypeScript
- Database: SQLite, Prisma
- Realtime: WebSocket
- Desktop: Electron
- Mobile: Capacitor Android scaffold

## Project Layout

```text
apps/
  web/             React frontend
  server/          Express backend + Prisma
  desktop/         Electron entrypoint
  mobile-backend/  Mobile-side backend helper
packages/
  shared/          Shared frontend/backend types
scripts/
  smoke-api.mjs
  seed-pagination-test.mjs
docs/
  mobile.md
  releases/
```

## Requirements

- Node.js 20+
- npm 11+

This repository uses root-level `npm` scripts to coordinate subprojects. It is not a `pnpm workspace`.

Environment templates:

- Root: `.env.example`
- Server: `apps/server/.env.example`

Create the server environment file before first run:

```powershell
Copy-Item apps/server/.env.example apps/server/.env
```

Important server variables:

```text
DATABASE_URL="file:./dev.db"
SERVER_PORT=4000
CORS_ORIGIN="http://localhost:5173"
API_KEY_ENCRYPTION_SECRET="replace-with-a-long-local-random-secret"
```

`API_KEY_ENCRYPTION_SECRET` encrypts locally stored API keys with AES-256-GCM. If you change this value after saving a key, enter the API key again in Settings.

## Quick Start

Windows users can run the local starter:

```powershell
.\start.cmd
```

Manual startup:

```bash
npm install
npm run db:generate
npm run db:migrate:deploy
npm run dev
```

Default URLs:

- Web: `http://localhost:5173`
- Server: `http://localhost:4000`
- Health: `http://localhost:4000/api/health`
- WebSocket: `ws://localhost:4000/ws`

App routes:

- Chat: `http://localhost:5173/`
- Characters: `http://localhost:5173/characters`
- Settings: `http://localhost:5173/settings`
- Docs: `http://localhost:5173/docs`

## Commands

```bash
npm run dev
npm run build
npm run desktop:dev
npm run desktop:pack
npm run desktop:build
npm run mobile:sync
npm run mobile:build:android
npm run lint
npm run test:server
npm run test:api
npm run test:e2e
npm run db:generate
npm run db:migrate
npm run db:migrate:deploy
```

Notes:

- `npm run dev` starts shared types, server, and web together.
- `npm run build` builds shared, server, and web.
- `npm run desktop:pack` creates an unpacked Windows desktop directory under `dist/desktop/win-unpacked`.
- `npm run desktop:build` creates the Windows desktop installer `Star Companion.exe` under `dist/desktop`.
- `npm run mobile:build:android` creates the debug APK `Star Companion.apk` under `android/app/build/outputs/apk/debug`.
- `npm run test:api` replays committed Prisma migration SQL into a fresh SQLite database before running API smoke checks.
- `npm run test:e2e` runs the Playwright frontend suite.

Install Playwright Chromium on first use:

```bash
npm exec --prefix apps/web playwright install chromium
```

## API Surface

Main HTTP routes:

- `/api/health`
- `/api/characters`
- `/api/chats`
- `/api/messages`
- `/api/settings`
- `/api/backups`
- `/api/sync`

Additional routes:

- `GET /api/characters/page`
- `POST /api/characters/import`
- `POST /api/characters/:id/export`
- `POST /api/characters/:id/unlock`
- `POST /api/settings/test`
- `GET /api/settings/models`
- `PUT /api/settings/user-profile`

Realtime entrypoint:

- `ws://localhost:4000/ws`

There is currently no `/api/lorebooks` route and no `/lore` page.

## Data Model

Use `apps/server/prisma/schema.prisma` and `packages/shared/src/index.ts` as the source of truth.

Current core models:

- `UserSettings`: provider, model, generation settings, language, encrypted API key, model presets, profile summary, avatar display settings.
- `Character`: `cardId`, `name`, `avatar`, `description`, `prefix`, `prompt`, `suffix`, `htmlCss`, `openingHtml`, `tags`, `loreEntries`, `quickReplies`.
- `Chat`: `title`, `characterId`, `memoryTurns`, `backgroundUrl`, `userPersona`, `userProfileSummary`, `userProfileUpdatedAt`.
- `Message`: `chatId`, `role`, `characterId`, `content`, `variants`, `activeVariantIndex`, `tokenUsage`, `loreMatches`.

## Prompt Assembly

The chat prompt pipeline is implemented in `apps/server/src/services/promptBuilder.ts`.

Current order:

1. Character raw system content: `prefix`, `prompt`, `suffix`.
2. Chat-level `userPersona`.
3. Chat-level `userProfileSummary`.
4. Matched embedded character `loreEntries`.
5. Recent chat messages.

Do not reintroduce hardcoded system prompt wrappers unless the product direction explicitly changes. If the prompt structure changes, update server tests at the same time.

## Releases

Release notes are tracked in [RELEASES.md](RELEASES.md). GitHub release drafts live under [docs/releases](docs/releases).

The repository includes a manual/tag-triggered GitHub Actions workflow at `.github/workflows/release.yml` for building Windows desktop release artifacts.

## Contributing

Keep changes aligned with the current product boundary: single-character chat plus embedded character lore. For data model changes, check Prisma schema, Zod schema, serializers, shared types, web types, API client, README, smoke tests, and E2E coverage together.

Sensitive data rules:

- API keys stay in local settings and are encrypted at rest.
- All LLM requests go through the backend proxy.
- The frontend must not hold or call third-party model API keys directly.
- Logs must not leak API keys, profile summaries, or real chat content.

## License

No open-source license has been selected yet. Until a license is added, all rights are reserved by the repository owner.

---

# 中文

[English](#star-companion--星伴) | 中文

![星伴 Logo](apps/web/public/app-logo-v2.png)

星伴是一个本地优先的 AI 角色聊天平台，面向单角色扮演对话。它是原创实现：不复制 TavernAI、SillyTavern 或其他现有项目的源码、UI、素材、默认角色、默认背景或品牌命名。

这个项目适合需要私密、可检查、本地可运行聊天工作台的用户：它支持角色卡、流式回复、角色内嵌 lore、本地备份，以及桌面端/移动端友好的使用流程。

## 亮点

- SQLite + Prisma 本地优先数据。
- 单用户 + 单角色回复的聊天模型。
- 角色 CRUD、导入导出、私有角色卡解锁、标签、快捷回复、头像显示和按角色生效的 HTML/CSS 样式。
- WebSocket 流式回复、停止生成、重新生成、编辑、删除、复制和消息 variants 切换。
- OpenAI-compatible 后端代理，以及 Anthropic Claude / Google Gemini 原生适配。
- 模型预设、供应商模板、模型 ID 批量导入和连接测试。
- 聊天级背景图、persona/profile memory、用户画像摘要自动更新和角色内嵌 `loreEntries` 关键词注入。
- 本地备份导入导出，以及桌面端/移动端之间的局域网手动同步。
- 应用内文档页，用于说明聊天 UI 选择器和后续教程。
- Electron 桌面版打包，以及 Android 移动端构建脚手架。

## 产品边界

星伴当前按以下固定边界维护：

- 单用户 + 单助手角色回复。
- 不做群聊。
- 不做独立 lorebook / world book 页面、API、Prisma 模型或备份协议。
- 角色上下文补充只保留 `Character.loreEntries` 这条路线。
- 当前应用页面为 `/`、`/characters`、`/settings` 和 `/docs`。

历史语境中出现的群聊、lorebook、`firstMessage`、`exampleDialog`、`scenario` 或 `systemPrompt` 只作为兼容/历史语境理解，不代表当前产品方向。

## 技术栈

- 前端：React、TypeScript、Vite
- UI：Tailwind CSS
- 状态管理：Zustand
- 后端：Node.js、Express、TypeScript
- 数据库：SQLite、Prisma
- 实时能力：WebSocket
- 桌面端：Electron
- 移动端：Capacitor Android 脚手架

## 目录结构

```text
apps/
  web/             React 前端
  server/          Express 后端 + Prisma
  desktop/         Electron 入口
  mobile-backend/  移动端后端辅助服务
packages/
  shared/          前后端共享类型
scripts/
  smoke-api.mjs
  seed-pagination-test.mjs
docs/
  mobile.md
  releases/
```

## 环境要求

- Node.js 20+
- npm 11+

本仓库通过根目录 `npm` 脚本协调各子项目，不使用 `pnpm workspace`。

环境变量模板：

- 根目录：`.env.example`
- 后端：`apps/server/.env.example`

首次运行前建议创建后端环境文件：

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

`API_KEY_ENCRYPTION_SECRET` 用于通过 AES-256-GCM 加密本地保存的 API Key。更换该值后，已有密文 Key 需要在设置页重新填写。

## 快速开始

Windows 用户可以运行本地启动脚本：

```powershell
.\start.cmd
```

手动启动：

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

- 聊天页：`http://localhost:5173/`
- 角色页：`http://localhost:5173/characters`
- 设置页：`http://localhost:5173/settings`
- 文档页：`http://localhost:5173/docs`

## 常用命令

```bash
npm run dev
npm run build
npm run desktop:dev
npm run desktop:pack
npm run desktop:build
npm run mobile:sync
npm run mobile:build:android
npm run lint
npm run test:server
npm run test:api
npm run test:e2e
npm run db:generate
npm run db:migrate
npm run db:migrate:deploy
```

说明：

- `npm run dev` 会同时启动 shared 类型、server 和 web。
- `npm run build` 会构建 shared、server 和 web。
- `npm run desktop:pack` 会生成免安装 Windows 桌面目录，输出到 `dist/desktop/win-unpacked`。
- `npm run desktop:build` 会在 `dist/desktop` 下生成 Windows 桌面安装包 `Star Companion.exe`。
- `npm run mobile:build:android` 会在 `android/app/build/outputs/apk/debug` 下生成调试 APK `Star Companion.apk`。
- `npm run test:api` 会基于已提交的 Prisma migration SQL 初始化 fresh SQLite，再运行 API 冒烟检查。
- `npm run test:e2e` 会运行 Playwright 前端端到端测试。

首次运行 Playwright 可安装 Chromium：

```bash
npm exec --prefix apps/web playwright install chromium
```

## API 入口

主要 HTTP 路由：

- `/api/health`
- `/api/characters`
- `/api/chats`
- `/api/messages`
- `/api/settings`
- `/api/backups`
- `/api/sync`

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

## 数据模型

请以 `apps/server/prisma/schema.prisma` 和 `packages/shared/src/index.ts` 为准。

当前核心模型：

- `UserSettings`：供应商、模型、生成参数、语言、加密 API Key、模型预设、用户画像摘要、头像显示设置。
- `Character`：`cardId`、`name`、`avatar`、`description`、`prefix`、`prompt`、`suffix`、`htmlCss`、`openingHtml`、`tags`、`loreEntries`、`quickReplies`。
- `Chat`：`title`、`characterId`、`memoryTurns`、`backgroundUrl`、`userPersona`、`userProfileSummary`、`userProfileUpdatedAt`。
- `Message`：`chatId`、`role`、`characterId`、`content`、`variants`、`activeVariantIndex`、`tokenUsage`、`loreMatches`。

## Prompt 组装

聊天 prompt 管线位于 `apps/server/src/services/promptBuilder.ts`。

当前顺序：

1. 角色卡原始系统内容：`prefix`、`prompt`、`suffix`。
2. 聊天级 `userPersona`。
3. 聊天级 `userProfileSummary`。
4. 命中的角色内嵌 `loreEntries`。
5. 最近聊天记录。

不要在未明确变更产品方向的情况下重新引入硬编码系统提示包装。如果修改 prompt 结构，需要同步更新服务端测试。

## Releases

发布说明记录在 [RELEASES.md](RELEASES.md)。GitHub Release 草稿位于 [docs/releases](docs/releases)。

仓库包含 `.github/workflows/release.yml`，可在打 `v*` tag 或手动运行时构建 Windows 桌面发布产物。

## 贡献

请让改动保持在当前产品边界内：单角色聊天 + 角色内嵌 lore。涉及数据模型变更时，需要同步检查 Prisma schema、Zod schema、serializer、shared types、前端类型、API client、README、smoke test 和 E2E 覆盖。

敏感信息规则：

- API Key 只保存在本地设置中，并加密存储。
- 所有 LLM 请求都通过后端代理。
- 前端不能直接持有或调用第三方模型 API Key。
- 日志不能泄漏 API Key、用户画像摘要或真实聊天内容。

## 许可证

项目尚未选择开源许可证。在添加许可证前，保留所有权利。
