/**
 * scheduled-commands —— opencode 定时重复执行用户自定义命令插件
 *
 * 功能：
 *  - 读取 `.opencode/schedules.json`（JSONC 格式，支持注释与尾逗号）中的任务列表
 *  - 每个任务可配置 5 字段 cron 表达式或固定间隔（every），到期自动执行
 *  - 通过 SDK `session.command` 调用用户自定义命令（`.opencode/commands/*.md`），
 *    服务端自动展开命令模板与 `$ARGUMENTS`
 *  - 每次执行都会创建全新的 session（ID 记录到 `.opencode/.scheduled-state.json`），
 *    多次执行互不共享对话上下文；对话标题包含本次开始时间
 *  - 防重叠执行、可选超时 abort、错误隔离、结构化日志、可选 TUI 通知
 *
 * 配置在每次 tick（默认 5s）时热重载，修改 schedules.json 无需重启 opencode。
 */
import type { Plugin, PluginInput, PluginModule } from "@opencode-ai/plugin"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/* ============================== 类型定义 ============================== */

interface Job {
  /** 任务名（唯一标识，用于状态记录与日志） */
  name?: string
  /** 用户自定义命令名，对应 .opencode/commands/<command>.md */
  command: string
  /** 传给命令的参数（对应模板中的 $ARGUMENTS / $1 / $2 ...） */
  arguments?: string
  /** 覆盖命令 frontmatter 中指定的 agent（不填则用命令默认 agent） */
  agent?: string
  /** 覆盖执行模型（如 "opencode-go/deepseek-v4-pro"，不填用命令/会话默认模型） */
  model?: string
  /** 5 字段 cron：分 时 日 月 周（与 every 二选一，cron 优先） */
  cron?: string
  /** 固定间隔：如 "30s"、"5m"、"2h"、"1d"（与 cron 二选一） */
  every?: string
  /** false 时跳过该任务 */
  enabled?: boolean
  /** 执行完成后尝试发送 TUI toast 通知 */
  notify?: boolean
  /** 单次执行超时（毫秒），超时后 abort 会话并标记 timeout（0 = 不限制） */
  timeoutMs?: number
}

interface SchedulesFile {
  jobs?: Job[]
}

interface JobState {
  /** 最近一次执行创建的 session id（仅记录，不再复用） */
  sessionId?: string
  lastRun?: number
  lastStatus?: "ok" | "error" | "timeout" | "aborted" | "skipped"
  lastMessage?: string
  runs?: number
}

interface StateFile {
  jobs: Record<string, JobState>
}

type Logger = (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => Promise<void>

interface SchedulerDeps {
  client: PluginInput["client"]
  directory: string
  tickMs?: number
  log?: Logger
  /** 时钟注入（测试用），默认 Date.now */
  now?: () => number
}

/* ============================== JSONC 解析 ============================== */

/**
 * 解析 JSONC（去除 // 行注释与块注释、容忍尾逗号）。
 * 字符串内的 // 与 /* 不会被误判。
 */
export function parseJsonc(text: string): unknown {
  let out = ""
  let inString = false
  let i = 0
  while (i < text.length) {
    const c = text[i]!
    const next = text[i + 1]
    if (inString) {
      out += c
      if (c === "\\") {
        if (next !== undefined) out += next
        i += 2
        continue
      }
      if (c === '"') inString = false
      i++
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      i++
      continue
    }
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++
      continue
    }
    if (c === "/" && next === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++
      i += 2
      continue
    }
    out += c
    i++
  }
  return JSON.parse(out.replace(/,\s*([}\]])/g, "$1"))
}

/* ============================== Cron 解析 ============================== */

const CRON_FIELD_RANGES: Array<[number, number]> = [
  [0, 59], // 分
  [0, 23], // 时
  [1, 31], // 日
  [1, 12], // 月
  [0, 7], // 周（0 与 7 均为周日）
]

/** 解析单个 cron 字段，支持 * 、步进、a-b 范围、a,b,c 列表组合 */
function parseCronField(field: string, min: number, max: number, isDow: boolean): Set<number> {
  const set = new Set<number>()
  const add = (v: number) => {
    if (isDow && v === 7) set.add(0)
    else set.add(v)
  }
  for (const rawPart of field.split(",")) {
    const part = rawPart.trim()
    if (part === "") throw new Error(`Empty cron field segment in "${field}"`)
    if (part === "*") {
      for (let v = min; v <= max; v++) add(v)
      continue
    }
    let m = /^\*\/(\d+)$/.exec(part)
    if (m) {
      const step = Number(m[1])
      if (step <= 0) throw new Error(`Invalid cron step in "${part}"`)
      for (let v = min; v <= max; v += step) add(v)
      continue
    }
    m = /^(\d+)-(\d+)(?:\/(\d+))?$/.exec(part)
    if (m) {
      const a = Number(m[1])
      const b = Number(m[2])
      const step = m[3] ? Number(m[3]) : 1
      if (step <= 0) throw new Error(`Invalid cron step in "${part}"`)
      for (let v = a; v <= b; v += step) add(v)
      continue
    }
    const v = Number(part)
    if (!Number.isInteger(v) || v < min || v > max) {
      throw new Error(`Cron value "${part}" out of range [${min}, ${max}]`)
    }
    add(v)
  }
  return set
}

interface CronFields {
  min: Set<number>
  hour: Set<number>
  dom: Set<number>
  mon: Set<number>
  dow: Set<number>
}

/** 解析 5 字段 cron 表达式：分 时 日 月 周 */
export function parseCron(cron: string): CronFields {
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5) {
    throw new Error(`Invalid cron expression "${cron}": expected 5 fields (min hour dom month dow)`)
  }
  return {
    min: parseCronField(fields[0]!, ...CRON_FIELD_RANGES[0]!, false),
    hour: parseCronField(fields[1]!, ...CRON_FIELD_RANGES[1]!, false),
    dom: parseCronField(fields[2]!, ...CRON_FIELD_RANGES[2]!, false),
    mon: parseCronField(fields[3]!, ...CRON_FIELD_RANGES[3]!, false),
    dow: parseCronField(fields[4]!, ...CRON_FIELD_RANGES[4]!, true),
  }
}

/**
 * 计算 cron 表达式下一次触发时间。
 * 从 from 的当前整分钟开始枚举（含当前分钟）：调度器 tick 在整点后任意时刻
 * 调用本函数都能命中当前整点触发点，再由调用方用 lastRun 防止同一触发点重复执行。
 * 采用 vixie cron 语义：日与周字段都被限制时取 OR，否则取 AND。
 */
export function nextCronTime(cron: string, from: Date): Date | null {
  const { min, hour, dom, mon, dow } = parseCron(cron)
  const domRestricted = dom.size < 31
  const dowRestricted = dow.size < 7
  const dayMatches = (d: number, w: number) =>
    domRestricted && dowRestricted ? dom.has(d) || dow.has(w) : dom.has(d) && dow.has(w)

  const t = new Date(from)
  t.setSeconds(0, 0)
  t.setMilliseconds(0)
  const limit = t.getTime() + 366 * 4 * 24 * 60 * 60 * 1000 // 4 年上限（覆盖闰年周期）
  while (t.getTime() <= limit) {
    if (mon.has(t.getMonth() + 1) && dayMatches(t.getDate(), t.getDay()) && hour.has(t.getHours()) && min.has(t.getMinutes())) {
      return new Date(t)
    }
    t.setMinutes(t.getMinutes() + 1)
  }
  return null // 表达式不可能触发（如 2月30日）
}

/* ============================== 间隔解析 ============================== */

/** 解析间隔字符串："500ms"、"30s"、"5m"、"2h"、"1d"，默认单位为秒 */
export function parseInterval(interval: string): number {
  const m = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(interval.trim())
  if (!m) {
    throw new Error(`Invalid interval "${interval}": expected e.g. "30s", "5m", "2h", "1d"`)
  }
  const n = Number(m[1])
  const mult: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }
  return n * (mult[m[2] ?? "s"]!)
}

/**
 * 计算 interval 任务的下一次触发时间（ms epoch）。
 * 基于 lastRun 推进；opencode 关闭期间错过的触发只补一次（catch-up），不连补。
 */
export function nextIntervalTime(ms: number, lastRun: number | undefined, now: number): number {
  if (lastRun === undefined) return now
  return Math.max(now, lastRun + ms)
}

/* ============================== 工具函数 ============================== */

/**
 * 从 SDK 错误对象中提取可读消息。
 * SDK 生成的错误类型为 { name, data: { message } } 结构，无顶层 message。
 */
export function errorMessage(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { message?: unknown; data?: { message?: unknown }; name?: unknown }
    if (typeof e.message === "string") return e.message
    if (typeof e.data?.message === "string") return e.data.message
    if (typeof e.name === "string") return e.name
  }
  return String(err)
}

/* ============================== 调度器 ============================== */

const TICK_MS = 5_000
const CONFIG_ERROR_REPORT_INTERVAL_MS = 5 * 60_000

export function createScheduler(deps: SchedulerDeps) {
  const { client, directory, log = defaultLogger(client), now = Date.now } = deps
  const tickMs = deps.tickMs ?? TICK_MS
  const configPath = join(directory, ".opencode", "schedules.json")
  const statePath = join(directory, ".opencode", ".scheduled-state.json")

  const running = new Set<string>()
  let timer: ReturnType<typeof setInterval> | undefined
  let state: StateFile = { jobs: {} }
  let lastConfigErrorAt = 0

  function loadState(): void {
    try {
      if (existsSync(statePath)) {
        const parsed = JSON.parse(readFileSync(statePath, "utf8")) as StateFile
        state = { jobs: parsed.jobs ?? {} }
      }
    } catch (e) {
      void log("warn", "Failed to read state file, starting fresh", { error: String(e) })
      state = { jobs: {} }
    }
  }

  function saveState(): void {
    try {
      writeFileSync(statePath, JSON.stringify(state, null, 2))
    } catch (e) {
      void log("error", "Failed to write state file", { error: String(e) })
    }
  }

  function loadJobs(): Job[] {
    if (!existsSync(configPath)) return []
    try {
      const parsed = parseJsonc(readFileSync(configPath, "utf8")) as SchedulesFile
      if (!Array.isArray(parsed?.jobs)) return []
      const jobs: Job[] = []
      for (let i = 0; i < parsed.jobs.length; i++) {
        const j = parsed.jobs[i]
        if (!j || typeof j !== "object") continue
        const bad = (field: string, value: unknown) => {
          void log("error", `Job #${i} in ${configPath}: "${field}" must be a string, got ${value === null ? "null" : typeof value}; job skipped`)
        }
        if (typeof j.command !== "string" || j.command === "") {
          bad("command", j.command)
          continue
        }
        if (j.cron !== undefined && typeof j.cron !== "string") {
          bad("cron", j.cron)
          continue
        }
        if (j.every !== undefined && typeof j.every !== "string") {
          bad("every", j.every)
          continue
        }
        jobs.push(j as Job)
      }
      return jobs
    } catch (e) {
      const now = Date.now()
      if (now - lastConfigErrorAt > CONFIG_ERROR_REPORT_INTERVAL_MS) {
        lastConfigErrorAt = now
        void log("error", `Invalid ${configPath}: ${String(e)} (scheduler keeps running, will retry)`)
      }
      return []
    }
  }

  function jobKey(job: Job, index: number): string {
    return job.name ?? `${job.command}#${index}`
  }

  function formatTimestamp(ts: number): string {
    const d = new Date(ts)
    const pad = (n: number) => String(n).padStart(2, "0")
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  }

  function jobTitle(job: Job, index: number): string {
    return `[scheduled] ${formatTimestamp(now())} ${job.name ?? job.command}${job.name ? ` (${job.command})` : ""} #${index + 1}`
  }

  /** 每次执行都创建全新的 session（标题带开始时间），同一任务多次执行互不共享上下文 */
  async function ensureSession(jobKeyName: string, job: Job, index: number): Promise<string> {
    const res = await client.session.create({
      body: { title: jobTitle(job, index) },
      query: { directory },
    })
    if (res.error) throw new Error(`Failed to create session: ${errorMessage(res.error)}`)
    state.jobs[jobKeyName] = { ...state.jobs[jobKeyName], sessionId: res.data.id }
    saveState()
    return res.data.id
  }

  async function abortSession(sessionId: string): Promise<void> {
    try {
      await client.session.abort({ path: { id: sessionId } })
    } catch {
      // abort 失败无需上报
    }
  }

  async function runJob(jobKeyName: string, job: Job, index: number): Promise<void> {
    const started = now()
    let sessionId: string | undefined
    let result: { kind: "done"; ok: boolean; message: string } | { kind: "timeout" } = {
      kind: "done",
      ok: false,
      message: "unknown",
    }
    try {
      sessionId = await ensureSession(jobKeyName, job, index)
      const command = client.session.command({
        path: { id: sessionId },
        body: {
          command: job.command,
          arguments: job.arguments ?? "",
          ...(job.agent ? { agent: job.agent } : {}),
          ...(job.model ? { model: job.model } : {}),
        },
        ...(directory ? { query: { directory } } : {}),
      })
      if (job.timeoutMs && job.timeoutMs > 0) {
        result = await Promise.race([
          command.then(async (res) => {
            if (res.error) return { kind: "done" as const, ok: false, message: errorMessage(res.error) }
            const info = res.data.info
            const err = info.error
            if (err) return { kind: "done" as const, ok: false, message: errorMessage(err) }
            return { kind: "done" as const, ok: true, message: `completed in ${Date.now() - started}ms (message ${info.id})` }
          }),
          new Promise<{ kind: "timeout" }>((resolve) => {
            setTimeout(() => {
              if (sessionId) void abortSession(sessionId)
              resolve({ kind: "timeout" })
            }, job.timeoutMs)
          }),
        ])
      } else {
        const res = await command
        if (res.error) {
          result = { kind: "done", ok: false, message: errorMessage(res.error) }
        } else {
          const err = res.data.info.error
          result = err
            ? { kind: "done", ok: false, message: errorMessage(err) }
            : { kind: "done", ok: true, message: `completed in ${Date.now() - started}ms (message ${res.data.info.id})` }
        }
      }
    } catch (e) {
      result = { kind: "done", ok: false, message: String(e) }
    }

    const prev = state.jobs[jobKeyName] ?? {}
    const timedOut = result.kind === "timeout"
    const doneResult = result.kind === "done" ? result : null
    const ok = doneResult?.ok ?? false
    const message = doneResult?.message ?? `timed out after ${job.timeoutMs}ms`
    state.jobs[jobKeyName] = {
      ...prev,
      lastRun: now(),
      lastStatus: timedOut ? "timeout" : ok ? "ok" : "error",
      lastMessage: message,
      runs: (prev.runs ?? 0) + 1,
    }
    saveState()

    await log(
      timedOut ? "warn" : ok ? "info" : "error",
      timedOut
        ? `Job "${jobKeyName}" (${job.command}) timed out after ${job.timeoutMs}ms, session aborted`
        : `Job "${jobKeyName}" (${job.command}) ${ok ? "succeeded" : "failed"}: ${message}`,
      { job: jobKeyName, command: job.command, status: state.jobs[jobKeyName]?.lastStatus },
    )

    if (job.notify) {
      try {
        await client.tui.showToast({
          body: {
            message: `[scheduled] ${jobKeyName}: ${timedOut ? "timeout" : ok ? "ok" : "failed"}`,
            variant: ok ? "success" : "error",
          },
        })
      } catch {
        // 非 TUI 环境（web/headless）下 toast 不可用，静默忽略
      }
    }
  }

  function nextRunFor(job: Job, jobState: JobState | undefined, now: number): number | null {
    if (job.cron) {
      return nextCronTime(job.cron, new Date(now))?.getTime() ?? null
    }
    if (job.every) {
      return nextIntervalTime(parseInterval(job.every), jobState?.lastRun, now)
    }
    return null // 未配置调度方式
  }

  async function tick(): Promise<void> {
    const jobs = loadJobs()
    if (jobs.length === 0) return
    const nowValue = now()
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i]!
      if (job.enabled === false) continue
      const key = jobKey(job, i)
      if (running.has(key)) continue // 防重叠
      let next: number | null = null
      try {
        next = nextRunFor(job, state.jobs[key], nowValue)
      } catch (e) {
        const cur = state.jobs[key]
        if (cur?.lastStatus !== "error") {
          void log("error", `Invalid schedule for job "${key}": ${String(e)}`)
          state.jobs[key] = { ...cur, lastStatus: "error", lastMessage: String(e), lastRun: nowValue }
        }
        continue
      }
      if (next !== null && next <= nowValue && next > (state.jobs[key]?.lastRun ?? 0)) {
        running.add(key)
        void runJob(key, job, i).finally(() => running.delete(key))
      }
    }
  }

  return {
    start(): void {
      loadState()
      void log("info", `Scheduler started (tick ${tickMs}ms). Config: ${configPath}`)
      timer = setInterval(() => void tick(), tickMs)
      // 启动时立即检查一次，避免等待首个 tick
      void tick()
    },
    stop(): void {
      if (timer) clearInterval(timer)
      timer = undefined
    },
    /** 供测试与手动触发使用 */
    tickNow(): Promise<void> {
      return tick()
    },
    get runningJobs(): Set<string> {
      return running
    },
  }
}

function defaultLogger(client: PluginInput["client"]): Logger {
  return async (level, message, extra) => {
    try {
      await client.app.log({ body: { service: "scheduled-commands", level, message, extra } })
    } catch {
      // 日志失败不影响调度
    }
  }
}

/* ============================== 插件入口 ============================== */

/**
 * server 插件导出（v1.18+ 新格式）：
 * 必须导出 `{ id, server }` 对象，不能直接导出插件函数——
 * 老式函数导出会被 opencode 加载器 `getLegacyPlugins` 遍历模块**所有**函数
 * 导出并当作插件调用（parseCron 等命名导出因此被误调用，抛
 * "cron.trim is not a function" 导致整个插件加载失败、调度器停摆）。
 */
export const server: Plugin = async (input: PluginInput) => {
  const { client, directory } = input ?? ({} as PluginInput)
  try {
    const scheduler = createScheduler({ client, directory })
    scheduler.start()
  } catch (e) {
    // 诊断：opencode 加载插件早期可能传入不完整的 input，这里记录详情便于定位
    const summary = {
      hasClient: !!client,
      directoryType: typeof directory,
      directory: typeof directory === "string" ? directory : String(directory),
      error: String(e),
    }
    try {
      await client?.app.log?.({
        body: { service: "scheduled-commands", level: "error", message: `Plugin init failed: ${String(e)}`, extra: summary },
      })
    } catch {
      // 客户端不可用时静默
    }
    throw e
  }
  return {}
}

export default { id: "scheduled-commands", server } satisfies PluginModule
