# Local Roleplay Platform

一个本地优先的 AI 角色聊天平台 MVP。项目采用原创实现，不复制 TavernAI / SillyTavern 的代码、UI、素材、默认角色或品牌命名。

## 当前阶段

阶段 1 已搭建基础工程：

- npm monorepo
- `apps/web`：React + TypeScript + Vite + Tailwind CSS + Zustand
- `apps/server`：Node.js + Express + TypeScript
- `packages/shared`：前后端共享类型
- Prisma + SQLite 初始配置
- 统一的开发和构建脚本

阶段 2 已加入基础 API：

- `characters`、`chats`、`messages`、`settings`、`lorebooks` CRUD
- `lorebooks` 下的 `entries` CRUD
- Zod 请求校验
- Prisma 错误处理和统一 JSON 错误响应
- 设置接口可保存 API Key，但响应不会返回 API Key 明文

阶段 3 已接入前端基础 UI：

- 页面路由：`/`、`/characters`、`/lore`、`/settings`，并保留旧 hash 路由兼容
- 聊天页可创建聊天、绑定角色、保存/编辑/删除用户消息
- 角色页可创建、编辑、删除、导入和导出角色 JSON
- 世界书页可创建、编辑、删除 lorebook 和 lore entry
- 设置页可读取、保存本地模型 API 配置，并通过后端 health check 测试代理可达性

阶段 4 已接入 LLM 代理与流式生成：

- 后端通过 OpenAI-compatible `chat/completions` 发起流式请求
- 前端通过 WebSocket `/ws` 接收 token 并实时显示
- 支持停止生成，后端使用 `AbortController` 中止请求
- assistant 回复会保存到 SQLite；停止时若已有部分内容也会保存
- 设置页的“测试模型连接”会通过后端访问 `GET /models`
- API Key 仍只保存在本地数据库，前端不会直接调用模型服务

阶段 5 已完善角色聊天体验：

- 角色卡保留头像，并使用前置词、提示词、后置词三段式提示结构
- 后端生成前会组装角色 prompt：全局系统提示、角色前置词、提示词、后置词和最近聊天记录
- 支持复制、编辑、删除消息
- 支持重新生成 assistant 消息
- 重新生成不会覆盖原始内容，而是追加到 `variants`，并切换到新变体
- 前端可左右切换 assistant 消息 variants
- 聊天气泡会显示用户头像占位和角色头像

阶段 6 已接入世界书：

- 发送消息或重新生成前，会根据最近聊天上下文匹配启用的 lore entries
- 关键词匹配大小写不敏感，命中条目按 `priority` 和更新时间排序
- 最多注入 8 条 lore entries，避免 prompt 过长
- 命中的世界书内容会作为 system context 注入模型 prompt
- WebSocket 会返回 `lore_matches` 事件
- 前端聊天页会显示本次命中的世界书条目、关键词、优先级和内容预览

阶段 7 已接入群聊：

- `mode: group` 的 Chat 会按 `characterIds` 顺序让多个角色依次回复
- 每个角色回复前都会用该角色的人设独立组装 prompt
- WebSocket 会发送 `generation_character_started`，前端显示当前正在回复的角色
- 每个角色回复都会保存为独立 assistant 消息，并带有对应 `characterId`
- 单聊保持原有行为；后续可在此基础上扩展“自动判断谁该回复”

阶段 8 已完成导入导出和收尾打磨：

- 设置页新增完整备份导出和导入入口
- 完整备份包含 settings、characters、chats、messages、lorebooks 和 lore entries
- 导出 settings 时不会包含 API Key
- 导入备份通过 Zod 校验，支持 `merge` 合并和 `replace` 替换两种模式
- 替换模式会清空角色、聊天、消息和世界书，但保留本地 API Key
- 后端新增 `/api/backups/export` 和 `/api/backups/import`
- 调整 JSON 请求体上限，便于导入较大的本地备份文件

近期收口补充：

- 聊天页移动端改为“聊天列表 / 消息流 / 创建聊天”三段式面板，桌面端仍保持三栏布局。
- 角色管理支持搜索、复制角色，并在编辑表单中即时预览头像。
- API Key 在写入 SQLite 前会用 `API_KEY_ENCRYPTION_SECRET` 做本地 AES-256-GCM 加密；旧的明文 Key 仍可兼容读取，下一次保存会转为密文。
- 新增 Playwright 前端 E2E 测试，覆盖真实路由、角色保存反馈和移动端面板切换。

## 目录结构

```text
apps/
  web/       React 前端
  server/    Express 后端与 Prisma
packages/
  shared/    共享类型与常量
```

## 环境准备

需要安装 Node.js 20+。当前项目使用 npm workspaces，避免 Windows 环境下 pnpm/Corepack 符号链接权限问题。

后端环境变量示例位于 `apps/server/.env.example`。首次本地开发可以复制为 `.env`：

```bash
cp apps/server/.env.example apps/server/.env
```

Windows PowerShell：

```powershell
Copy-Item apps/server/.env.example apps/server/.env
```

建议把 `API_KEY_ENCRYPTION_SECRET` 改成一段只保存在本机的长随机字符串。该值用于解密本地数据库中的 API Key；如果更换它，已加密保存的 API Key 需要重新填写。

## 安装与启动

```bash
npm install
npm run db:generate
npm run db:push
npm run dev
```

默认地址：

- Web：http://localhost:5173
- Server：http://localhost:4000
- Health check：http://localhost:4000/api/health

前端页面：

- Chat：http://localhost:5173/
- Characters：http://localhost:5173/characters
- Lorebooks：http://localhost:5173/lore
- Settings：http://localhost:5173/settings

旧的 hash 地址如 `#/characters` 仍可打开，但新开发和文档以真实路径为准。

## 构建检查

```bash
npm run build
```

## Lint 检查

```bash
npm run lint
```

## API Smoke Test

启动后端后，可以运行一轮非 LLM 的 API 冒烟测试。测试会临时创建角色、聊天、消息和世界书数据，验证 CRUD 与备份导出，然后清理测试数据。

```bash
npm run test:api
```

如果后端不在默认端口，可指定：

```bash
API_BASE_URL=http://localhost:4000 npm run test:api
```

## 前端 E2E Test

首次运行前安装 Playwright 浏览器：

```bash
npm exec --prefix apps/web playwright install chromium
```

运行 E2E：

```bash
npm run test:e2e
```

测试会复用已启动的 `http://localhost:5173`；如果没有启动，会自动通过根目录 `npm run dev` 拉起前后端和共享包监听进程。

## 数据库

SQLite 数据库默认使用：

```text
apps/server/prisma/dev.db
```

开发期可以使用：

```bash
npm run db:generate
npm run db:migrate
```

部署或 CI 环境使用：

```bash
npm run db:migrate:deploy
```

`npm run db:push` 仍保留给快速本地原型同步使用，但正式协作建议优先使用 migration。

角色表当前字段为 `name`、`avatar`、`prefix`、`prompt`、`suffix`。如果从旧数据结构迁移，建议先导出完整备份；导入旧角色 JSON 时，后端会兼容性地把旧字段映射为：

- `systemPrompt` → `prefix`
- `description` → `prompt`
- `scenario` → `suffix`

已提供基线迁移：`apps/server/prisma/migrations/20260521000100_init`。

阶段 8 已实现完整备份导入导出和设置页数据迁移入口，并已补充移动端聊天面板、角色管理搜索/复制、本地 API Key 加密和前端 E2E 测试。后续可继续做备份冲突预览、更完整的消息流 E2E、生产部署路由 fallback 和更多可访问性检查。

## 基础 API 测试

启动后端：

```bash
npm run start --prefix apps/server
```

健康检查：

```bash
curl http://localhost:4000/api/health
```

创建角色：

```bash
curl -X POST http://localhost:4000/api/characters \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"原创旅人\",\"avatar\":\"\",\"prefix\":\"你正在扮演原创旅人。\",\"prompt\":\"一个谨慎、好奇、擅长记录线索的旅人。\",\"suffix\":\"保持第一人称角色口吻，回复简洁。\"}"
```

创建聊天：

```bash
curl -X POST http://localhost:4000/api/chats \
  -H "Content-Type: application/json" \
  -d "{\"title\":\"测试聊天\",\"mode\":\"single\",\"characterIds\":[]}"
```

创建消息：

```bash
curl -X POST http://localhost:4000/api/messages \
  -H "Content-Type: application/json" \
  -d "{\"chatId\":\"替换为聊天ID\",\"role\":\"user\",\"content\":\"你好\"}"
```

读取或更新设置：

```bash
curl http://localhost:4000/api/settings

curl -X PUT http://localhost:4000/api/settings \
  -H "Content-Type: application/json" \
  -d "{\"activeProvider\":\"openai-compatible\",\"apiBaseUrl\":\"https://api.openai.com/v1\",\"apiKey\":\"本地密钥\",\"model\":\"gpt-4o-mini\",\"temperature\":0.8,\"maxTokens\":800,\"topP\":1,\"language\":\"zh-CN\"}"
```

测试模型连接：

```bash
curl -X POST http://localhost:4000/api/settings/test
```

导出完整备份：

```bash
curl http://localhost:4000/api/backups/export
```

导入完整备份：

```bash
curl -X POST http://localhost:4000/api/backups/import \
  -H "Content-Type: application/json" \
  -d "{\"schemaVersion\":1,\"mode\":\"merge\",\"characters\":[],\"chats\":[],\"messages\":[],\"lorebooks\":[]}"
```

创建世界书和条目：

```bash
curl -X POST http://localhost:4000/api/lorebooks \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"测试世界书\",\"description\":\"本地测试\"}"

curl -X POST http://localhost:4000/api/lorebooks/替换为世界书ID/entries \
  -H "Content-Type: application/json" \
  -d "{\"keys\":[\"王都\"],\"content\":\"王都是大陆北方的贸易中心。\",\"priority\":10,\"enabled\":true}"
```

## 安全说明

API Key 只通过设置页写入本地 SQLite，前端不会直接调用模型服务，也不会从设置接口读取明文 Key。后端保存前会使用 `API_KEY_ENCRYPTION_SECRET` 做本地加密；请不要把 `.env` 或真实 Key 提交到远程仓库。完整备份导出不会包含 API Key。
