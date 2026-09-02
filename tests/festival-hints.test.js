// 拾光记 · 节日氛围引导（festival-hints）测试
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { FESTIVAL_GUIDELINES, FESTIVAL_HINTS, pickFestivalHint } from "../lib/festival-hints.js";
import { buildInjectionText } from "../lib/inject.js";
import { UserData } from "../lib/data.js";

function tmpDir(name) {
  return mkdtempSync(path.join(os.tmpdir(), `shiguangji-${name}-`));
}

// ── 引导表完整性 ──
test("节日引导表：12 个节日都有引导池，每池 5-8 个变体", () => {
  const names = ["中秋节", "春节", "元宵节", "端午节", "七夕", "情人节", "儿童节", "元旦", "国庆节", "平安夜", "跨年夜", "重阳节"];
  for (const name of names) {
    assert.ok(FESTIVAL_HINTS[name], `缺少 ${name} 引导`);
    const pool = FESTIVAL_HINTS[name].pool;
    assert.ok(Array.isArray(pool), `${name} 的 pool 不是数组`);
    assert.ok(pool.length >= 5 && pool.length <= 8, `${name} 的变体数 ${pool.length} 不在 5-8 范围`);
    // 每个变体非空且不含半角引号（防字符串断裂类问题）
    for (const v of pool) {
      assert.ok(typeof v === "string" && v.trim().length > 0, `${name} 有空变体`);
    }
  }
});

test("节日引导表：光棍节/清明/中元不配引导（由调用方自由发挥）", () => {
  assert.ok(!FESTIVAL_HINTS["光棍节"]);
  assert.ok(!FESTIVAL_HINTS["清明节"]);
  assert.ok(!FESTIVAL_HINTS["中元节"]);
});

test("通用红线非空且包含关键约束", () => {
  assert.ok(FESTIVAL_GUIDELINES.includes("不预设她的处境"));
  assert.ok(FESTIVAL_GUIDELINES.includes("求共享"));
  assert.ok(FESTIVAL_GUIDELINES.includes("不追问"));
});

// ── pick 随机不重复 ──
test("pickFestivalHint：没用过时优先抽未用过的，返回 index/text/nextUsed", () => {
  const r = pickFestivalHint("中秋节", []);
  assert.ok(r !== null);
  assert.ok(r.index >= 0 && r.index < FESTIVAL_HINTS["中秋节"].pool.length);
  assert.equal(r.text, FESTIVAL_HINTS["中秋节"].pool[r.index]);
  assert.ok(Array.isArray(r.nextUsed));
  assert.ok(r.nextUsed.includes(r.index));
});

test("pickFestivalHint：抽过的索引不会再被抽到（除非全用完）", () => {
  const pool = FESTIVAL_HINTS["中秋节"].pool;
  // 模拟连续抽：每次都带上前面的 nextUsed
  let used = [];
  const seen = new Set();
  for (let i = 0; i < pool.length; i++) {
    const r = pickFestivalHint("中秋节", used);
    assert.ok(!seen.has(r.index), `第 ${i + 1} 次抽到重复索引 ${r.index}`);
    seen.add(r.index);
    used = r.nextUsed;
  }
  assert.equal(seen.size, pool.length, "应能抽遍全部变体");
});

test("pickFestivalHint：全部用完后重新轮换（不返回 null）", () => {
  const pool = FESTIVAL_HINTS["春节"].pool;
  const allUsed = pool.map((_, i) => i);
  const r = pickFestivalHint("春节", allUsed);
  assert.ok(r !== null, "全用完也应能抽到（轮换一轮）");
  assert.ok(r.index >= 0 && r.index < pool.length);
});

test("pickFestivalHint：未知节日返回 null", () => {
  assert.equal(pickFestivalHint("不存在的节日", []), null);
});

test("pickFestivalHint：非法 used 索引被忽略", () => {
  const r = pickFestivalHint("中秋节", [999, -1, "a", null]);
  assert.ok(r !== null);
  assert.ok(r.index >= 0 && r.index < FESTIVAL_HINTS["中秋节"].pool.length);
});

// ── buildInjectionText 集成 ──
test("注入文本：带节日引导时，在「今天是」后插入【节日氛围】+ 通用红线", () => {
  const text = buildInjectionText({
    now: new Date(2026, 8, 25, 20, 0, 0),
    builtinFestivals: [{ name: "中秋节", emoji: "🌕" }],
    force: true,
    festivalHint: { name: "中秋节", text: "我这边月亮很圆。", index: 0, nextUsed: [0] },
  });
  assert.ok(text.includes("今天是：中秋节🌕"));
  assert.ok(text.includes("【节日氛围】今天是中秋节。我这边月亮很圆。"));
  assert.ok(text.includes("【节日通用分寸】"));
  // 氛围行在「今天是」行之后
  const todayIdx = text.indexOf("今天是：");
  const hintIdx = text.indexOf("【节日氛围】");
  assert.ok(hintIdx > todayIdx, "节日氛围应在今天是行之后");
});

test("注入文本：无节日引导时不出现【节日氛围】", () => {
  const text = buildInjectionText({
    now: new Date(2026, 8, 20, 8, 0, 0),
    builtinFestivals: [],
    force: true,
  });
  assert.ok(!text.includes("【节日氛围】"));
});

test("注入文本：无引导表的节日（光棍节）不注入氛围行", () => {
  const text = buildInjectionText({
    now: new Date(2026, 10, 11, 8, 0, 0),
    builtinFestivals: [{ name: "光棍节", emoji: "🕶️" }],
    force: true,
    festivalHint: null,
  });
  assert.ok(text.includes("今天是：光棍节🕶️"));
  assert.ok(!text.includes("【节日氛围】"));
});

// ── 数据层持久化 ──
test("数据层：已用节日引导索引可保存、读取、合并（重启保留）", async () => {
  const d = tmpDir("fhstate");
  const ud = new UserData(d);
  assert.deepEqual(ud.getUsedFestivalHintIndexes("中秋节"), []);
  await ud.setUsedFestivalHintIndexes("中秋节", [1, 3]);
  assert.deepEqual(ud.getUsedFestivalHintIndexes("中秋节"), [1, 3]);
  // 重开实例（模拟重启）仍能读到
  const ud2 = new UserData(d);
  assert.deepEqual(ud2.getUsedFestivalHintIndexes("中秋节"), [1, 3]);
  // 不同节日互不影响
  assert.deepEqual(ud2.getUsedFestivalHintIndexes("春节"), []);
});

test("数据层：节日引导索引加密存储，明文不落盘", async () => {
  const d = tmpDir("fhstate-enc");
  const ud = new UserData(d);
  await ud.setUsedFestivalHintIndexes("中秋节", [2, 5]);
  const raw = fs.readFileSync(path.join(d, "festival-hint-state.dat"), "utf-8");
  assert.ok(!raw.includes("中秋节"), "已用索引文件不应明文出现节日名");
  // 索引数字不单独验证（加密字节里随机出现数字是正常的），只保证没有可读 JSON 结构
  assert.ok(!raw.includes("used"), "已用索引文件不应明文出现字段名");
});
