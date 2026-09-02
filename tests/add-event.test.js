import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { UserData, dateKey } from "../lib/data.js";
import { __setSharedUserDataForTest } from "../lib/shared-data.js";
import { execute, parameters } from "../tools/add-event.js";
import { execute as executeToday } from "../tools/today.js";

function tmpDir(name) {
  const dir = path.join(os.tmpdir(), `sgj-tool-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test("添加待办工具：识别标题时间并回显准点/时段", async () => {
  assert.ok(parameters.properties.reminderStart);
  assert.ok(parameters.properties.reminderEnd);
  const data = new UserData(tmpDir("todo-time"));
  __setSharedUserDataForTest(data);
  try {
    const missing = await execute({ title: "买纸", type: "todo", date: "2026-09-01" });
    assert.match(missing.content[0].text, /待办需要选择提醒时间/);

    const exact = await execute({
      title: "带圆宝出去玩", type: "todo", date: "2026-09-01", reminderStart: "15:00", reminderEnd: "15:00",
    });
    assert.match(exact.content[0].text, /15:00 准点提醒/);

    const inferred = await execute({ title: "下午三点带圆宝出去玩", type: "todo", date: "2026-09-01" });
    assert.match(inferred.content[0].text, /15:00 准点提醒/);

    const inferredRange = await execute({ title: "下午三点到五点买纸", type: "todo", date: "2026-09-01" });
    assert.match(inferredRange.content[0].text, /15:00–17:00 时段提醒/);

    const inferredChineseTen = await execute({ title: "上午十点带圆宝去打针", type: "todo", date: "2026-09-01" });
    assert.match(inferredChineseTen.content[0].text, /10:00 准点提醒/);

    const inferredBareClock = await execute({
      title: "中午要和慧慧逛街，9点提醒我准备化妆", type: "todo", date: "2026-09-01",
    });
    assert.match(inferredBareClock.content[0].text, /09:00 准点提醒/);

    const inferredDaytimeBareClock = await execute({
      title: "两点 15分要去买椰子水", type: "todo", date: "2026-09-02",
    }, { now: new Date(2026, 8, 2, 14, 7, 0) });
    assert.match(inferredDaytimeBareClock.content[0].text, /14:15 准点提醒/);

    const inferredReminderWins = await execute({
      title: "中午12点要和慧慧逛街，9点提醒我准备化妆", type: "todo", date: "2026-09-01",
    });
    assert.match(inferredReminderWins.content[0].text, /09:00 准点提醒/);

    const range = await execute({
      title: "下午买纸", type: "todo", date: "2026-09-01", reminderStart: "15:00", reminderEnd: "17:00",
    });
    assert.match(range.content[0].text, /15:00–17:00 时段提醒/);
    assert.equal(data.listEvents().length, 8);
  } finally {
    __setSharedUserDataForTest(null);
  }
});

test("今天工具：不播报未来待办，保留今天和逾期事项", async () => {
  const data = new UserData(tmpDir("today-due-filter"));
  __setSharedUserDataForTest(data);
  const now = new Date();
  const today = dateKey(now);
  const yesterdayDate = new Date(now);
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterday = dateKey(yesterdayDate);
  const futureDate = new Date(now);
  futureDate.setDate(futureDate.getDate() + 2);
  const futureMmdd = `${String(futureDate.getMonth() + 1).padStart(2, "0")}-${String(futureDate.getDate()).padStart(2, "0")}`;
  try {
    await data.addEvent({ title: "今天该做", type: "todo", date: today, reminderStart: "09:00", reminderEnd: "09:00" });
    await data.addEvent({ title: "昨天没做", type: "todo", date: yesterday, reminderStart: "09:00", reminderEnd: "09:00" });
    await data.events.update((state) => {
      state.events.legacyFuture = {
        id: "legacyFuture",
        title: "未来才做",
        type: "todo",
        date: futureMmdd,
        repeatYearly: false,
        reminderStart: "09:00",
        reminderEnd: "09:00",
      };
    });
    const result = await executeToday();
    const text = result.content[0].text;
    assert.match(text, /今天该做/);
    assert.match(text, /昨天没做/);
    assert.doesNotMatch(text, /未来才做/);
    assert.match(text, /其中 1 条已经逾期/);
  } finally {
    __setSharedUserDataForTest(null);
  }
});
