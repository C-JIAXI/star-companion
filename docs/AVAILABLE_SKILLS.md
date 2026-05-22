# 可用 Skills 说明

这份文档记录当前 Codex 会话里可直接使用的 skills，以及本项目里最常用的调用方式。

- 同步时间：`2026-05-21`
- 触发方式：
  - 直接自然语言描述需求
  - 显式点名，例如 `[$qa](C:\Users\CJIAXI\.codex\skills\qa\SKILL.md)`

## 当前状态

- 已同步当前会话内可用 skills
- `openai/skills` 仓库当前未提供此前推荐的 `frontend-skill`
- 因此当前前端制作仍以本机已有 skills 为主：`prototype`、`design-an-interface`、`browser:browser`、`imagegen`

## 前端制作优先组合

| 场景 | 优先 Skill |
| --- | --- |
| 做页面结构和交互原型 | `prototype` |
| 比较多套界面或接口方案 | `design-an-interface` |
| 打开本地页面、点击、截图、回归检查 | `browser:browser` |
| 生成插图、背景图、贴图、位图素材 | `imagegen` |
| 做移动端/桌面端样式问题排查 | `browser:browser` + `diagnose` |

## 开发与调试

| Skill | 能做什么 |
| --- | --- |
| `diagnose` | 按“复现 -> 缩小 -> 假设 -> 验证 -> 修复 -> 回归测试”的流程处理 bug、报错、性能回退。 |
| `tdd` | 用红绿重构方式写功能或修 bug，先补测试，再实现。 |
| `review` | 审查某个分支、PR 或一段 WIP 变更，重点找 bug、风险、缺测试和需求偏差。 |
| `prototype` | 快速做可运行原型，用来试 UI、状态机、数据模型或交互方案。 |
| `zoom-out` | 在不熟悉代码区域时拉远视角，解释它和整体架构的关系。 |
| `improve-codebase-architecture` | 找架构深化机会，例如解耦、提高可测试性、整理模块边界。 |
| `request-refactor-plan` | 通过访谈生成细粒度重构计划，并可整理成 issue。 |
| `setup-pre-commit` | 配置 Husky、lint-staged、格式化、类型检查和测试等提交前检查。 |
| `migrate-to-shoehorn` | 把测试里的 `as` 类型断言迁移到 `@total-typescript/shoehorn`。 |
| `scaffold-exercises` | 创建课程练习目录、题目、答案和讲解结构，并检查 lint。 |

## GitHub 与项目管理

| Skill | 能做什么 |
| --- | --- |
| `github:github` | 查询仓库、PR、issue，做 GitHub 工作的上下文梳理。 |
| `github:gh-address-comments` | 查看并处理 PR review comments、requested changes 和 unresolved threads。 |
| `github:gh-fix-ci` | 调试 GitHub Actions CI 失败，查看日志并修复。 |
| `github:yeet` | 把本地变更整理、提交、推送，并创建 draft PR。 |
| `qa` | 交互式 QA 会话，把用户报告的问题整理成可执行 GitHub issues。 |
| `triage` | 按状态机梳理、分类、推进 issue。 |
| `to-issues` | 把计划、PRD 或规格拆成可独立领取的 issues。 |
| `to-prd` | 把当前讨论整理成 PRD，并可发布到项目 issue tracker。 |
| `setup-matt-pocock-skills` | 为这些工程协作 skills 初始化仓库说明、issue tracker 规则和领域文档布局。 |

## 设计与产品思考

| Skill | 能做什么 |
| --- | --- |
| `design-an-interface` | 并行探索多个 API/模块接口设计方案，适合“设计两遍”或比较方案。 |
| `grill-me` | 持续追问和拷打一个计划或设计，直到关键分支都想清楚。 |
| `grill-with-docs` | 结合项目文档和领域模型来拷打计划，并把决策更新到文档。 |
| `ubiquitous-language` | 提取 DDD 风格的领域术语表，标记歧义并提出规范术语。 |

## 前端、浏览器与视觉

| Skill | 能做什么 |
| --- | --- |
| `browser:browser` | 打开、点击、截图、检查 localhost 或网页，用于浏览器自动化验证。 |
| `imagegen` | 生成或编辑位图图片，比如照片、插画、纹理、角色图、透明背景 cutout。 |

## 文档、表格与演示

| Skill | 能做什么 |
| --- | --- |
| `documents:documents` | 创建、编辑、渲染和检查 `.docx` 文档。 |
| `presentations:Presentations` | 创建、编辑、渲染和导出 PowerPoint/PPTX。 |
| `spreadsheets:Spreadsheets` | 创建、修改、分析 `.xlsx/.csv/.tsv`，可处理公式、格式、图表和表格。 |

## 写作

| Skill | 能做什么 |
| --- | --- |
| `edit-article` | 编辑文章草稿，重组结构、提升清晰度、收紧表达。 |
| `writing-fragments` | 访谈式挖掘写作碎片，把原始材料追加到文档里。 |
| `writing-shape` | 把碎片或草稿逐步塑造成可发布文章。 |
| `writing-beats` | 以“叙事节拍”方式一段段构建文章，让你选择下一步走向。 |

## 知识库与交接

| Skill | 能做什么 |
| --- | --- |
| `obsidian-vault` | 在 Obsidian vault 中搜索、创建、整理笔记和 wikilinks。 |
| `handoff` | 把当前上下文压缩成交接文档，方便另一个 agent 接手。 |

## OpenAI、插件与 Skill 管理

| Skill | 能做什么 |
| --- | --- |
| `openai-docs` | 查询最新 OpenAI 官方文档，回答 API、模型、SDK、迁移和提示升级问题。 |
| `plugin-creator` | 创建 Codex 插件目录和 `.codex-plugin/plugin.json` 等结构。 |
| `skill-creator` | 指导如何创建高质量 skill。 |
| `write-a-skill` | 编写结构完整、渐进披露良好的新 agent skill。 |
| `skill-installer` | 从 curated list 或 GitHub repo 安装 skills。 |
| `translate-skill` | 翻译或刷新 mattpocock/skills 的中文本地化内容。 |

## 工具与沟通模式

| Skill | 能做什么 |
| --- | --- |
| `caveman` | 超压缩沟通模式，大幅减少 token 和解释，只保留技术准确性。 |
| `git-guardrails-claude-code` | 为 Claude Code 设置危险 git 命令拦截 hooks。 |

## 当前项目最常用组合

- 报 bug：`diagnose`
- 想知道还缺什么：`qa` 或 `review`
- 新功能要稳一点：`tdd`
- 要拆任务：`to-issues`
- 要写毕设或说明文档：`edit-article`、`documents:documents`
- 要做界面验证：`browser:browser`
- 要整理架构：`zoom-out`、`improve-codebase-architecture`
- 要做前端快速改版：`prototype` + `browser:browser`
