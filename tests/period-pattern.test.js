// 拾光记 · 周期规律测试
// 覆盖：样本门槛、间隔过滤、中位数、下次预计窗口、当前第几天、超期、排序与脏数据。
// 全部是纯计算，不触碰真实用户数据（每个用例用独立临时目录）。
process.env.TZ = "Asia/Shanghai";

import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { UserData } from "../lib/data.js";

let seq = 0;
function tmpDir(name) {
  const d = path.join(os.tmpdir(), `sgj-period-pattern-${name}-${process.pid}-${seq++}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** 固定「今天」，避免用例跟着真实日期漂 */
const NOW = new Date(2026, 8, 11); // 2026-09-11

async function seedPeriods(ud, list) {
  for (const item of list) {
    await ud.addEvent({ title: "生理期", type: "period", date: item.date, note: String(item.days) });
  }
}

test("周期规律：一条记录都没有时不给任何规律", () => {
  const ud = new UserData(tmpDir("empty"));
  const p = ud.periodPattern(NOW);
  assert.equal(p.total, 0);
  assert.equal(p.enough, false);
  assert.equal(p.stats, null);
  assert.equal(p.next, null);
  assert.equal(p.current, null);
  assert.deepEqual(p.cycles, []);
});

test("周期规律：只有两次记录时样本不够，只给历史与当前，不给汇总和预测", async () => {
  const ud = new UserData(tmpDir("two"));
  await seedPeriods(ud, [
    { date: "2026-07-01", days: 5 },
    { date: "2026-07-29", days: 5 },
  ]);
  const p = ud.periodPattern(NOW);
  assert.equal(p.total, 2);
  assert.equal(p.enough, false, "两段记录不足以谈规律");
  assert.equal(p.needMore, 1);
  assert.equal(p.stats, null);
  assert.equal(p.next, null);
  assert.equal(p.cycles.length, 2);
  // 当前：7/29 到 9/11 是 44 天差 → 第 45 天
  assert.equal(p.current.day, 45);
  assert.equal(p.current.overdueDays, undefined, "没有预测就不谈超期");
});

test("周期规律：三次规律记录给出中位周期与单日预计", async () => {
  const ud = new UserData(tmpDir("three"));
  await seedPeriods(ud, [
    { date: "2026-07-01", days: 5 },
    { date: "2026-07-30", days: 6 },
    { date: "2026-08-28", days: 4 },
  ]);
  const p = ud.periodPattern(NOW);
  assert.equal(p.enough, true);
  assert.equal(p.needMore, 0);
  assert.equal(p.stats.medianInterval, 29);
  assert.equal(p.stats.minInterval, 29);
  assert.equal(p.stats.maxInterval, 29);
  assert.equal(p.stats.medianDays, 5);
  assert.equal(p.next.likely, "2026-09-26");
  assert.equal(p.next.earliest, "2026-09-26");
  assert.equal(p.next.latest, "2026-09-26");
  // 8/28 到 9/11 是 14 天差 → 第 15 天
  assert.equal(p.current.day, 15);
  assert.equal(p.current.overdueDays, undefined);
});

test("周期规律：间隔有波动时给出区间，中位取中间值", async () => {
  const ud = new UserData(tmpDir("span"));
  await seedPeriods(ud, [
    { date: "2026-07-01", days: 5 },
    { date: "2026-07-27", days: 5 }, // 26
    { date: "2026-08-30", days: 5 }, // 34
  ]);
  const p = ud.periodPattern(NOW);
  assert.equal(p.stats.minInterval, 26);
  assert.equal(p.stats.maxInterval, 34);
  assert.equal(p.stats.medianInterval, 30);
  assert.equal(p.next.earliest, "2026-09-25");
  assert.equal(p.next.likely, "2026-09-29");
  assert.equal(p.next.latest, "2026-10-03");
  assert.equal(p.current.day, 13);
});

test("周期规律：预计日子早过了会算出超期天数", async () => {
  const ud = new UserData(tmpDir("overdue"));
  await seedPeriods(ud, [
    { date: "2026-06-01", days: 5 },
    { date: "2026-06-29", days: 5 },
    { date: "2026-07-27", days: 5 },
  ]);
  const p = ud.periodPattern(NOW);
  assert.equal(p.next.latest, "2026-08-24");
  // 9/11 比 8/24 晚 18 天
  assert.equal(p.current.overdueDays, 18);
  assert.equal(p.current.day, 47);
});

test("周期规律：短得不像话的间隔当误标，不计入样本", async () => {
  const ud = new UserData(tmpDir("bogus"));
  await seedPeriods(ud, [
    { date: "2026-07-01", days: 5 },
    { date: "2026-07-20", days: 5 }, // 19 天，有效
    { date: "2026-07-25", days: 5 }, // 5 天，误标
  ]);
  const p = ud.periodPattern(NOW);
  assert.equal(p.total, 3);
  assert.equal(p.enough, false, "只剩一段有效间隔，不够谈规律");
  assert.equal(p.needMore, 1);
  assert.equal(p.next, null);
});

test("周期规律：四个间隔时中位数取中间两个的平均并取整", async () => {
  const ud = new UserData(tmpDir("even"));
  await seedPeriods(ud, [
    { date: "2026-05-04", days: 5 },
    { date: "2026-06-01", days: 5 }, // 28
    { date: "2026-07-04", days: 5 }, // 33
    { date: "2026-08-02", days: 5 }, // 29
    { date: "2026-08-30", days: 7 }, // 28
  ]);
  const p = ud.periodPattern(NOW);
  assert.equal(p.stats.samples, 4);
  // 排序后 28,28,29,33 → (28+29)/2 = 28.5 → 29
  assert.equal(p.stats.medianInterval, 29);
  assert.equal(p.stats.medianDays, 5);
});

test("周期规律：乱序记录会先按开始日排好再算间隔", async () => {
  const ud = new UserData(tmpDir("unsorted"));
  await seedPeriods(ud, [
    { date: "2026-07-27", days: 5 },
    { date: "2026-06-01", days: 5 },
    { date: "2026-06-29", days: 5 },
  ]);
  const p = ud.periodPattern(NOW);
  assert.deepEqual(
    p.cycles.map((c) => c.start),
    ["2026-06-01", "2026-06-29", "2026-07-27"],
  );
  assert.equal(p.stats.medianInterval, 28);
  assert.equal(p.next.likely, "2026-08-24");
});

test("周期规律：卡片最多回溯最近六次", async () => {
  const ud = new UserData(tmpDir("six"));
  const days = ["2026-01-01", "2026-01-29", "2026-02-26", "2026-03-26", "2026-04-23", "2026-05-21", "2026-06-18", "2026-07-16"];
  await seedPeriods(ud, days.map((date) => ({ date, days: 5 })));
  const p = ud.periodPattern(NOW);
  assert.equal(p.total, 8);
  assert.equal(p.cycles.length, 6);
  assert.equal(p.cycles[0].start, "2026-02-26");
  assert.equal(p.cycles[5].start, "2026-07-16");
});

test("周期规律：日期不规范的脏记录直接忽略", async () => {
  const ud = new UserData(tmpDir("dirty"));
  await seedPeriods(ud, [
    { date: "2026-06-01", days: 5 },
    { date: "2026-06-29", days: 5 },
    { date: "2026-07-27", days: 5 },
  ]);
  await ud.events.update((d) => {
    d.events.bad = { id: "bad", title: "生理期", type: "period", date: "不是日期", note: "5" };
  });
  const p = ud.periodPattern(NOW);
  assert.equal(p.total, 3, "脏记录不应进统计");
  assert.equal(p.enough, true);
});

test("周期规律：最后一次记录在未来时不给当前进度", async () => {
  const ud = new UserData(tmpDir("future"));
  await seedPeriods(ud, [{ date: "2026-03-01", days: 5 }]);
  const p = ud.periodPattern(new Date(2026, 0, 1)); // 2026-01-01，还早于最后一次记录
  assert.equal(p.total, 1);
  assert.equal(p.current, null, "今天早于最后一次记录，不算已走到第几天");
});
