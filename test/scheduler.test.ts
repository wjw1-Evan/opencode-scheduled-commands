import { test, afterEach, describe } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { createScheduler } from "../scheduled-commands.ts"
import { cleanupDirs, makeBareDir, makeClient, makeDir, readState, sleep, writeConfig, writeState } from "./helpers.ts"

const MIN = 60_000
const T0 = new Date(2026, 7, 11, 12, 0, 0).getTime() // 2026-08-11 12:00（本地时间）
const dirs: string[] = []

afterEach(() => cleanupDirs(dirs.splice(0)))

function makeScheduler(dir: string, client: unknown, now: () => number, logs: string[] = []) {
  return createScheduler({
    client: client as Parameters<typeof createScheduler>[0]["client"],
    directory: dir,
    log: async (_level, message) => {
      logs.push(message)
    },
    now,
  })
}

function makeJob(job: Record<string, unknown>) {
  return job
}

describe("createScheduler：调度触发", () => {
  test("every 任务在首个 tick 立即运行", async () => {
    const dir = makeDir()
    dirs.push(dir)
    writeConfig(dir, [makeJob({ name: "A", command: "cmd", every: "1m" })])
    const mock = makeClient()
    let now = T0
    const sched = makeScheduler(dir, mock.client, () => now)

    await sched.tickNow()
    await sleep(0)

    assert.equal(mock.commandCalls.length, 1)
    assert.equal(mock.commandCalls[0]!.command, "cmd")
    assert.equal(mock.createdSessions.length, 1)
  })

  test("cron 任务在触发边界运行", async () => {
    const dir = makeDir()
    dirs.push(dir)
    writeConfig(dir, [makeJob({ name: "A", command: "cmd", cron: "* * * * *" })])
    const mock = makeClient()
    let now = T0
    const sched = makeScheduler(dir, mock.client, () => now)

    await sched.tickNow()
    await sleep(0)
    assert.equal(mock.commandCalls.length, 1)

    mock.resolveCommand(mock.commandCalls[0]!.sessionId)
    await sleep(0)
    now = T0 + MIN
    await sched.tickNow()
    await sleep(0)
    assert.equal(mock.commandCalls.length, 2)
  })

  test("未配置调度方式的 job 不运行", async () => {
    const dir = makeDir()
    dirs.push(dir)
    writeConfig(dir, [makeJob({ name: "A", command: "cmd" })])
    const mock = makeClient()
    const sched = makeScheduler(dir, mock.client, () => T0)

    await sched.tickNow()
    await sleep(0)
    assert.equal(mock.commandCalls.length, 0)
  })

  test("enabled: false 的 job 跳过", async () => {
    const dir = makeDir()
    dirs.push(dir)
    writeConfig(dir, [makeJob({ name: "A", command: "cmd", every: "1m", enabled: false })])
    const mock = makeClient()
    const sched = makeScheduler(dir, mock.client, () => T0)

    await sched.tickNow()
    await sleep(0)
    assert.equal(mock.commandCalls.length, 0)
  })

  test("every 间隔错过后只补一次", async () => {
    const dir = makeDir()
    dirs.push(dir)
    writeConfig(dir, [makeJob({ name: "A", command: "cmd", every: "1m" })])
    // 上一次运行在很久之前 → 本次 tick 补一次，随后不再连续触发
    writeState(dir, { A: { lastRun: T0 - 10 * MIN } })
    const mock = makeClient()
    let now = T0
    const sched = makeScheduler(dir, mock.client, () => now)

    await sched.tickNow()
    await sleep(0)
    assert.equal(mock.commandCalls.length, 1)

    mock.resolveCommand(mock.commandCalls[0]!.sessionId)
    await sleep(0)
    await sched.tickNow()
    await sleep(0)
    assert.equal(mock.commandCalls.length, 1)
  })

  test("全新环境：.opencode 目录不存在时 start() 仍能启动调度器", async () => {
    const dir = makeBareDir()
    dirs.push(dir)
    const logs: string[] = []
    const mock = makeClient()
    let now = T0
    const sched = makeScheduler(dir, mock.client, () => now, logs)

    sched.start()
    assert.ok(existsSync(join(dir, ".opencode")), ".opencode 目录应被自动创建")
    assert.ok(existsSync(join(dir, ".opencode", ".scheduled-lock")), "锁文件应已创建")

    // 启动后写入配置并 tick，任务应能正常运行
    writeConfig(dir, [makeJob({ name: "A", command: "cmd", every: "1m" })])
    await sched.tickNow()
    await sleep(0)
    assert.equal(mock.commandCalls.length, 1)
    assert.ok(!logs.some((m) => m.includes("Failed to start")), "不应有启动失败日志")

    sched.stop()
  })

  test("配置热重载：修改 schedules.json 后按新配置运行", async () => {
    const dir = makeDir()
    dirs.push(dir)
    writeConfig(dir, [makeJob({ name: "A", command: "cmd-a", every: "1m" })])
    const mock = makeClient()
    let now = T0
    const sched = makeScheduler(dir, mock.client, () => now)

    await sched.tickNow()
    await sleep(0)
    assert.deepEqual(mock.commandCalls.map((c) => c.command), ["cmd-a"])
    mock.resolveCommand(mock.commandCalls[0]!.sessionId)
    await sleep(0)

    writeConfig(dir, [makeJob({ name: "B", command: "cmd-b", every: "1m" })])
    now = T0 + MIN
    await sched.tickNow()
    await sleep(0)
    assert.deepEqual(mock.commandCalls.map((c) => c.command), ["cmd-a", "cmd-b"])
  })
})

describe("createScheduler：防重叠与 allowOverlap", () => {
  test("默认防重叠：上一次未完成时到点也跳过", async () => {
    const dir = makeDir()
    dirs.push(dir)
    writeConfig(dir, [makeJob({ name: "A", command: "cmd", every: "1m" })])
    const mock = makeClient()
    let now = T0
    const sched = makeScheduler(dir, mock.client, () => now)

    await sched.tickNow()
    await sleep(0)
    assert.equal(mock.commandCalls.length, 1)

    for (let i = 1; i <= 3; i++) {
      now = T0 + i * MIN
      await sched.tickNow()
      await sleep(0)
    }
    assert.equal(mock.commandCalls.length, 1, "上一次未完成时不应启动新任务")
    assert.equal(sched.runningJobs.has("A"), true)
  })

  test("allowOverlap: true：间隔从启动时刻起算，允许并发", async () => {
    const dir = makeDir()
    dirs.push(dir)
    writeConfig(dir, [makeJob({ name: "A", command: "cmd", every: "1m", allowOverlap: true })])
    const mock = makeClient()
    let now = T0
    const sched = makeScheduler(dir, mock.client, () => now)

    await sched.tickNow()
    await sleep(0)
    assert.equal(mock.commandCalls.length, 1)

    now = T0 + MIN
    await sched.tickNow()
    await sleep(0)
    assert.equal(mock.commandCalls.length, 2, "上一次未完成也应启动新任务")

    now = T0 + 2 * MIN
    await sched.tickNow()
    await sleep(0)
    assert.equal(mock.commandCalls.length, 3)
    assert.equal(sched.runningJobs.has("A"), true)

    // lastRun 锚定到最近一次启动时刻（不会被完成的并发任务回退）
    const st = readState(dir).jobs["A"]
    assert.equal(st.lastRun, T0 + 2 * MIN)
  })

  test("allowOverlap 任务完成后不回写 lastRun，避免并发完成互相覆盖", async () => {
    const dir = makeDir()
    dirs.push(dir)
    writeConfig(dir, [makeJob({ name: "A", command: "cmd", every: "1m", allowOverlap: true })])
    const mock = makeClient()
    let now = T0
    const sched = makeScheduler(dir, mock.client, () => now)

    await sched.tickNow()
    await sleep(0)
    const run1 = mock.commandCalls[0]!.sessionId

    now = T0 + MIN
    await sched.tickNow()
    await sleep(0)
    now = T0 + 2 * MIN
    await sched.tickNow()
    await sleep(0)
    assert.equal(mock.commandCalls.length, 3)

    // 最早启动的 run1 最后才完成，不应把 lastRun 回退到它的启动时刻
    mock.resolveCommand(run1)
    await sleep(0)
    const st = readState(dir).jobs["A"]
    assert.equal(st.lastRun, T0 + 2 * MIN)
    assert.equal(st.runs, 1)
  })

  test("allowOverlap: true + cron：每个触发点都启动", async () => {
    const dir = makeDir()
    dirs.push(dir)
    writeConfig(dir, [makeJob({ name: "A", command: "cmd", cron: "* * * * *", allowOverlap: true })])
    const mock = makeClient()
    let now = T0
    const sched = makeScheduler(dir, mock.client, () => now)

    await sched.tickNow()
    await sleep(0)
    now = T0 + MIN
    await sched.tickNow()
    await sleep(0)
    now = T0 + 2 * MIN
    await sched.tickNow()
    await sleep(0)

    assert.equal(mock.commandCalls.length, 3)
    assert.equal(readState(dir).jobs["A"].lastRun, T0 + 2 * MIN)
  })
})

describe("createScheduler：超时", () => {
  test("超时触发 abort，且在上一个会话真正停止前不放行下一次", async () => {
    const dir = makeDir()
    dirs.push(dir)
    writeConfig(dir, [makeJob({ name: "A", command: "cmd", cron: "* * * * *", timeoutMs: 60 })])
    const mock = makeClient()
    let now = T0
    const sched = makeScheduler(dir, mock.client, () => now)

    await sched.tickNow()
    await sleep(0)
    const run1 = mock.commandCalls[0]!.sessionId
    assert.equal(mock.commandCalls.length, 1)

    // 等真实计时器触发超时（timeoutMs=60ms）
    await sleep(120)
    assert.equal(mock.aborted.includes(run1), true, "超时应 abort 会话")

    // 超时后 abort 未生效（命令仍未结束）时，下一个 tick 不应启动新任务
    now = T0 + MIN
    await sched.tickNow()
    await sleep(0)
    assert.equal(mock.commandCalls.length, 1, "上一会话仍活跃时不应启动新任务")

    // 命令真正结束 → 记录 timeout 状态并放行
    mock.resolveCommand(run1)
    await sleep(0)
    const st = readState(dir).jobs["A"]
    assert.equal(st.lastStatus, "timeout")
    assert.equal(st.runs, 1)

    // 下一个触发点正常启动
    now = T0 + 2 * MIN
    await sched.tickNow()
    await sleep(0)
    assert.equal(mock.commandCalls.length, 2)
  })

  test("正常完成的命令不受超时影响", async () => {
    const dir = makeDir()
    dirs.push(dir)
    writeConfig(dir, [makeJob({ name: "A", command: "cmd", every: "1m", timeoutMs: 5000 })])
    const mock = makeClient()
    const sched = makeScheduler(dir, mock.client, () => T0)

    await sched.tickNow()
    await sleep(0)
    mock.resolveCommand(mock.commandCalls[0]!.sessionId)
    await sleep(0)

    const st = readState(dir).jobs["A"]
    assert.equal(st.lastStatus, "ok")
    assert.equal(mock.aborted.length, 0)
  })
})

describe("createScheduler：状态与错误隔离", () => {
  test("运行成功后写入状态文件", async () => {
    const dir = makeDir()
    dirs.push(dir)
    writeConfig(dir, [makeJob({ name: "A", command: "cmd", every: "1m" })])
    const mock = makeClient()
    const sched = makeScheduler(dir, mock.client, () => T0)

    await sched.tickNow()
    await sleep(0)
    const sessionId = mock.commandCalls[0]!.sessionId
    mock.resolveCommand(sessionId)
    await sleep(0)

    const st = readState(dir).jobs["A"]
    assert.equal(st.lastStatus, "ok")
    assert.equal(st.runs, 1)
    assert.equal(typeof st.lastRun, "number")
    assert.equal(st.sessionId, sessionId)
  })

  test("命令报错时记录 error 状态", async () => {
    const dir = makeDir()
    dirs.push(dir)
    writeConfig(dir, [makeJob({ name: "A", command: "cmd", every: "1m" })])
    const mock = makeClient()
    const sched = makeScheduler(dir, mock.client, () => T0)

    await sched.tickNow()
    await sleep(0)
    mock.resolveCommand(mock.commandCalls[0]!.sessionId, { runError: "boom" })
    await sleep(0)

    const st = readState(dir).jobs["A"]
    assert.equal(st.lastStatus, "error")
    assert.match(st.lastMessage, /boom/)
  })

  test("session 创建失败不影响其他任务（错误隔离）", async () => {
    const dir = makeDir()
    dirs.push(dir)
    writeConfig(dir, [
      makeJob({ name: "A", command: "cmd-a", every: "1m" }),
      makeJob({ name: "B", command: "cmd-b", every: "1m" }),
    ])
    const mock = makeClient({ failCreate: true })
    const sched = makeScheduler(dir, mock.client, () => T0)

    await sched.tickNow()
    await sleep(0)

    assert.equal(mock.commandCalls.length, 0)
    assert.equal(readState(dir).jobs["A"].lastStatus, "error")
    assert.equal(readState(dir).jobs["B"].lastStatus, "error")
  })

  test("非法 cron 只影响该任务，并记录 error 状态", async () => {
    const dir = makeDir()
    dirs.push(dir)
    writeConfig(dir, [
      makeJob({ name: "A", command: "cmd-a", cron: "not a cron" }),
      makeJob({ name: "B", command: "cmd-b", every: "1m" }),
    ])
    const mock = makeClient()
    const logs: string[] = []
    const sched = makeScheduler(dir, mock.client, () => T0, logs)

    await sched.tickNow()
    await sleep(0)

    assert.deepEqual(mock.commandCalls.map((c) => c.command), ["cmd-b"], "只有合法的 B 运行")
    assert.equal(readState(dir).jobs["A"].lastStatus, "error")
    assert.ok(logs.some((l) => l.includes("Invalid schedule")))
  })

  test("非法 allowOverlap 字段导致该任务被跳过", async () => {
    const dir = makeDir()
    dirs.push(dir)
    writeConfig(dir, [makeJob({ name: "A", command: "cmd", every: "1m", allowOverlap: "yes" })])
    const mock = makeClient()
    const logs: string[] = []
    const sched = makeScheduler(dir, mock.client, () => T0, logs)

    await sched.tickNow()
    await sleep(0)

    assert.equal(mock.commandCalls.length, 0)
    assert.ok(logs.some((l) => l.includes("allowOverlap")))
  })

  test("runningJobs 反映正在执行的任务", async () => {
    const dir = makeDir()
    dirs.push(dir)
    writeConfig(dir, [
      makeJob({ name: "A", command: "cmd", every: "1m" }),
      makeJob({ name: "B", command: "cmd", every: "1m" }),
    ])
    const mock = makeClient()
    const sched = makeScheduler(dir, mock.client, () => T0)

    await sched.tickNow()
    await sleep(0)
    assert.deepEqual([...sched.runningJobs].sort(), ["A", "B"])

    mock.resolveCommand(mock.commandCalls[0]!.sessionId)
    await sleep(0)
    assert.deepEqual([...sched.runningJobs], ["B"])
  })
})
