// 拾光记 · 工具：查询今天是什么日子
// 助手在对话中调用，感知当天情境（节假日/纪念日/生理期/待办）。

import { getSharedUserData } from "../lib/shared-data.js";
import { getBuiltinFestivals, isWorkday } from "../lib/festivals.js";
import { dateKey, filterDueTodos, isTodoOverdue } from "../lib/data.js";

function getData(context = null) {
  return getSharedUserData(context?.dataDir || context?.pluginContext?.dataDir || context?.ctx?.dataDir);
}

export const name = "shiguangji_today";
export const description =
  "查询今天是什么日子：节假日、纪念日、待办、生理期等（拾光记插件）。需要了解今天是否为特殊日子时调用。";
export const sessionPermission = { readOnly: true };
export const parameters = {
  type: "object",
  properties: {},
};

export async function execute(_input = {}, context = {}) {
  const now = new Date();
  const builtin = getBuiltinFestivals(now);
  const data = getData(context);
  const settings = data.getSettings();
  const userEvents = data.eventsOnDate(now).filter((e) => e.type !== "period");
  const periods = settings.showPeriod === false
    ? []
    : data.periodsWithDayOn(now).filter((p) => !p.predicted).map((p) => p.event);
  const workday = isWorkday(now);

  const lines = [];
  lines.push(
    `今天是 ${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 星期${["日", "一", "二", "三", "四", "五", "六"][now.getDay()]}`
  );

  const specials = [];
  for (const f of builtin) specials.push(`${f.name}(${f.source})`);
  for (const e of userEvents) specials.push(e.title);
  for (const p of periods) specials.push("生理期");
  if (workday) specials.push("调休上班日");
  lines.push(specials.length ? `今天有：${specials.join("、")}` : "今天没有特殊日子");

  const today = dateKey(now);
  const todos = filterDueTodos(data.listEvents(), now);
  const overdue = todos.filter((e) => isTodoOverdue(e, now));
  lines.push(todos.length ? `待办：${todos.map((t) => t.title).join("、")}` : "今天没有到期待办");
  if (overdue.length) lines.push(`其中 ${overdue.length} 条已经逾期`);

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
