# opencode-scheduled-commands

让 [opencode](https://opencode.ai) 像 cron 一样**定时重复执行自定义命令**——每 30 分钟自动修 bug、每天定时推代码、整点跑健康检查，全部无人值守。

- 零依赖、单文件（约 550 行 TypeScript），无需 `npm install`
- 支持 **5 字段 cron 表达式** 与 **固定间隔**（`30s` / `5m` / `2h` / `1d`）
- 配置 **5 秒内热重载**，改 `schedules.json` 无需重启 opencode
- 每次执行创建全新 session，防重叠、可超时 abort、错误隔离、结构化日志、TUI 通知
- 可按任务配置 `allowOverlap: true` 允许重叠运行（上一次未完成也按计划启动新任务）

[English version](./README.md)

## 功能特性

- 读取 `.opencode/schedules.json`（JSONC 格式，支持注释与尾逗号）中的任务列表
- 每个任务可配置 5 字段 cron 表达式或固定间隔（`every`），到期自动执行
- 通过 SDK `session.command` 调用用户自定义命令（`.opencode/commands/*.md`），服务端自动展开命令模板与 `$ARGUMENTS`
- 每次执行都会创建全新的 session（ID 记录到 `.opencode/.scheduled-state.json`），多次执行互不共享对话上下文；会话标题包含本次开始时间
- 防重叠执行：任务执行中即使到点也跳过本次
- 可选超时：单次执行超时自动 abort 会话，防止无人值守时卡死；超时后必须等上一个 session 真正停止，才会执行下一次
- 错误隔离：单个任务配置错误/命令不存在不影响其他任务
- 结构化日志：以 `scheduled-commands` 服务输出
- 可选 TUI toast 通知（Web/headless 环境自动忽略）

## 环境要求

- opencode **v1.18+**（使用 `{ id, server }` server 插件导出格式）

## 安装

**方式一：npm 安装（推荐获取新版本）**

```bash
npm install opencode-scheduled-commands
cp node_modules/opencode-scheduled-commands/scheduled-commands.ts .opencode/plugins/
```

**方式二：直接从仓库复制**

无需安装 npm 包。将 `scheduled-commands.ts` 复制到项目的 `.opencode/plugins/` 目录：

```bash
mkdir -p .opencode/plugins
cp scheduled-commands.ts .opencode/plugins/
```

重启 opencode 生效（之后修改配置无需重启）。插件启动时自动发现并加载。

## 快速开始

### 1. 定义命令（你要"定时干什么"）

在 `.opencode/commands/` 下创建自定义命令，例如 `.opencode/commands/push.md`：

```markdown
---
description: 推送代码与标签（含安全同步检查）
agent: build
---

1. **检查状态**：`git status -sb` 与 `git ls-remote --tags origin`；本地无领先提交且本地 tag 已全部同步 → 提示"没有可推送的内容"并终止
2. **同步上游**：`git fetch origin`；若本地落后 → `git pull --rebase`（有改动先 `git stash push -u`，成功后 `git stash pop`）；冲突 → 停止报告
3. **推送代码**：存在上游 → `git push`；无上游 → `git push -u origin HEAD`
4. **推送标签**：`git push --tags`
5. **验证**：`git status -sb` up-to-date；失败 → 报告错误，禁止 `--force`
```

### 2. 配置调度（.opencode/schedules.json）

```jsonc
{
  // 任务列表（JSONC，支持注释与尾逗号）
  "jobs": [
    {
      "name": "每 30 分钟拉取源码并修 bug", // 任务名（唯一标识）
      "command": "bugfix",                   // 执行 .opencode/commands/bugfix.md
      "arguments": "",                       // 传给命令的参数（$ARGUMENTS / $1 ...）
      "cron": "*/30 * * * *",                // 5 字段 cron：分 时 日 月 周
      // "every": "30m",                     // 或固定间隔："30s"、"5m"、"2h"、"1d"
      "enabled": true,                       // false 时跳过该任务
      "notify": true,                        // 完成后发送 TUI toast 通知
      "timeoutMs": 600000                    // 单次执行超时（毫秒），超时 abort
    }
  ]
}
```

完整字段说明见 [examples/schedules.example.json](examples/schedules.example.json) 与下方字段表。

## 配置字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | 任务名，唯一标识，用于状态记录与日志（不填则用 `命令#序号`） |
| `command` | string | **必填**。自定义命令名，对应 `.opencode/commands/<command>.md` |
| `arguments` | string | 传给命令的参数（对应模板中的 `$ARGUMENTS` / `$1` / `$2` ...） |
| `agent` | string | 覆盖命令 frontmatter 中指定的 agent（不填用命令默认） |
| `model` | string | 覆盖执行模型（不填用命令/会话默认模型） |
| `cron` | string | 5 字段 cron：`分 时 日 月 周`（与 `every` 二选一，`cron` 优先） |
| `every` | string | 固定间隔：`30s`、`5m`、`2h`、`1d`（默认单位秒） |
| `enabled` | boolean | `false` 时跳过该任务（默认 true） |
| `notify` | boolean | 执行完成后尝试发送 TUI toast 通知 |
| `timeoutMs` | number | 单次执行超时（毫秒），超时后 abort 会话并标记 `timeout`（0 = 不限） |
| `allowOverlap` | boolean | `true` 时允许与上一次执行重叠：上一次未完成也按计划启动新任务（默认 `false`） |

### 调度规则

**cron（5 字段：分 时 日 月 周）**

- 支持 `*`、`*/n` 步进、`a-b` 范围、`a,b,c` 列表组合
- 周字段 `0` 与 `7` 均为周日
- vixie cron 语义：日与周字段同时受限时取 OR，否则取 AND
- 示例：`*/30 * * * *` 每 30 分钟；`0 9 * * 1-5` 工作日 9 点；`0 2 * * *` 每天凌晨 2 点
- ⚠️ `*/30` 写在**分字段**才是"每 30 分钟"；写在时字段（`* */30 * * *`）只在 0 点匹配

**every（固定间隔）**

- 单位 `ms` / `s` / `m` / `h` / `d`，默认秒
- 基于 `lastRun` 推进；opencode 关闭期间错过的触发只补一次（catch-up），不连补

## 运行机制

- **每次新建 session**：每次执行创建全新 session，标题 `[scheduled] <开始时间> <任务名>`（如 `[scheduled] 2026-08-10 14:30:00 每 30 分钟修 bug #1`），可在 TUI 会话列表查看执行过程；最近 session ID 记录在 `.opencode/.scheduled-state.json`（仅记录，不复用）
- **防重叠**：任务执行中即使到点也跳过本次；不同任务可并行。超时 abort 后也会等上一个会话完全停止再放行下一次，且同一目录只允许一个调度器实例（避免重复/重叠执行）。若某任务需要并发，可设置 `"allowOverlap": true`——此时不再等待上一次完成，按计划启动新任务（`every` 的间隔从上次**启动**时刻起算，cron 则按墙钟触发，慢任务不会拖住后续触发）
- **状态文件**：`.opencode/.scheduled-state.json` 记录每个任务的 sessionId、最近运行时间/状态（`ok`/`error`/`timeout`/`aborted`/`skipped`）/次数；删除文件可重置全部任务
- **热重载**：每 5 秒 tick 重读配置文件，修改 `schedules.json` 最多 5 秒生效
- **日志**：通过 `client.app.log` 以 `scheduled-commands` 服务输出结构化日志
- **配置隔离**：单个 Job 字段错误 → 跳过该 Job；整个文件解析失败 → 本次不加载、5 分钟才重复报错；修好自动恢复

## 注意事项

1. **权限**：定时任务以 SDK 方式驱动 agent 执行；项目权限为 `ask` 时无人值守可能挂起等待确认，建议给任务涉及的工具配置 `allow`
2. **模型成本**：定时任务真实消耗模型 token，请合理设置调度频率
3. **命令不存在**：执行时返回错误并记录到状态文件，不影响其他任务
4. **插件修改需重启**；配置修改无需重启

## 示例命令

仓库自带的实战命令：

- [examples/commands/push.md](examples/commands/push.md) — 推送代码与标签（含安全同步检查）
- [examples/commands/bugfix.md](examples/commands/bugfix.md) — 拉取最新源码、随机找 bug、谨慎修复、跑集成测试、提交（每 30 分钟自动修 bug 场景）

## 常见配置示例

```jsonc
{
  "jobs": [
    { "name": "每 30 分钟推送", "command": "push", "every": "30m" },
    { "name": "工作日 9 点启动", "command": "start", "cron": "0 9 * * 1-5" },
    { "name": "每分钟健康检查", "command": "check", "cron": "* * * * *", "timeoutMs": 120000 }
  ]
}
```

## 测试

使用 Node.js 内置测试运行器（`node:test`，无需安装依赖），直接运行 TypeScript：

```bash
npm test
```

覆盖内容：

- **纯函数**：`parseJsonc`（注释/尾逗号/字符串内注释）、`parseCron`（字段/步进/范围/周 0 与 7）、`nextCronTime`（含 vixie 日/周 OR 语义）、`parseInterval`、`nextIntervalTime`、`errorMessage`
- **调度器**（`createScheduler` + mock SDK client）：`every`/`cron` 触发、热重载、间隔 catch-up、防重叠、`allowOverlap` 并发、超时 abort（含"上一个会话停止前不放行下一次"）、状态文件持久化、配置错误隔离

## License

[MIT](LICENSE)