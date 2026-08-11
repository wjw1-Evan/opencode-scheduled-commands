import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export interface CommandCall {
  sessionId: string
  command: string
  args: string
}

export interface MockResult {
  client: unknown
  createdSessions: string[]
  commandCalls: CommandCall[]
  aborted: string[]
  pending: Map<string, { resolve: (r: unknown) => void; reject: (e?: unknown) => void }>
  resolveCommand: (sessionId: string, opts?: { ok?: boolean; sdkError?: string; runError?: string }) => void
  rejectCommand: (sessionId: string, err?: unknown) => void
}

/**
 * 构造一个可控的 SDK client mock：
 *  - session.create 立即返回新 id
 *  - session.command 返回一个挂起的 promise（由测试通过 resolveCommand/rejectCommand 手动结束）
 *  - session.abort 立即成功并记录
 */
export function makeClient(opts?: { failCreate?: boolean }): MockResult {
  const createdSessions: string[] = []
  const commandCalls: CommandCall[] = []
  const aborted: string[] = []
  const pending = new Map<string, { resolve: (r: unknown) => void; reject: (e?: unknown) => void }>()
  let seq = 0

  const client = {
    session: {
      create: async () => {
        if (opts?.failCreate) return { error: { message: "create failed" } }
        seq += 1
        const id = `sess-${seq}`
        createdSessions.push(id)
        return { error: undefined, data: { id } }
      },
      command: (o: { path: { id: string }; body: { command: string; arguments?: string } }) => {
        const sessionId = o.path.id
        commandCalls.push({ sessionId, command: o.body.command, args: o.body.arguments ?? "" })
        return new Promise((resolve, reject) => {
          pending.set(sessionId, { resolve, reject })
        })
      },
      abort: async (o: { path: { id: string } }) => {
        aborted.push(o.path.id)
        return {}
      },
    },
    app: { log: async () => {} },
    tui: { showToast: async () => {} },
  }

  return {
    client,
    createdSessions,
    commandCalls,
    aborted,
    pending,
    resolveCommand(sessionId, opts) {
      const p = pending.get(sessionId)
      if (!p) throw new Error(`no pending command for session ${sessionId}`)
      pending.delete(sessionId)
      if (opts?.sdkError) {
        p.resolve({ error: { message: opts.sdkError } })
      } else if (opts?.runError) {
        p.resolve({ error: undefined, data: { info: { id: `msg-${sessionId}`, error: { message: opts.runError } } } })
      } else if (opts?.ok === false) {
        p.resolve({ error: undefined, data: { info: { id: `msg-${sessionId}`, error: new Error("command failed") } } })
      } else {
        p.resolve({ error: undefined, data: { info: { id: `msg-${sessionId}`, error: undefined } } })
      }
    },
    rejectCommand(sessionId, err) {
      const p = pending.get(sessionId)
      if (!p) throw new Error(`no pending command for session ${sessionId}`)
      pending.delete(sessionId)
      p.reject(err ?? new Error("command rejected"))
    },
  }
}

/** 在临时目录下创建含 .opencode 的项目目录 */
export function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "scheduled-commands-test-"))
  mkdirSync(join(dir, ".opencode"), { recursive: true })
  return dir
}

export function writeConfig(dir: string, jobs: unknown[]): void {
  writeFileSync(join(dir, ".opencode", "schedules.json"), JSON.stringify({ jobs }))
}

export function writeState(dir: string, jobs: Record<string, unknown>): void {
  writeFileSync(join(dir, ".opencode", ".scheduled-state.json"), JSON.stringify({ jobs }))
}

export function readState(dir: string): { jobs: Record<string, any> } {
  const file = join(dir, ".opencode", ".scheduled-state.json")
  const exists = (() => {
    try {
      readFileSync(file, "utf8")
      return true
    } catch {
      return false
    }
  })()
  if (!exists) return { jobs: {} }
  return JSON.parse(readFileSync(file, "utf8")) as { jobs: Record<string, any> }
}

export function cleanupDirs(dirs: string[]): void {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
