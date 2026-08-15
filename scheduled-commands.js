// .debug/scheduled-commands/scheduled-commands.ts
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
function parseJsonc(text) {
  let out = "";
  let inString = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === "\\") {
        if (next !== void 0) out += next;
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return JSON.parse(out.replace(/,\s*([}\]])/g, "$1"));
}
var CRON_FIELD_RANGES = [
  [0, 59],
  // 分
  [0, 23],
  // 时
  [1, 31],
  // 日
  [1, 12],
  // 月
  [0, 7]
  // 周（0 与 7 均为周日）
];
function parseCronField(field, min, max, isDow) {
  const set = /* @__PURE__ */ new Set();
  const add = (v) => {
    if (isDow && v === 7) set.add(0);
    else set.add(v);
  };
  for (const rawPart of field.split(",")) {
    const part = rawPart.trim();
    if (part === "") throw new Error(`Empty cron field segment in "${field}"`);
    if (part === "*") {
      for (let v2 = min; v2 <= max; v2++) add(v2);
      continue;
    }
    let m = /^\*\/(\d+)$/.exec(part);
    if (m) {
      const step = Number(m[1]);
      if (step <= 0) throw new Error(`Invalid cron step in "${part}"`);
      for (let v2 = min; v2 <= max; v2 += step) add(v2);
      continue;
    }
    m = /^(\d+)-(\d+)(?:\/(\d+))?$/.exec(part);
    if (m) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      const step = m[3] ? Number(m[3]) : 1;
      if (step <= 0) throw new Error(`Invalid cron step in "${part}"`);
      for (let v2 = a; v2 <= b; v2 += step) add(v2);
      continue;
    }
    const v = Number(part);
    if (!Number.isInteger(v) || v < min || v > max) {
      throw new Error(`Cron value "${part}" out of range [${min}, ${max}]`);
    }
    add(v);
  }
  return set;
}
function parseCron(cron) {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Invalid cron expression "${cron}": expected 5 fields (min hour dom month dow)`);
  }
  return {
    min: parseCronField(fields[0], ...CRON_FIELD_RANGES[0], false),
    hour: parseCronField(fields[1], ...CRON_FIELD_RANGES[1], false),
    dom: parseCronField(fields[2], ...CRON_FIELD_RANGES[2], false),
    mon: parseCronField(fields[3], ...CRON_FIELD_RANGES[3], false),
    dow: parseCronField(fields[4], ...CRON_FIELD_RANGES[4], true)
  };
}
function nextCronTime(cron, from) {
  const { min, hour, dom, mon, dow } = parseCron(cron);
  const domRestricted = dom.size < 31;
  const dowRestricted = dow.size < 7;
  const dayMatches = (d, w) => domRestricted && dowRestricted ? dom.has(d) || dow.has(w) : dom.has(d) && dow.has(w);
  const t = new Date(from);
  t.setSeconds(0, 0);
  t.setMilliseconds(0);
  const limit = t.getTime() + 366 * 4 * 24 * 60 * 60 * 1e3;
  while (t.getTime() <= limit) {
    if (mon.has(t.getMonth() + 1) && dayMatches(t.getDate(), t.getDay()) && hour.has(t.getHours()) && min.has(t.getMinutes())) {
      return new Date(t);
    }
    t.setMinutes(t.getMinutes() + 1);
  }
  return null;
}
function parseInterval(interval) {
  const m = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(interval.trim());
  if (!m) {
    throw new Error(`Invalid interval "${interval}": expected e.g. "30s", "5m", "2h", "1d"`);
  }
  const n = Number(m[1]);
  const mult = { ms: 1, s: 1e3, m: 6e4, h: 36e5, d: 864e5 };
  return n * mult[m[2] ?? "s"];
}
function nextIntervalTime(ms, lastRun, now) {
  if (lastRun === void 0) return now;
  return Math.max(now, lastRun + ms);
}
function errorMessage(err) {
  if (err && typeof err === "object") {
    const e = err;
    if (typeof e.message === "string") return e.message;
    if (typeof e.data?.message === "string") return e.data.message;
    if (typeof e.name === "string") return e.name;
  }
  return String(err);
}
var TICK_MS = 5e3;
var CONFIG_ERROR_REPORT_INTERVAL_MS = 5 * 6e4;
var DEBUG_ENV = /^(1|true|yes|on)$/i.test(process.env.SCHEDULED_COMMANDS_DEBUG ?? "");
function createScheduler(deps) {
  const { client, directory, log = defaultLogger(client), now = Date.now } = deps;
  const debug = deps.debug ?? DEBUG_ENV;
  const tickMs = deps.tickMs ?? TICK_MS;
  const configPath = join(directory, ".opencode", "schedules.json");
  const statePath = join(directory, ".opencode", ".scheduled-state.json");
  async function debugLog(message, extra) {
    if (!debug) return;
    await log("debug", message, extra);
  }
  const running = /* @__PURE__ */ new Map();
  let timer;
  let state = { jobs: {} };
  let lastConfigErrorAt = 0;
  function loadState() {
    try {
      if (existsSync(statePath)) {
        const parsed = JSON.parse(readFileSync(statePath, "utf8"));
        state = { jobs: parsed.jobs ?? {} };
      }
    } catch (e) {
      void log("warn", `Failed to read state file ${statePath}, starting fresh`, { error: String(e) });
      state = { jobs: {} };
    }
  }
  function saveState() {
    try {
      writeFileSync(statePath, JSON.stringify(state, null, 2));
    } catch (e) {
      void log("error", "Failed to write state file", { error: String(e) });
    }
  }
  function loadJobs() {
    if (!existsSync(configPath)) return [];
    try {
      const parsed = parseJsonc(readFileSync(configPath, "utf8"));
      if (!Array.isArray(parsed?.jobs)) return [];
      const jobs = [];
      for (let i = 0; i < parsed.jobs.length; i++) {
        const j = parsed.jobs[i];
        if (!j || typeof j !== "object") continue;
        const bad = (field, value) => {
          void log("error", `Job #${i} in ${configPath}: "${field}" has an invalid value (${value === null ? "null" : typeof value}); job skipped`);
        };
        if (typeof j.command !== "string" || j.command === "") {
          bad("command", j.command);
          continue;
        }
        if (j.cron !== void 0 && typeof j.cron !== "string") {
          bad("cron", j.cron);
          continue;
        }
        if (j.every !== void 0 && typeof j.every !== "string") {
          bad("every", j.every);
          continue;
        }
        if (j.allowOverlap !== void 0 && typeof j.allowOverlap !== "boolean") {
          bad("allowOverlap", j.allowOverlap);
          continue;
        }
        jobs.push(j);
      }
      return jobs;
    } catch (e) {
      const now2 = Date.now();
      if (now2 - lastConfigErrorAt > CONFIG_ERROR_REPORT_INTERVAL_MS) {
        lastConfigErrorAt = now2;
        void log("error", `Invalid ${configPath}: ${String(e)} (scheduler keeps running, will retry)`);
      }
      return [];
    }
  }
  function jobKey(job, index) {
    return job.name ?? `${job.command}#${index}`;
  }
  function formatTimestamp(ts) {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  function jobTitle(job, index) {
    return `[scheduled] ${formatTimestamp(now())} ${job.name ?? job.command}${job.name ? ` (${job.command})` : ""} #${index + 1}`;
  }
  async function ensureSession(jobKeyName, job, index) {
    const res = await client.session.create({
      body: { title: jobTitle(job, index) },
      query: { directory }
    });
    if (res.error) throw new Error(`Failed to create session: ${errorMessage(res.error)}`);
    state.jobs[jobKeyName] = { ...state.jobs[jobKeyName], sessionId: res.data.id };
    saveState();
    void debugLog("Session created", { job: jobKeyName, sessionId: res.data.id, title: jobTitle(job, index) });
    return res.data.id;
  }
  async function abortSession(sessionId) {
    try {
      await client.session.abort({ path: { id: sessionId } });
      void debugLog("Session aborted (timeout)", { sessionId });
    } catch {
    }
  }
  async function runJob(jobKeyName, job, index) {
    const started = now();
    void debugLog("Job run starting", { job: jobKeyName, command: job.command, allowOverlap: job.allowOverlap, timeoutMs: job.timeoutMs ?? 0 });
    if (job.allowOverlap) {
      const current = state.jobs[jobKeyName] ?? {};
      state.jobs[jobKeyName] = { ...current, lastRun: started };
      saveState();
    }
    let sessionId;
    let result = {
      kind: "done",
      ok: false,
      message: "unknown"
    };
    try {
      sessionId = await ensureSession(jobKeyName, job, index);
      const command = client.session.command({
        path: { id: sessionId },
        body: {
          command: job.command,
          arguments: job.arguments ?? "",
          ...job.agent ? { agent: job.agent } : {},
          ...job.model ? { model: job.model } : {}
        },
        ...directory ? { query: { directory } } : {}
      });
      if (job.timeoutMs && job.timeoutMs > 0) {
        const settled = command.then(async (res) => {
          if (res.error) return { kind: "done", ok: false, message: errorMessage(res.error) };
          const info = res.data.info;
          const err = info.error;
          if (err) return { kind: "done", ok: false, message: errorMessage(err) };
          return { kind: "done", ok: true, message: `completed in ${Date.now() - started}ms (message ${info.id})` };
        });
        const timedOut2 = new Promise((resolve) => {
          setTimeout(() => resolve({ kind: "timeout" }), job.timeoutMs);
        });
        const winner = await Promise.race([settled, timedOut2]);
        if (winner.kind === "timeout") {
          if (sessionId) await abortSession(sessionId);
          result = { kind: "timeout" };
          await settled.catch(() => {
          });
        } else {
          result = winner;
        }
      } else {
        const res = await command;
        if (res.error) {
          result = { kind: "done", ok: false, message: errorMessage(res.error) };
        } else {
          const err = res.data.info.error;
          result = err ? { kind: "done", ok: false, message: errorMessage(err) } : { kind: "done", ok: true, message: `completed in ${Date.now() - started}ms (message ${res.data.info.id})` };
        }
      }
    } catch (e) {
      result = { kind: "done", ok: false, message: String(e) };
    }
    const prev = state.jobs[jobKeyName] ?? {};
    const timedOut = result.kind === "timeout";
    const doneResult = result.kind === "done" ? result : null;
    const ok = doneResult?.ok ?? false;
    const message = doneResult?.message ?? `timed out after ${job.timeoutMs}ms`;
    state.jobs[jobKeyName] = {
      ...prev,
      lastRun: job.allowOverlap ? prev.lastRun ?? started : now(),
      lastStatus: timedOut ? "timeout" : ok ? "ok" : "error",
      lastMessage: message,
      runs: (prev.runs ?? 0) + 1
    };
    saveState();
    await log(
      timedOut ? "warn" : ok ? "info" : "error",
      timedOut ? `Job "${jobKeyName}" (${job.command}) timed out after ${job.timeoutMs}ms, session aborted` : `Job "${jobKeyName}" (${job.command}) ${ok ? "succeeded" : "failed"}: ${message}`,
      { job: jobKeyName, command: job.command, status: state.jobs[jobKeyName]?.lastStatus }
    );
    if (job.notify) {
      try {
        await client.tui.showToast({
          body: {
            message: `[scheduled] ${jobKeyName}: ${timedOut ? "timeout" : ok ? "ok" : "failed"}`,
            variant: ok ? "success" : "error"
          }
        });
      } catch {
      }
    }
  }
  function nextRunFor(job, jobState, now2) {
    if (job.cron) {
      return nextCronTime(job.cron, new Date(now2))?.getTime() ?? null;
    }
    if (job.every) {
      return nextIntervalTime(parseInterval(job.every), jobState?.lastRun, now2);
    }
    return null;
  }
  async function safeTick() {
    try {
      await tick();
    } catch (e) {
      void log("error", `Scheduler tick crashed unexpectedly: ${String(e)} (will retry on next tick)`);
    }
  }
  async function tick() {
    const nowValue = now();
    const jobs = loadJobs();
    if (jobs.length === 0) {
      if (!existsSync(configPath)) {
        void debugLog("Tick: no schedules.json found yet \u2014 create .opencode/schedules.json to enable jobs", {
          directory,
          configPath
        });
      }
      return;
    }
    void debugLog("Tick", {
      at: formatTimestamp(nowValue),
      jobCount: jobs.length,
      running: [...running.entries()].map(([k, c]) => `${k}(${c})`)
    });
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      const key = jobKey(job, i);
      if (job.enabled === false) {
        void debugLog(`Job "${key}" skipped: enabled=false`);
        continue;
      }
      if (!job.allowOverlap && (running.get(key) ?? 0) > 0) {
        void debugLog(`Job "${key}" skipped: still running (overlap not allowed)`);
        continue;
      }
      let next = null;
      try {
        next = nextRunFor(job, state.jobs[key], nowValue);
      } catch (e) {
        const cur = state.jobs[key];
        if (cur?.lastStatus !== "error") {
          void log("error", `Invalid schedule for job "${key}": ${String(e)}`);
          state.jobs[key] = { ...cur, lastStatus: "error", lastMessage: String(e), lastRun: nowValue };
        }
        continue;
      }
      const lastRun = state.jobs[key]?.lastRun ?? 0;
      const shouldRun = next !== null && next <= nowValue && next > lastRun;
      if (!shouldRun) {
        void debugLog(`Job "${key}" not due`, {
          nextRun: next === null ? null : formatTimestamp(next),
          now: formatTimestamp(nowValue),
          lastRun: lastRun === 0 ? "never" : formatTimestamp(lastRun),
          reason: next === null ? "no schedule configured" : next > nowValue ? "not due yet" : `already ran at this trigger point (lastRun=${lastRun})`
        });
        continue;
      }
      void debugLog(`Job "${key}" starting`, { command: job.command, at: formatTimestamp(next ?? nowValue) });
      running.set(key, (running.get(key) ?? 0) + 1);
      void runJob(key, job, i).catch((e) => {
        void log("error", `Job "${key}" crashed unexpectedly: ${String(e)}`);
      }).finally(() => {
        const count = (running.get(key) ?? 1) - 1;
        if (count > 0) running.set(key, count);
        else running.delete(key);
      });
    }
  }
  const lockFilePath = join(directory, ".opencode", ".scheduled-lock");
  function staleLockReason() {
    let pidText = "";
    try {
      pidText = readFileSync(lockFilePath, "utf8").trim();
    } catch {
      return `could not read PID from lock file (${lockFilePath})`;
    }
    const pid = Number(pidText);
    if (!Number.isInteger(pid) || pid <= 0) {
      return `lock file contains an invalid PID "${pidText || "(empty)"}" (${lockFilePath})`;
    }
    try {
      process.kill(pid, 0);
      return null;
    } catch (e) {
      const code = e.code;
      return code === "ESRCH" ? `lock owner PID ${pid} is no longer alive (crash or killed process)` : null;
    }
  }
  function acquireLock() {
    mkdirSync(join(directory, ".opencode"), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(lockFilePath, "wx");
        writeFileSync(fd, String(process.pid), "utf8");
        closeSync(fd);
        if (attempt > 0) {
          void log("warn", `Recovered stale scheduler lock (${lockFilePath}); previous instance died without cleanup`);
        }
        void debugLog("Scheduler lock acquired", { lockFilePath, pid: process.pid });
        return "acquired";
      } catch (e) {
        const code = e && typeof e === "object" ? e.code : void 0;
        if (code !== "EEXIST") throw e;
        const stale = staleLockReason();
        if (stale) {
          void log("warn", `Found stale scheduler lock: ${stale}; removing and retrying once`);
          try {
            unlinkSync(lockFilePath);
          } catch {
          }
          continue;
        }
        return "held";
      }
    }
    return "held";
  }
  function releaseLock() {
    try {
      if (existsSync(lockFilePath)) {
        unlinkSync(lockFilePath);
      }
    } catch {
    }
  }
  return {
    start() {
      let lock;
      try {
        lock = acquireLock();
      } catch (e) {
        void log("error", `Failed to start scheduler for directory ${directory}: ${String(e)} (scheduler needs write access to ${lockFilePath}; check directory permissions)`, {
          error: String(e),
          lockFilePath,
          directory,
          platform: process.platform,
          node: process.version
        });
        return;
      }
      if (lock === "held") {
        let owner = "unknown";
        try {
          owner = readFileSync(lockFilePath, "utf8").trim() || "unknown";
        } catch {
        }
        void log("error", `Scheduler already running for directory ${directory}: lock file ${lockFilePath} is held by PID ${owner}. This instance will not start. If that process is no longer alive (crash/restart), the lock will be auto-recovered on the next start; otherwise delete the lock file and restart opencode.`);
        return;
      }
      loadState();
      void debugLog("Scheduler starting", { directory, configPath, statePath, tickMs, debug });
      void log("info", `Scheduler started (tick ${tickMs}ms). Config: ${configPath}`);
      timer = setInterval(() => void safeTick(), tickMs);
      void safeTick();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = void 0;
      releaseLock();
    },
    /** 供测试与手动触发使用 */
    tickNow() {
      return tick();
    },
    get runningJobs() {
      return new Set(running.keys());
    }
  };
}
function defaultLogger(client) {
  return async (level, message, extra) => {
    const line = `[scheduled-commands:${level}] ${message}${extra ? ` ${JSON.stringify(extra)}` : ""}`;
    if (level === "error" || level === "warn") console.error(line);
    try {
      await client.app.log({ body: { service: "scheduled-commands", level, message, extra } });
    } catch {
    }
  };
}
var schedulers = /* @__PURE__ */ new Map();
var server = async (input) => {
  const { client, directory } = input ?? {};
  let scheduler;
  try {
    const prev = schedulers.get(directory);
    if (prev) prev.stop();
    if (typeof directory !== "string" || directory === "") {
      const summary = {
        hasClient: !!client,
        directoryType: typeof directory,
        directory: typeof directory === "string" ? directory : String(directory)
      };
      console.warn(`[scheduled-commands] Plugin skipped: no project directory provided by host (${typeof directory}); scheduled jobs will not run until a directory is bound`);
      try {
        await client?.app?.log?.({
          body: {
            service: "scheduled-commands",
            level: "warn",
            message: `Plugin skipped: no project directory provided by host (${typeof directory}); scheduled jobs will not run until a directory is bound`,
            extra: summary
          }
        });
      } catch {
      }
      return {};
    }
    scheduler = createScheduler({ client, directory });
    schedulers.set(directory, scheduler);
    scheduler.start();
  } catch (e) {
    const summary = {
      hasClient: !!client,
      directoryType: typeof directory,
      directory: typeof directory === "string" ? directory : String(directory),
      error: String(e)
    };
    console.error(`[scheduled-commands] Plugin init failed: ${String(e)}`);
    try {
      await client?.app?.log?.({
        body: { service: "scheduled-commands", level: "error", message: `Plugin init failed: ${String(e)}`, extra: summary }
      });
    } catch {
    }
    throw e;
  }
  return {
    dispose: () => {
      if (scheduler && schedulers.get(directory) === scheduler) schedulers.delete(directory);
      scheduler?.stop();
    }
  };
};
var scheduled_commands_default = { id: "scheduled-commands", server };
export {
  createScheduler,
  scheduled_commands_default as default,
  errorMessage,
  nextCronTime,
  nextIntervalTime,
  parseCron,
  parseInterval,
  parseJsonc,
  server
};
