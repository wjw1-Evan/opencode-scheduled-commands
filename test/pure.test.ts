import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { errorMessage, nextCronTime, nextIntervalTime, parseCron, parseInterval, parseJsonc } from "../scheduled-commands.ts"

describe("parseJsonc", () => {
  test("解析普通 JSON", () => {
    assert.deepEqual(parseJsonc('{"a":1,"b":[true,null,"x"]}'), { a: 1, b: [true, null, "x"] })
  })

  test("去除 // 行注释与 /* */ 块注释", () => {
    const text = `
      {
        // 行注释
        "a": 1, /* 块注释 */
        "b": 2 // 行尾注释
      }
    `
    assert.deepEqual(parseJsonc(text), { a: 1, b: 2 })
  })

  test("容忍尾逗号", () => {
    assert.deepEqual(parseJsonc('{"a":1,"b":[1,2,],}'), { a: 1, b: [1, 2] })
  })

  test("字符串内的 // 与 /* 不被当作注释", () => {
    const text = '{"url":"https://example.com","code":"a/*b*/c"}'
    assert.deepEqual(parseJsonc(text), { url: "https://example.com", code: "a/*b*/c" })
  })

  test("非法 JSON 抛出异常", () => {
    assert.throws(() => parseJsonc("{ not json }"))
  })
})

describe("parseCron", () => {
  test("解析 5 字段", () => {
    const f = parseCron("*/5 9-17 1,15 * 1-5")
    assert.equal(f.min.has(0), true)
    assert.equal(f.min.has(5), true)
    assert.equal(f.min.has(3), false)
    assert.equal(f.hour.has(9), true)
    assert.equal(f.hour.has(17), true)
    assert.equal(f.dom.has(1), true)
    assert.equal(f.dom.has(15), true)
    assert.equal(f.dow.has(1), true)
    assert.equal(f.dow.has(5), true)
    assert.equal(f.dow.has(0), false)
  })

  test("周字段 0 与 7 均归一化为周日", () => {
    assert.equal(parseCron("0 0 * * 0").dow.has(0), true)
    assert.equal(parseCron("0 0 * * 7").dow.has(0), true)
    assert.equal(parseCron("0 0 * * 7").dow.has(7), false)
  })

  test("通配符 *", () => {
    const f = parseCron("* * * * *")
    assert.equal(f.min.size, 60)
    assert.equal(f.hour.size, 24)
    assert.equal(f.dow.size, 7)
  })

  test("字段数量不对抛出异常", () => {
    assert.throws(() => parseCron("* * *"))
  })

  test("越界值抛出异常", () => {
    assert.throws(() => parseCron("60 * * * *"))
    assert.throws(() => parseCron("* 24 * * *"))
    assert.throws(() => parseCron("* * 0 * *"))
    assert.throws(() => parseCron("* * * 13 *"))
  })

  test("空段抛出异常", () => {
    assert.throws(() => parseCron("1,,2 * * * *"))
  })
})

describe("nextCronTime", () => {
  const at = (y: number, mo: number, d: number, h: number, mi: number, s = 0) => new Date(y, mo - 1, d, h, mi, s, 0)

  test("每分钟表达式包含当前整分钟", () => {
    assert.equal(nextCronTime("* * * * *", at(2026, 8, 11, 12, 30, 45))?.getTime(), at(2026, 8, 11, 12, 30).getTime())
  })

  test("步进表达式取下一个触发点", () => {
    assert.equal(nextCronTime("*/15 * * * *", at(2026, 8, 11, 12, 32))?.getTime(), at(2026, 8, 11, 12, 45).getTime())
    assert.equal(nextCronTime("*/15 * * * *", at(2026, 8, 11, 12, 45))?.getTime(), at(2026, 8, 11, 12, 45).getTime())
  })

  test("每天 0 点", () => {
    assert.equal(nextCronTime("0 0 * * *", at(2026, 8, 11, 12, 32))?.getTime(), at(2026, 8, 11 + 1, 0, 0).getTime())
  })

  test("工作日 0 点从周六跳到下周一", () => {
    assert.equal(nextCronTime("0 0 * * 1-5", at(2026, 8, 15, 10, 0))?.getTime(), at(2026, 8, 17, 0, 0).getTime())
  })

  test("日与周同时受限时取 OR（vixie 语义）", () => {
    // 2026-08-11 是周二；dom=13 与 dow=Friday 均为受限 → OR。
    // 8/13（周四）命中 dom=13，因此下一次是 8/13 12:00。
    assert.equal(nextCronTime("0 12 13 * 5", at(2026, 8, 11, 0, 0))?.getTime(), at(2026, 8, 13, 12, 0).getTime())
  })

  test("不可能触发的表达式返回 null", () => {
    assert.equal(nextCronTime("0 0 31 2 *", at(2026, 8, 11, 0, 0)), null)
  })
})

describe("parseInterval", () => {
  test("带单位解析", () => {
    assert.equal(parseInterval("500ms"), 500)
    assert.equal(parseInterval("30s"), 30_000)
    assert.equal(parseInterval("5m"), 5 * 60_000)
    assert.equal(parseInterval("2h"), 2 * 3_600_000)
    assert.equal(parseInterval("1d"), 86_400_000)
  })

  test("默认单位为秒", () => {
    assert.equal(parseInterval("30"), 30_000)
  })

  test("非法间隔抛出异常", () => {
    assert.throws(() => parseInterval("5x"))
    assert.throws(() => parseInterval("abc"))
    assert.throws(() => parseInterval(""))
  })
})

describe("nextIntervalTime", () => {
  const now = 1_700_000_000_000
  const MIN = 60_000

  test("从未运行过则立即触发", () => {
    assert.equal(nextIntervalTime(MIN, undefined, now), now)
  })

  test("间隔未到则等到 lastRun + ms", () => {
    assert.equal(nextIntervalTime(MIN, now - 10_000, now), now - 10_000 + MIN)
  })

  test("间隔已过则立即触发（错过的只补一次）", () => {
    assert.equal(nextIntervalTime(MIN, now - 10 * MIN, now), now)
  })
})

describe("errorMessage", () => {
  test("SDK 错误结构 { data: { message } }", () => {
    assert.equal(errorMessage({ data: { message: "boom" } }), "boom")
  })

  test("顶层 message", () => {
    assert.equal(errorMessage({ message: "top" }), "top")
  })

  test("只有 name", () => {
    assert.equal(errorMessage({ name: "FooError" }), "FooError")
  })

  test("非对象回退到 String", () => {
    assert.equal(errorMessage("plain"), "plain")
    assert.equal(errorMessage(null), "null")
    assert.equal(errorMessage(42), "42")
  })
})
