// 拾光记 · 用户数据层（加密存储）
// 存储内容：自定义日子（纪念日/待办/生理期/自定义）、每日总结档案、注入配置。
// 所有用户自定义数据走 EncryptedStore（AES-256-GCM + 随机密钥自包含），防乱扫。
// 内置节假日是公开数据，走明文文件（festivals.js 内嵌，不落盘）。
// 文件预算豁免：加密数据层统一维护同一份版本化存储与迁移边界，拆分会放大一致性风险。

import path from "node:path";
import crypto from "node:crypto";
import { EncryptedStore } from "./crypto-store.js";
import { normalizeTodoReminderWindow } from "./todo-time.js";

const VALID_INJECT_INTERVAL_HOURS = new Set([0.5, 1, 4, 8]);

export function normalizeInjectIntervalHours(value) {
  const hours = Number(value);
  return VALID_INJECT_INTERVAL_HOURS.has(hours) ? hours : 4;
}

// ── 日期工具 ──

export function pad2(n) {
  return String(n).padStart(2, "0");
}

export function dateKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function mmddKey(d) {
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function todayKey() {
  return dateKey(new Date());
}

function isValidCalendarDate(year, month, day) {
  if (![year, month, day].every(Number.isInteger) || year < 0 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day <= daysInMonth;
}

// 解析 "YYYY-MM-DD" 或 "MM-DD"（每年重复）→ { key, repeatYearly }
export function parseDateInput(input, now = new Date()) {
  const s = String(input || "").trim();
  const yyyy = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (yyyy) {
    const year = Number(yyyy[1]);
    const month = Number(yyyy[2]);
    const day = Number(yyyy[3]);
    if (!isValidCalendarDate(year, month, day)) return null;
    return {
      key: `${String(year).padStart(4, "0")}-${pad2(month)}-${pad2(day)}`,
      repeatYearly: false,
      month,
      day,
      year,
    };
  }
  const mm = /^(\d{2})-(\d{2})$/.exec(s);
  if (mm) {
    const year = now.getFullYear();
    const month = Number(mm[1]);
    const day = Number(mm[2]);
    if (!isValidCalendarDate(year, month, day)) return null;
    return {
      key: `${String(year).padStart(4, "0")}-${pad2(month)}-${pad2(day)}`,
      repeatYearly: true,
      month,
      day,
      year,
    };
  }
  return null;
}

// 统一把事件里可能遗留的 YYYY-MM-DD / MM-DD 日期转成可比较的完整日期键。
// 非法或非规范日期返回空串，调用方必须按“不可判断”处理，不能直接做字符串比较。
export function normalizeDateKey(input, now = new Date()) {
  return parseDateInput(input, now)?.key || "";
}

export function eventDateKey(event, now = new Date()) {
  return normalizeDateKey(event?.date, now);
}

// 情境注入、今日工具和预览共用这组待办到期判断，避免 MM-DD 被字符串比较误当成已到期。
export function isTodoDue(event, now = new Date()) {
  if (!event || event.type !== "todo" || event.done || event.repeatYearly) return false;
  const dueDate = eventDateKey(event, now);
  return !!dueDate && dueDate <= dateKey(now);
}

export function isTodoOverdue(event, now = new Date()) {
  if (!isTodoDue(event, now)) return false;
  return eventDateKey(event, now) < dateKey(now);
}

export function filterDueTodos(events, now = new Date()) {
  return (Array.isArray(events) ? events : []).filter((event) => isTodoDue(event, now));
}

// 从「生理期第N天」里解析 N，支持阿拉伯数字和常见中文数字。
// 返回 0 表示识别不了。
const CN_NUMS = {
  "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5,
  "六": 6, "七": 7, "八": 8, "九": 9, "十": 10,
};
function parseChineseDay(title) {
  const s = String(title || "");
  // 阿拉伯数字
  const arab = /第\s*(\d{1,2})\s*天/.exec(s);
  if (arab) {
    const n = parseInt(arab[1], 10);
    if (n >= 1 && n <= 31) return n;
  }
  // 中文数字：第X天 / 第X天（X 可为 一..十 / 十一..十九 / 二十X / 二十 / 三十）
  const m = /第\s*(十[一二三四五六七八九]?|[一二三四五六七八九]|二十[一二三四五六七八九]?|三十)\s*天/.exec(s);
  if (m) {
    const numStr = m[1];
    if (numStr === "十") return 10;
    if (numStr === "二十") return 20;
    if (numStr === "三十") return 30;
    if (numStr.startsWith("十")) return 10 + (CN_NUMS[numStr[1]] || 0);
    if (numStr.startsWith("二十")) return 20 + (CN_NUMS[numStr[2]] || 0);
    if (numStr.startsWith("三十")) return 30 + (CN_NUMS[numStr[2]] || 0);
    return CN_NUMS[numStr] || 0;
  }
  return 0;
}

// ── 数据层 ──

export class UserData {
  /**
   * @param {string} dataDir 插件数据目录
   */
  constructor(dataDir) {
    this.dataDir = dataDir;
    // 用户自定义日子：events = { id: {id, title, type, date, repeatYearly, note, reminderStart, reminderEnd, createdAt} }
    this.events = new EncryptedStore({
      dataDir,
      fileName: "user-events.dat",
      defaults: { events: {} },
    });
    // 待办到点提醒状态：和事件分开保存，避免内部送达信息污染日历事件结构。
    // 每条状态按 eventId 索引，重启后仍能判断已送达/待重试，防止重复提醒。
    this.todoReminders = new EncryptedStore({
      dataDir,
      fileName: "todo-reminders.dat",
      defaults: { reminders: {} },
    });
    // 每日总结档案：按生活日保存；新档案为 { version: 2, byAgent, legacy }，旧版混合档案原样保留在 legacy。
    this.summaries = new EncryptedStore({
      dataDir,
      fileName: "daily-summaries.dat",
      defaults: { summaries: {} },
    });
    // 每日总结后台任务：状态也加密，切换页面或重启后可继续查看/恢复。
    this.summaryJobs = new EncryptedStore({
      dataDir,
      fileName: "summary-jobs.dat",
      defaults: { jobs: {} },
    });
    // 注入配置
    this.settings = new EncryptedStore({
      dataDir,
      fileName: "settings.dat",
      defaults: {
        injectMode: "balanced", // economical | balanced | always（用户界面：适时 | 相伴 | 常在）
        injectIntervalHours: 4, // balanced 模式下的注入间隔
        injectionEnabled: true, // 是否把今日情境带入助手对话；关闭不影响日历/时光册
        autoSummary: false, // 每日自动总结开关
        summaryHour: 23, // 旧版兼容字段（v0.1.7 起不再使用）
        dayBoundaryHour: 4, // 一天翻篇时刻：0 | 2 | 4
        summaryAgentId: "", // 旧版兼容字段（新版按伙伴多选）
        summaryAgentIds: null, // 总结范围：null=全部伙伴，数组=只总结选中的伙伴（可为空）
        showPeriod: true, // 生理期记录开关（关闭后 UI 与注入都不出现生理期，数据保留）
        summaryShared: false, // 近期总结默认只注入当前助手；开启后才共享其他助手的近期动态
        // 天气情境：旧版地点文字继续保留，新版额外保存区县与坐标。
        weatherLocation: "", // 如「成都 武侯区」或「四川省 成都市 武侯区」；空=不启用天气
        weatherArea: null, // { code, province, city, district, latitude, longitude }
        weatherEnabled: true, // 主页天气与天气查询开关；旧配置默认保持开启
        weatherIntervalHours: 3, // 天气刷新间隔（小时）
      },
    });
    // 数据版本号：记录用户数据（日子/总结）最近一次写操作，供注入引擎判断「数据变了→立即刷新」。
    // 独立 store，不侵入 events/summaries 结构，重启保留。
    this.dataRev = new EncryptedStore({
      dataDir,
      fileName: "data-rev.dat",
      defaults: { rev: 0 },
    });
    // 天气缓存（最近一次查询结果，防频繁请求）
    this.weatherCache = new EncryptedStore({
      dataDir,
      fileName: "weather-cache.dat",
      defaults: { weather: null },
    });
    // 节日氛围引导变体已用索引（随机不重复用；按节日名记录，重启保留）
    this.festivalHintState = new EncryptedStore({
      dataDir,
      fileName: "festival-hint-state.dat",
      defaults: { used: {} },
    });
  }

  /**
   * 数据版本号：用户数据（自定义日子/生理期/每日总结）每次写操作后 +1。
   * 注入引擎用它判断「数据是否变化」——变了就立即刷新一次，不用等间隔到期。
   */
  getDataRev() {
    return Number(this.dataRev.read().rev) || 0;
  }

  async bumpDataRev() {
    await this.dataRev.update((d) => {
      d.rev = (Number(d.rev) || 0) + 1;
    });
  }

  // ── 事件（自定义日子）──

  listEvents() {
    const { events } = this.events.read();
    return Object.values(events);
  }

  getEvent(id) {
    return this.events.read().events[id] || null;
  }

  /**
   * 添加事件。
   * @param {object} e { title, type, date, repeatYearly, note, reminderStart, reminderEnd }
   * @returns {object} 完整事件
   */
  async addEvent({ title, type = "event", date, repeatYearly, note = "", reminderStart, reminderEnd }) {
    const parsed = parseDateInput(date);
    if (!parsed) throw new Error("日期格式不对，要用 YYYY-MM-DD 或 MM-DD");
    const id = crypto.randomUUID();
    const ev = {
      id,
      title: String(title || "").trim(),
      type, // event | todo | period | anniversary
      date: parsed.key,
      repeatYearly: repeatYearly === undefined ? parsed.repeatYearly : !!repeatYearly,
      note: String(note || "").trim(),
      createdAt: new Date().toISOString(),
    };
    if (!ev.title) throw new Error("名称不能为空");
    if (type === "todo") Object.assign(ev, normalizeTodoReminderWindow(reminderStart, reminderEnd));
    await this.events.update((d) => {
      d.events[id] = ev;
    });
    await this.bumpDataRev();
    return ev;
  }

  async updateEvent(id, patch) {
    const data = this.events.read();
    if (!data.events[id]) throw new Error("找不到这个日子");
    const ev = data.events[id];
    const nextType = patch.type !== undefined ? patch.type : ev.type;
    const nextReminder = nextType === "todo"
      ? normalizeTodoReminderWindow(
        patch.reminderStart !== undefined ? patch.reminderStart : ev.reminderStart,
        patch.reminderEnd !== undefined ? patch.reminderEnd : ev.reminderEnd,
      )
      : null;
    if (patch.title !== undefined) ev.title = String(patch.title).trim();
    if (patch.type !== undefined) ev.type = patch.type;
    if (patch.note !== undefined) ev.note = String(patch.note).trim();
    if (patch.date !== undefined) {
      const parsed = parseDateInput(patch.date);
      if (!parsed) throw new Error("日期格式不对");
      ev.date = parsed.key;
      ev.repeatYearly = patch.repeatYearly !== undefined ? !!patch.repeatYearly : parsed.repeatYearly;
    } else if (patch.repeatYearly !== undefined) {
      ev.repeatYearly = !!patch.repeatYearly;
    }
    if (nextReminder) Object.assign(ev, nextReminder);
    else {
      delete ev.reminderStart;
      delete ev.reminderEnd;
    }
    if (!ev.title) throw new Error("名称不能为空");
    await this.events.save();
    await this.bumpDataRev();
    return ev;
  }

  async removeEvent(id) {
    await this.events.update((d) => {
      delete d.events[id];
    });
    await this.todoReminders.update((d) => {
      delete d.reminders[id];
    });
    await this.bumpDataRev();
  }

  // ── 待办提醒状态（由到点调度器使用）──

  getTodoReminder(id) {
    const key = String(id || "").trim();
    if (!key) return null;
    const reminders = this.todoReminders.read().reminders;
    return reminders && typeof reminders === "object" && !Array.isArray(reminders)
      ? reminders[key] || null
      : null;
  }

  async saveTodoReminder(id, value) {
    const key = String(id || "").trim();
    if (!key) return null;
    await this.todoReminders.update((d) => {
      if (!d.reminders || typeof d.reminders !== "object" || Array.isArray(d.reminders)) d.reminders = {};
      d.reminders[key] = value && typeof value === "object" ? { ...value } : {};
    });
    return this.getTodoReminder(key);
  }

  async removeTodoReminder(id) {
    const key = String(id || "").trim();
    if (!key) return false;
    let removed = false;
    await this.todoReminders.update((d) => {
      if (d.reminders && Object.prototype.hasOwnProperty.call(d.reminders, key)) {
        delete d.reminders[key];
        removed = true;
      }
    });
    return removed;
  }

  /**
   * 切换待办完成状态。
   * @param {string} id 事件 id
   * @returns {object|null} 更新后的事件（找不到返回 null）
   */
  async toggleTodo(id) {
    const data = this.events.read();
    const ev = data.events[id];
    if (!ev || ev.type !== "todo") return null;
    ev.done = !ev.done;
    await this.events.save();
    await this.bumpDataRev();
    return ev;
  }

  /**
   * 查某天的用户自定义日子（含周期重复的匹配）。
   * @param {Date} date
   * @returns {Array<object>}
   */
  eventsOnDate(date) {
    const dk = dateKey(date);
    const mk = mmddKey(date);
    const { events } = this.events.read();
    return Object.values(events).filter((e) => {
      if (e.repeatYearly) {
        return e.date.slice(5) === mk; // MM-DD 段比较
      }
      return e.date === dk;
    });
  }

  // 生理期：单独的类型，查询「某天是否在生理期内」
  // 生理期存的是「开始日 + 持续天数」，在 events 里 type=period，note 存持续天数（默认 5）
  periodsActiveOn(date) {
    const dk = dateKey(date);
    const { events } = this.events.read();
    return Object.values(events).filter((e) => {
      if (e.type !== "period") return false;
      const days = parseInt(e.note, 10) || 5;
      for (let i = 0; i < days; i++) {
        const d = new Date(date);
        d.setDate(d.getDate() - i);
        if (dateKey(d) === e.date || (e.repeatYearly && mmddKey(d) === e.date.slice(5))) {
          return true;
        }
      }
      return false;
    });
  }

  /**
   * 某天是某个生理期的第几天（从 1 开始）。
   * 用日期差（忽略时刻）计算，避免下午算整天时 round 错位。
   * @param {object} period 生理期事件
   * @param {Date} date 目标日期
   * @returns {number} 第几天；不在生理期内返回 0
   */
  periodDayOn(period, date) {
    const days = parseInt(period.note, 10) || 5;
    // 用日期键算整天差（忽略时刻，避免 round 错位）
    const startKey = dateKey(new Date(period.date + "T00:00:00"));
    const dateKeyStr = dateKey(date);
    const diff = Math.round(
      (new Date(dateKeyStr + "T00:00:00").getTime() - new Date(startKey + "T00:00:00").getTime()) / 86400000
    );
    if (diff < 0 || diff >= days) return 0;
    return diff + 1;
  }

  /**
   * 查询某天处于生理期内的记录，带第几天信息。
   * @param {Date} date
   * @returns {Array<{event: object, day: number}>}
   */
  periodsWithDayOn(date) {
    const dk = dateKey(date);
    return this.periodsActiveOn(date).map((p) => {
      // 老数据没有 confirmedThrough 时，已过去的范围视为事实；未来仍是预计。
      const confirmedThrough = p.confirmedThrough || dateKey(new Date());
      return { event: p, day: this.periodDayOn(p, date), predicted: dk > confirmedThrough };
    });
  }

  /**
   * 快捷标记生理期：把某天标为生理期（点选语义）。
   * - 该天已在某个周期内 → 无变化
   * - 该天的前一天或后一天在某周期内 → 并入该周期（延伸或提前开始日）
   * - 否则 → 以该天为开始日新建周期（持续 duration 天，默认 5）
   * @param {Date} date 要标记的那天
   * @param {number} duration 全新开始时默认持续天数（默认 5）
   * @returns {object} { created: boolean, event: object }
   */
  async markPeriod(date, duration = 5) {
    const dk = dateKey(date);
    const { events } = this.events.read();
    const existing = Object.values(events).filter((e) => e.type === "period");
    // 1) 该天已在某周期内：无变化
    const inside = existing.find((e) => this.periodDayOn(e, date) > 0);
    if (inside) {
      let confirmed = false;
      if (!inside.confirmedThrough || dk > inside.confirmedThrough) {
        inside.confirmedThrough = dk;
        await this.events.save();
        confirmed = true;
        await this.bumpDataRev();
      }
      return { created: false, confirmed, event: inside };
    }
    // 2) 前一天在某周期内 → 延伸该周期
    const prev = new Date(date);
    prev.setDate(prev.getDate() - 1);
    const inPrev = existing.find((e) => this.periodDayOn(e, prev) > 0);
    if (inPrev) {
      const curEnd = new Date(inPrev.date + "T00:00:00");
      curEnd.setDate(curEnd.getDate() + (parseInt(inPrev.note, 10) || 5) - 1);
      if (date.getTime() > curEnd.getTime()) {
        const newDays = Math.round((date.getTime() - new Date(inPrev.date + "T00:00:00").getTime()) / 86400000) + 1;
        inPrev.note = String(newDays);
        inPrev.title = "生理期";
        inPrev.confirmedThrough = dk;
        await this.events.save();
        await this.bumpDataRev();
      }
      return { created: false, extended: true, event: inPrev };
    }
    // 3) 后一天在某周期内 → 提前开始日
    const next = new Date(date);
    next.setDate(next.getDate() + 1);
    const inNext = existing.find((e) => this.periodDayOn(e, next) > 0);
    if (inNext) {
      // 新周期 = 从 date 到原结束日
      const curEnd = new Date(inNext.date + "T00:00:00");
      curEnd.setDate(curEnd.getDate() + (parseInt(inNext.note, 10) || 5) - 1);
      const newDays = Math.round((curEnd.getTime() - date.getTime()) / 86400000) + 1;
      inNext.date = dk;
      inNext.note = String(newDays);
      inNext.title = "生理期";
      await this.events.save();
      await this.bumpDataRev();
      return { created: false, extended: true, event: inNext };
    }
    // 4) 全新开始
    const id = crypto.randomUUID();
    const ev = {
      id,
      title: "生理期",
      type: "period",
      date: dk,
      repeatYearly: false,
      note: String(Math.max(1, parseInt(duration, 10) || 5)),
      createdAt: new Date().toISOString(),
      confirmedThrough: dk,
    };
    await this.events.update((d) => {
      d.events[id] = ev;
    });
    await this.bumpDataRev();
    return { created: true, event: ev };
  }

  /**
   * 移除某天在生理期上的标记：
   * - 如果该天是开始日且周期只有 1 天 → 整条删除
   * - 如果该天是开始日但周期更长 → 开始日顺延一天，持续天数减一
   * - 如果该天在周期中间/末尾 → 缩短持续天数到该天前一天
   * @param {Date} date 要移除的那天
   * @returns {boolean} 是否有变动
   */
  async unmarkPeriodDay(date) {
    const dk = dateKey(date);
    const { events } = this.events.read();
    const period = Object.values(events).find((e) => e.type === "period" && this.periodDayOn(e, date) > 0);
    if (!period) return false;
    const dayIdx = this.periodDayOn(period, date); // 1-based
    const totalDays = parseInt(period.note, 10) || 5;
    const start = new Date(period.date + "T00:00:00");
    if (totalDays <= 1 || (dayIdx === 1 && totalDays === 1)) {
      // 只剩这一天：整条删除
      delete events[period.id];
      await this.events.save();
      await this.bumpDataRev();
      return true;
    }
    if (dayIdx === 1) {
      // 删除开始日：开始日 +1，持续天数 -1
      start.setDate(start.getDate() + 1);
      period.date = dateKey(start);
      period.note = String(totalDays - 1);
    } else {
      // 删除中间/末尾：持续天数缩到该天前一天
      period.note = String(dayIdx - 1);
    }
    await this.events.save();
    await this.bumpDataRev();
    return true;
  }

  /**
   * 确认一段生理期到此结束（「今天结束了」语义，不删任何已记的天）。
   * - 该日仍在某周期内 → 周期截断到该日（note = 该日 - 开始日 + 1），confirmedThrough 置为该日
   * - 该日不在周期内但前一天在（结束后第一天）→ 周期保持不动，仅 confirmedThrough 置为前一天，确认它已结束
   * - 都没有 → 无操作
   * @param {Date} date 结束确认日（通常是今天）
   * @returns {{ changed: boolean, period: object|null }} 是否有变动 + 涉及周期
   */
  async endPeriodOn(date) {
    const dk = dateKey(date);
    const { events } = this.events.read();
    const all = Object.values(events).filter((e) => e.type === "period");
    if (!all.length) return { changed: false, period: null };
    // 优先：当天在周期内 → 截断到今天
    const inside = all.find((e) => this.periodDayOn(e, date) > 0);
    if (inside) {
      const dayIdx = this.periodDayOn(inside, date);
      const totalDays = parseInt(inside.note, 10) || 5;
      if (dayIdx !== totalDays || (inside.confirmedThrough || "") !== dk) {
        inside.note = String(dayIdx);
        inside.title = "生理期";
        inside.confirmedThrough = dk;
        await this.events.save();
        await this.bumpDataRev();
      }
      return { changed: true, period: inside };
    }
    // 其次：前一天在周期内（今天已结束）→ 仅确认结束，不删任何天
    const prev = new Date(date);
    prev.setDate(prev.getDate() - 1);
    const inPrev = all.find((e) => this.periodDayOn(e, prev) > 0);
    if (inPrev) {
      const prevKey = dateKey(prev);
      if ((inPrev.confirmedThrough || "") !== prevKey) {
        inPrev.confirmedThrough = prevKey;
        await this.events.save();
        await this.bumpDataRev();
      }
      return { changed: true, period: inPrev };
    }
    return { changed: false, period: null };
  }

  /**
   * 旧数据迁移：识别标题里手写「生理期第 N 天」的记录，反推开始日，转成规范周期记录。
   * - 标题含「生理期」且匹配「第N天」→ date 反推为开始日，note=持续天数，title 归一为「生理期」
   * - 标题含「生理期」但无法识别第几天 → 视为开始日（第1天）
   * - 已规范的 period 记录不动
   * @returns {object} { migrated: number, uncertain: number, details: Array }
   */
  async migrateLegacyPeriods() {
    const { events } = this.events.read();
    const items = Object.values(events);
    const details = [];
    let migrated = 0;
    let uncertain = 0;
    for (const ev of items) {
      // 已规范：type=period 且标题就是「生理期」→ 跳过
      if (ev.type === "period") {
        if (ev.title === "生理期") continue;
        // 老数据可能 title 是「生理期第N天」但 type 已是 period：归一 title，保留 date/note 不动
        const n = parseChineseDay(ev.title || "");
        if (n > 0 && ev.date) {
          const start = new Date(ev.date + "T00:00:00");
          start.setDate(start.getDate() - (n - 1));
          const confirmedThrough = ev.date;
          ev.date = dateKey(start);
          ev.note = String(n);
          ev.confirmedThrough = confirmedThrough;
          ev.title = "生理期";
          migrated++;
          details.push({ id: ev.id, from: "period", to: "period", start: ev.date, days: n });
          continue;
        }
        ev.title = "生理期";
        uncertain++;
        details.push({ id: ev.id, from: "period", to: "period-normalized-title" });
        continue;
      }
      // 非 period 类型但标题含「生理期」→ 转为周期记录
      if ((ev.title || "").includes("生理期") || (ev.note || "").includes("生理期")) {
        const n = parseChineseDay(ev.title || "");
        if (n > 0) {
          // 标题是「生理期第N天」，date 是当天 → 反推开始日 = date - (N-1)
          const start = new Date(ev.date + "T00:00:00");
          start.setDate(start.getDate() - (n - 1));
          const confirmedThrough = ev.date;
          ev.type = "period";
          ev.date = dateKey(start);
          ev.note = String(n);
          ev.confirmedThrough = confirmedThrough;
          ev.repeatYearly = false;
          ev.title = "生理期";
          migrated++;
          details.push({ id: ev.id, from: "handwritten", to: "period", start: ev.date, days: n });
          continue;
        }
        // 无法识别第几天：视为开始日（第1天，默认持续天数）
        ev.type = "period";
        ev.repeatYearly = false;
        ev.note = String(parseInt(ev.note, 10) || 5);
        ev.title = "生理期";
        migrated++;
        details.push({ id: ev.id, from: "handwritten-uncertain", to: "period-start-only", start: ev.date });
      }
    }
    if (migrated > 0 || uncertain > 0) {
      await this.events.save();
    }
    return { migrated, uncertain, details };
  }

  // ── 每日总结 ──

  getSummary(key) {
    return this.summaries.read().summaries[key] || null;
  }

  getSummaryRecord(key) {
    const raw = this.getSummary(key);
    if (!raw || typeof raw !== "object") return null;
    if (raw.byAgent && typeof raw.byAgent === "object" && !Array.isArray(raw.byAgent)) {
      return {
        version: 2,
        byAgent: raw.byAgent,
        legacy: raw.legacy && typeof raw.legacy === "object" ? raw.legacy : null,
        updatedAt: raw.updatedAt || "",
      };
    }
    // 旧版只有一份混合总结，保留为未分类档案，不擅自猜归属。
    return { version: 1, byAgent: {}, legacy: raw, updatedAt: raw.updatedAt || "" };
  }

  static isUsableSummary(summary) {
    return !!summary && !summary.empty && !!String(summary.text || "").trim();
  }

  hasSummary(key, { includeEmpty = false } = {}) {
    const record = this.getSummaryRecord(key);
    if (!record) return false;
    const entries = Object.values(record.byAgent || {});
    if (entries.some((entry) => UserData.isUsableSummary(entry))) return true;
    return includeEmpty && !!record.legacy;
  }

  hasAgentSummary(key) {
    return this.listSummaryEntries(key).some((entry) => !entry.unclassified && UserData.isUsableSummary(entry));
  }

  listSummaryEntries(date = null, { includeEmpty = false } = {}) {
    const { summaries } = this.summaries.read();
    const entries = [];
    for (const [key, raw] of Object.entries(summaries || {})) {
      if (date && key !== date) continue;
      const record = this.getSummaryRecordFromRaw(raw);
      for (const [agentId, summary] of Object.entries(record.byAgent || {})) {
        if (!includeEmpty && !UserData.isUsableSummary(summary)) continue;
        entries.push({ date: key, ...summary, agentId, unclassified: false });
      }
      if (record.legacy && (includeEmpty || UserData.isUsableSummary(record.legacy))) {
        entries.push({ date: key, ...record.legacy, agentId: "", unclassified: true });
      }
    }
    return entries.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      if (a.unclassified !== b.unclassified) return a.unclassified ? 1 : -1;
      return String(a.agentId).localeCompare(String(b.agentId));
    });
  }

  getSummaryRecordFromRaw(raw) {
    if (!raw || typeof raw !== "object") return { version: 1, byAgent: {}, legacy: null, updatedAt: "" };
    if (raw.byAgent && typeof raw.byAgent === "object" && !Array.isArray(raw.byAgent)) {
      return {
        version: 2,
        byAgent: raw.byAgent,
        legacy: raw.legacy && typeof raw.legacy === "object" ? raw.legacy : null,
        updatedAt: raw.updatedAt || "",
      };
    }
    return { version: 1, byAgent: {}, legacy: raw, updatedAt: raw.updatedAt || "" };
  }

  getAgentSummary(key, agentId) {
    const id = String(agentId || "").trim();
    if (!id) return null;
    const record = this.getSummaryRecord(key);
    return record?.byAgent?.[id] || null;
  }

  listSummaries() {
    // 兼容旧调用方：展开新档案，并把旧混合档案标成未分类。
    return this.listSummaryEntries();
  }

  async saveSummary(key, text, meta = {}) {
    // 保留旧 API 语义：没有 agentId 时写入未分类 legacy；不会覆盖已有按伙伴档案。
    const value = {
      ...meta,
      text: String(text || ""),
      updatedAt: new Date().toISOString(),
    };
    await this.summaries.update((d) => {
      const current = d.summaries[key];
      if (current?.byAgent && typeof current.byAgent === "object" && !Array.isArray(current.byAgent)) {
        d.summaries[key] = {
          ...current,
          legacy: value,
          updatedAt: value.updatedAt,
        };
      } else {
        d.summaries[key] = value;
      }
    });
    await this.bumpDataRev();
  }

  async saveAgentSummary(key, agentId, text, meta = {}) {
    const id = String(agentId || "").trim();
    if (!id) throw new Error("缺少伙伴身份，不能保存分类档案");
    const value = {
      ...meta,
      agentId: id,
      text: String(text || ""),
      updatedAt: new Date().toISOString(),
    };
    await this.summaries.update((d) => {
      const current = d.summaries[key];
      const record = this.getSummaryRecordFromRaw(current);
      record.byAgent[id] = value;
      d.summaries[key] = {
        version: 2,
        byAgent: record.byAgent,
        ...(record.legacy ? { legacy: record.legacy } : {}),
        updatedAt: value.updatedAt,
      };
    });
    await this.bumpDataRev();
    return value;
  }

  async removeAgentSummary(key, agentId) {
    const id = String(agentId || "").trim();
    if (!id) return this.removeLegacySummary(key);
    let removed = false;
    await this.summaries.update((d) => {
      const current = d.summaries[key];
      const record = this.getSummaryRecordFromRaw(current);
      if (!Object.prototype.hasOwnProperty.call(record.byAgent, id)) return;
      delete record.byAgent[id];
      removed = true;
      if (!Object.keys(record.byAgent).length && !record.legacy) {
        delete d.summaries[key];
        return;
      }
      d.summaries[key] = {
        version: 2,
        byAgent: record.byAgent,
        ...(record.legacy ? { legacy: record.legacy } : {}),
        updatedAt: new Date().toISOString(),
      };
    });
    if (removed) await this.bumpDataRev();
    return removed;
  }

  async removeLegacySummary(key) {
    let removed = false;
    await this.summaries.update((d) => {
      const current = d.summaries[key];
      if (!current) return;
      const record = this.getSummaryRecordFromRaw(current);
      if (!record.legacy) return;
      removed = true;
      if (!Object.keys(record.byAgent).length) {
        delete d.summaries[key];
        return;
      }
      d.summaries[key] = {
        version: 2,
        byAgent: record.byAgent,
        updatedAt: new Date().toISOString(),
      };
    });
    if (removed) await this.bumpDataRev();
    return removed;
  }

  async removeSummary(key) {
    await this.summaries.update((d) => {
      delete d.summaries[key];
    });
    await this.bumpDataRev();
  }

  // ── 每日总结后台任务 ──

  getSummaryJob(id) {
    const key = String(id || "").trim();
    const jobs = this.summaryJobs.read().jobs;
    return key && jobs && typeof jobs === "object" && !Array.isArray(jobs) ? jobs[key] || null : null;
  }

  listSummaryJobs(limit = 20) {
    const max = Math.max(1, Number(limit) || 20);
    const jobs = this.summaryJobs.read().jobs;
    const map = jobs && typeof jobs === "object" && !Array.isArray(jobs) ? jobs : {};
    const values = Object.values(map).filter((job) => job && typeof job === "object");
    // 只对外暴露主线任务：merged 的重试任务、以及「原任务已结束」的旧版重试残留，都不再展示。
    const visible = values.filter((job) => {
      if (job.status === "merged") return false;
      const retryOf = String(job.retryOf || "").trim();
      if (!retryOf) return true;
      // 重试任务还在跑（queued/running）时必须展示，用户要看进度。
      if (job.status === "queued" || job.status === "running") return true;
      const parent = map[retryOf];
      // 重试任务已结束：原任务已被确认收下、已合并完成或已是终态，重试残留不必再出现。
      if (!parent || parent.status === "merged" || parent.dismissedAt) return false;
      return !["completed", "completed_with_errors", "failed"].includes(parent.status);
    });
    return visible
      .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")))
      .slice(0, max);
  }

  async createSummaryJob(job) {
    const id = String(job?.id || "").trim();
    if (!id) throw new Error("缺少后台任务编号");
    const value = {
      ...job,
      id,
      dates: Array.isArray(job.dates) ? [...new Set(job.dates.map((date) => String(date)))] : [],
      outcomes: Array.isArray(job.outcomes) ? job.outcomes : [],
      createdAt: job.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await this.summaryJobs.update((d) => {
      if (!d.jobs || typeof d.jobs !== "object" || Array.isArray(d.jobs)) d.jobs = {};
      d.jobs[id] = value;
    });
    return value;
  }

  async updateSummaryJob(id, patch = {}) {
    const key = String(id || "").trim();
    if (!key) return null;
    let value = null;
    await this.summaryJobs.update((d) => {
      if (!d.jobs || typeof d.jobs !== "object" || Array.isArray(d.jobs) || !d.jobs[key]) return;
      d.jobs[key] = { ...d.jobs[key], ...patch, updatedAt: new Date().toISOString() };
      value = d.jobs[key];
    });
    return value;
  }

  // ── 注入配置 ──

  getSettings() {
    const settings = this.settings.read();
    return {
      ...settings,
      // 升级兼容：旧版可能还留着已移除的 2 小时档，统一回到默认 4 小时。
      injectIntervalHours: normalizeInjectIntervalHours(settings.injectIntervalHours),
    };
  }

  async updateSettings(patch) {
    const before = this.getSettings();
    await this.settings.update((d) => {
      Object.assign(d, patch);
      d.injectIntervalHours = normalizeInjectIntervalHours(d.injectIntervalHours);
    });
    // 天气重新开启时强制下一次查询绕过旧缓存，但保留旧结果作为网络失败时的底稿。
    if (patch?.weatherEnabled === true && before.weatherEnabled === false) {
      const cache = this.getWeatherCache();
      if (cache) await this.setWeatherCache({ ...cache, fetchedAt: 0 });
    }
    return this.getSettings();
  }

  // ── 天气缓存 ──

  /**
   * 读天气缓存。
   * @returns {{ location: string, fetchedAt: number, data: object }|null} 没有缓存返回 null
   */
  getWeatherCache() {
    return this.weatherCache.read().weather;
  }

  // ── 节日氛围引导变体状态（随机不重复用）──

  /** 某节日的已用变体索引（数组） */
  getUsedFestivalHintIndexes(name) {
    const { used } = this.festivalHintState.read();
    const arr = used[name];
    return Array.isArray(arr) ? arr : [];
  }

  /** 保存某节日的已用变体索引（写入队列串行化，防并发写坏） */
  async setUsedFestivalHintIndexes(name, indexes) {
    await this.festivalHintState.update((d) => {
      d.used = d.used || {};
      d.used[name] = Array.isArray(indexes) ? indexes : [];
    });
  }

  /**
   * 写天气缓存。
   * @param {object} weather { location, fetchedAt, data }
   */
  async setWeatherCache(weather) {
    await this.weatherCache.update((d) => {
      d.weather = weather;
    });
  }
}
