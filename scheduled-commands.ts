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
 *  - 防重叠执行（可按任务配置 `allowOverlap: true` 允许与上一次重叠）、
 *    可选超时 abort、错误隔离、结构化日志、可选 TUI 通知
 *
 * 配置在每次 tick（默认 5s）时热重载，修改 schedules.json 无需重启 opencode。
 */
import type { Hooks, Plugin, PluginInput, PluginModule } from "@opencode-ai/plugin"
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
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
  /** true 时允许与上一次执行重叠（上一次未完成也按计划启动新任务）；默认 false */
  allowOverlap?: boolean
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

  // 正在执行的任务（key -> 并发数）。allowOverlap 的任务可 >1，其余任务最多 1。
  const running = new Map<string, number>()
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
          void log("error", `Job #${i} in ${configPath}: "${field}" has an invalid value (${value === null ? "null" : typeof value}); job skipped`)
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
        if (j.allowOverlap !== undefined && typeof j.allowOverlap !== "boolean") {
          bad("allowOverlap", j.allowOverlap)
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
    if (job.allowOverlap) {
      // 允许重叠：把 lastRun 锚定到本次启动时刻，使间隔从启动起算、慢任务不拖住后续触发；
      // 完成时不回写 lastRun，避免并发的多次完成互相覆盖/回退。
      // 原子更新：读取-修改-写入之间可能有并发，但这是可接受的（lastRun 是近似值）
      const current = state.jobs[jobKeyName] ?? {}
      state.jobs[jobKeyName] = { ...current, lastRun: started }
      saveState()
    }
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
        const settled = command.then(async (res) => {
          if (res.error) return { kind: "done" as const, ok: false, message: errorMessage(res.error) }
          const info = res.data.info
          const err = info.error
          if (err) return { kind: "done" as const, ok: false, message: errorMessage(err) }
          return { kind: "done" as const, ok: true, message: `completed in ${Date.now() - started}ms (message ${info.id})` }
        })
        const timedOut = new Promise<{ kind: "timeout" }>((resolve) => {
          setTimeout(() => resolve({ kind: "timeout" }), job.timeoutMs)
        })
        const winner = await Promise.race([settled, timedOut])
        if (winner.kind === "timeout") {
          // 超时后 abort 是异步的：若在 abort 生效前就释放 running 锁，下一个 tick
          // 可能在上一个 session 仍在执行时启动新任务，造成重叠。这里先等 abort 完成、
          // 再等命令真正结束，之后才会释放锁（running.delete 在 runJob 返回后才执行）。
          if (sessionId) await abortSession(sessionId)
          result = { kind: "timeout" }
          await settled.catch(() => {})
        } else {
          result = winner
        }
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
      lastRun: job.allowOverlap ? (prev.lastRun ?? started) : now(),
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
      if (!job.allowOverlap && (running.get(key) ?? 0) > 0) continue // 防重叠（allowOverlap 时允许并发）
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
      // 允许重叠的任务：next > lastRun 时启动（同一触发点不重复）
      // 不允许重叠的任务：next <= now && next > lastRun && 不在运行中 时启动
      const lastRun = state.jobs[key]?.lastRun ?? 0
      const shouldRun = job.allowOverlap
        ? next !== null && next <= nowValue && next > lastRun
        : next !== null && next <= nowValue && next > lastRun
      if (shouldRun) {
        running.set(key, (running.get(key) ?? 0) + 1)
        void runJob(key, job, i).finally(() => {
          const count = (running.get(key) ?? 1) - 1
          if (count > 0) running.set(key, count)
          else running.delete(key)
        })
      }
    }
  }

  /** 调度器实例锁文件，防止同一目录多个调度器同时运行 */
  const lockFilePath = join(directory, ".opencode", ".scheduled-lock")

  /**
   * 尝试获取锁。
   * 使用 O_EXCL 标志创建文件实现原子性锁（进程级）。
   * 多调度器实例同时调用时，只有一个能成功创建锁文件。
   * 返回 "acquired" 表示拿到锁；"held" 表示锁已被其他实例持有；
   * 其他错误（如目录不可写）会向上抛出，由 start() 记录明确日志。
   */
  function tryAcquireLock(): "acquired" | "held" {
    try {
      // 确保 .opencode 目录存在：全新环境中该目录可能尚未创建，
      // 否则 openSync 会抛 ENOENT 且被误判为"锁被占用"，调度器静默不启动
      mkdirSync(join(directory, ".opencode"), { recursive: true })
      const fd = openSync(lockFilePath, "wx") // O_WRONLY | O_CREAT | O_EXCL
      // 写入当前进程 PID，便于诊断
      writeFileSync(fd, String(process.pid), "utf8")
      closeSync(fd)
      return "acquired"
    } catch (e) {
      if (e && typeof e === "object" && (e as { code?: string }).code === "EEXIST") {
        // 文件已存在（锁被其他实例持有）
        return "held"
      }
      throw e
    }
  }

  function releaseLock(): void {
    try {
      if (existsSync(lockFilePath)) {
        unlinkSync(lockFilePath)
      }
    } catch {
      // 释放锁失败，由下次调度器创建时覆盖
    }
  }

  return {
    start(): void {
      // 防止多调度器实例同时运行：只有一个能成功获取锁
      let lock: "acquired" | "held"
      try {
        lock = tryAcquireLock()
      } catch (e) {
        void log("error", `Failed to start scheduler for directory ${directory}: ${String(e)}`)
        return
      }
      if (lock === "held") {
        void log("error", `Scheduler already running for directory ${directory}, this instance will not start`)
        return
      }
      loadState()
      void log("info", `Scheduler started (tick ${tickMs}ms). Config: ${configPath}`)
      timer = setInterval(() => void tick(), tickMs)
      // 启动时立即检查一次，避免等待首个 tick
      void tick()
    },
    stop(): void {
      if (timer) clearInterval(timer)
      timer = undefined
      releaseLock()
    },
    /** 供测试与手动触发使用 */
    tickNow(): Promise<void> {
      return tick()
    },
    get runningJobs(): Set<string> {
      return new Set(running.keys())
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
 * 每个目录（插件实例）在用的调度器。
 *
 * opencode 可能对同一 directory 多次调用 `server`（例如插件实例失效后重建、
 * 实例切换等）。若每次都新建调度器，会有多个 timer 同时 tick、各自持有独立的
 * `running` 集合——它们互相看不到对方的进行中任务，导致同一任务被重复/重叠执行。
 * 这里登记每个目录的调度器：再次调用时先停掉旧实例，保证同一时刻每个目录
 * 只有一个活动的调度器。
 */
const schedulers = new Map<string, ReturnType<typeof createScheduler>>()

/**
 * server 插件导出（v1.18+ 新格式）：
 * 必须导出 `{ id, server }` 对象，不能直接导出插件函数——
 * 老式函数导出会被 opencode 加载器 `getLegacyPlugins` 遍历模块**所有**函数
 * 导出并当作插件调用（parseCron 等命名导出因此被误调用，抛
 * "cron.trim is not a function" 导致整个插件加载失败、调度器停摆）。
 */
export const server: Plugin = async (input: PluginInput) => {
  const { client, directory } = input ?? ({} as PluginInput)
  let scheduler: ReturnType<typeof createScheduler> | undefined
  try {
    const prev = schedulers.get(directory)
    if (prev) prev.stop()
    // 某些宿主（如 Desktop 应用未绑定项目目录时）可能不传 directory：
    // 此时 join(directory, ...) 会抛 "path must be of type string"，导致插件初始化失败。
    // 这里显式跳过并记录明确日志，避免静默失败，也不让空目录错误地启动调度器。
    if (typeof directory !== "string" || directory === "") {
      const summary = {
        hasClient: !!client,
        directoryType: typeof directory,
        directory: typeof directory === "string" ? directory : String(directory),
      }
      try {
        await client?.app?.log?.({
          body: {
            service: "scheduled-commands",
            level: "warn",
            message: `Plugin skipped: no project directory provided by host (${typeof directory}); scheduled jobs will not run until a directory is bound`,
            extra: summary,
          },
        })
      } catch {
        // 客户端不可用时静默
      }
      return {}
    }
    scheduler = createScheduler({ client, directory })
    schedulers.set(directory, scheduler)
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
      await client?.app?.log?.({
        body: { service: "scheduled-commands", level: "error", message: `Plugin init failed: ${String(e)}`, extra: summary },
      })
    } catch {
      // 客户端不可用时静默
    }
    throw e
  }
  // opencode 在实例销毁时调用 hooks.dispose：借此停掉调度器、移除登记，
  // 避免旧实例的 timer 残留。若本实例已被新实例取代（上面的 prev.stop()），
  // 这里不要误删新实例的登记。
  return {
    dispose: () => {
      if (scheduler && schedulers.get(directory) === scheduler) schedulers.delete(directory)
      scheduler?.stop()
    },
  } as Hooks
}

export default { id: "scheduled-commands", server } satisfies PluginModule
