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

- Hash 路由：`#/chat`、`#/characters`、`#/lore`、`#/settings`
- 聊天页可创建聊天、绑定角色、保存/编辑/删除用户消息
- 角色页可创建、编辑、删除、导入和导出角色 JSON
- 世界书页可创建、编辑、删除 lorebook 和 lore entry
- 设置页可读取、保存本地模型 API 配置，并通过后端 health check 测试代理可达性

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

- Chat：http://localhost:5173/#/chat
- Characters：http://localhost:5173/#/characters
- Lorebooks：http://localhost:5173/#/lore
- Settings：http://localhost:5173/#/settings

## 构建检查

```bash
npm run build
```

## Lint 检查

```bash
npm run lint
```

## 数据库

SQLite 数据库默认使用：

```text
apps/server/prisma/dev.db
```

阶段 3 已在 CRUD API 基础上接入前端页面，后续阶段会继续实现 LLM 代理和流式聊天。

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
  -d "{\"name\":\"原创旅人\",\"description\":\"一个用于本地测试的原创角色\",\"tags\":[\"test\"]}"
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
  -d "{\"activeProvider\":\"openai-compatible\",\"apiBaseUrl\":\"https://api.openai.com/v1\",\"apiKey\":\"本地密钥\",\"model\":\"gpt-4o-mini\",\"temperature\":0.8,\"maxTokens\":800,\"topP\":1}"
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

MVP 阶段允许 API Key 暂存在本地 SQLite 配置中。后续会增加本地加密方案。所有 LLM 请求必须从后端代理发起，前端不会直接持有或调用模型 API Key。
