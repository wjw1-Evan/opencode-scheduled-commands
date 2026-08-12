# opencode-scheduled-commands

Schedule opencode commands like cron—auto-fix bugs every 30 minutes, push code daily, run health checks on the hour, all unattended.

- **Zero dependency, single file** (~550 lines TypeScript), no `npm install` needed
- **Support for 5-field cron expressions** and **fixed intervals** (`30s` / `5m` / `2h` / `1d`)
- **Hot-reload within 5 seconds**, modify `schedules.json` without restarting opencode
- Creates a new session for each run, with overlap prevention, timeout abort, error isolation, structured logs, and TUI notifications
- Configure `allowOverlap: true` to allow concurrent runs (starts new tasks even if previous one is still running)

[简体中文版](./README.zh-CN.md)

## Features

- Reads task list from `.opencode/schedules.json` (JSONC format with comments and trailing commas)
- Each task can be configured with 5-field cron expression or fixed interval (`every`), executes when due
- Calls user-defined commands (`.opencode/commands/*.md`) via SDK `session.command`, server automatically expands command templates and `$ARGUMENTS`
- Each execution creates a new session (ID recorded in `.opencode/.scheduled-state.json`), multiple executions don't share conversation context; session title includes start time
- **Overlap prevention**: skips execution if task is already running; different tasks can run in parallel
- **Optional timeout**: automatically aborts session on timeout to prevent hanging during unattended operation; waits for previous session to fully stop before next execution
- **Error isolation**: individual task config errors/missing commands don't affect other tasks
- **Structured logging**: outputs as `scheduled-commands` service
- **Optional TUI toast notifications** (automatically ignored in web/headless environments)

## Requirements

- opencode **v1.18+** (uses `{ id, server }` server plugin export format)

## Installation

**Method 1: npm install (recommended for new versions)**

```bash
npm install opencode-scheduled-commands
cp node_modules/opencode-scheduled-commands/scheduled-commands.ts .opencode/plugins/
```

**Method 2: Copy directly from repository**

No npm package installation needed. Copy `scheduled-commands.ts` to your project's `.opencode/plugins/` directory:

```bash
mkdir -p .opencode/plugins
cp scheduled-commands.ts .opencode/plugins/
```

Restart opencode to take effect (no restart needed for config changes). The plugin is auto-discovered and loaded on startup.

## Quick Start

### 1. Define commands (what you want to schedule)

Create custom commands in `.opencode/commands/`, for example `.opencode/commands/push.md`:

```markdown
---
description: Push code and tags (with safe sync check)
agent: build
---

1. **Check status**: `git status -sb` and `git ls-remote --tags origin`; if local has no ahead commits and all local tags are synced → prompt "nothing to push" and exit
2. **Sync upstream**: `git fetch origin`; if local is behind → `git pull --rebase` (run `git stash push -u` first if there are changes, `git stash pop` after success); conflict → stop and report
3. **Push code**: if upstream exists → `git push`; otherwise → `git push -u origin HEAD`
4. **Push tags**: `git push --tags`
5. **Verify**: `git status -sb` shows up-to-date; failure → report error, forbid `--force`
```

### 2. Configure scheduler (.opencode/schedules.json)

```jsonc
{
  // Task list (JSONC, supports comments and trailing commas)
  "jobs": [
    {
      "name": "Fix bugs every 30 minutes", // Task name (unique identifier)
      "command": "bugfix",                   // Execute .opencode/commands/bugfix.md
      "arguments": "",                       // Parameters passed to command ($ARGUMENTS / $1 ...)
      "cron": "*/30 * * * *",                // 5-field cron: min hour day month dow
      // "every": "30m",                     // Or fixed interval: "30s", "5m", "2h", "1d"
      "enabled": true,                       // Skip task if false
      "notify": true,                        // Send TUI toast notification on completion
      "timeoutMs": 600000                    // Single execution timeout (ms), abort on timeout
    }
  ]
}
```

See [examples/schedules.example.json](examples/schedules.example.json) and the field table below for complete field documentation.

## Configuration Fields

| Field | Type | Description |
|------|------|-------------|
| `name` | string | Task name, unique identifier, used for state recording and logging (defaults to `command#index`) |
| `command` | string | **Required**. Custom command name, corresponds to `.opencode/commands/<command>.md` |
| `arguments` | string | Parameters passed to command (corresponds to `$ARGUMENTS` / `$1` / `$2` ... in template) |
| `agent` | string | Override agent specified in command frontmatter (defaults to command's agent) |
| `model` | string | Override execution model (defaults to command/session default model) |
| `cron` | string | 5-field cron: `min hour day month dow` (choose one with `every`, `cron` takes priority) |
| `every` | string | Fixed interval: `30s`, `5m`, `2h`, `1d` (default unit is seconds) |
| `enabled` | boolean | Skip task if `false` (default `true`) |
| `notify` | boolean | Try to send TUI toast notification on completion |
| `timeoutMs` | number | Single execution timeout (ms), abort session and mark as `timeout` on expiry (0 = no limit) |
| `allowOverlap` | boolean | `true` allows overlap with previous execution: starts new task on schedule even if previous one is still running (default `false`) |

### Scheduling Rules

**cron (5 fields: min hour day month dow)**

- Supports `*`, `*/n` step, `a-b` range, `a,b,c` list combinations
- Day of week field `0` and `7` both mean Sunday
- vixie cron semantics: OR when both day fields are restricted, AND otherwise
- Examples: `*/30 * * * *` every 30 minutes; `0 9 * * 1-5` weekdays at 9 AM; `0 2 * * *` daily at 2 AM
- ⚠️ `*/30` in the **minute field** means "every 30 minutes"; in the hour field (`* */30 * * *`) it only matches at 0 o'clock

**every (fixed interval)**

- Units: `ms` / `s` / `m` / `h` / `d`, default is seconds
- Based on `lastRun` progression; missed triggers during opencode downtime only catch up once, not continuously

## How It Works

- **New session each run**: Each execution creates a new session with title `[scheduled] <start time> <task name>` (e.g., `[scheduled] 2026-08-10 14:30:00 Fix bugs every 30 mins #1`), viewable in TUI session list; recent session ID is recorded in `.opencode/.scheduled-state.json` (for record only, not reused)
- **Overlap prevention**: Skips execution if task is already running; different tasks can run in parallel. After timeout abort, also waits for previous session to fully stop before allowing next execution. Only one scheduler instance per directory (to avoid duplicate/overlap execution). For tasks that need concurrency, set `"allowOverlap": true`—no longer waits for previous completion, starts new task on schedule (`every` interval calculated from last **start** time, cron follows wall clock, slow tasks won't delay subsequent triggers)
- **State file**: `.opencode/.scheduled-state.json` records each task's sessionId, last run time/status (`ok`/`error`/`timeout`/`aborted`/`skipped`)/count; delete file to reset all tasks
- **Hot reload**: Re-reads config file every 5 seconds tick, modifying `schedules.json` takes effect within 5 seconds
- **Logging**: Outputs structured logs via `client.app.log` as `scheduled-commands` service
- **Config isolation**: Single Job field error → skip that Job; entire file parse failure → don't load this time, report error again after 5 minutes; auto-recovers when fixed

## Important Notes

1. **Permissions**: Scheduled tasks drive agent execution via SDK; if project permission is `ask`, unattended operation may hang waiting for confirmation.建议给任务涉及的工具配置 `allow`
2. **Model costs**: Scheduled tasks consume real model tokens; set frequency reasonably
3. **Missing commands**: Execution returns error and records to state file, doesn't affect other tasks
4. **Plugin changes require restart**; config changes don't require restart

## Example Commands

Practical commands included in the repository:

- [examples/commands/push.md](examples/commands/push.md) — Push code and tags (with safe sync check)
- [examples/commands/bugfix.md](examples/commands/bugfix.md) — Pull latest source, find random bug, fix carefully, run integration tests, commit (for auto-fix bugs every 30 minutes scenario)

## Common Configuration Examples

```jsonc
{
  "jobs": [
    { "name": "Push every 30 minutes", "command": "push", "every": "30m" },
    { "name": "Start at 9 AM weekdays", "command": "start", "cron": "0 9 * * 1-5" },
    { "name": "Health check every minute", "command": "check", "cron": "* * * * *", "timeoutMs": 120000 }
  ]
}
```

## Testing

Uses Node.js built-in test runner (`node:test`, no dependency installation needed), runs TypeScript directly:

```bash
npm test
```

Coverage:

- **Pure functions**: `parseJsonc` (comments/trailing commas/comments-in-strings), `parseCron` (fields/step/range/dow 0 & 7), `nextCronTime` (including vixie day/dow OR semantics), `parseInterval`, `nextIntervalTime`, `errorMessage`
- **Scheduler** (`createScheduler` + mock SDK client): `every`/`cron` triggering, hot reload, interval catch-up, overlap prevention, `allowOverlap` concurrency, timeout abort (including "don't allow next execution until previous session stops"), state file persistence, config error isolation

## License

[MIT](LICENSE)