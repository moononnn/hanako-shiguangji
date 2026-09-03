// 拾光记 · 页面模板（服务端渲染，手帐风重制版）
// 独立成模块，避免 routes/ui.js 过胖。
// ⚠️ 注意：此文件整体是模板字符串，内部前端 JS 禁止使用反引号模板的 ${} 插值
//   （会被服务端模板解析吞掉），一律用字符串拼接。

import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BS_DIR = path.join(__dirname, "beautify-select");
const TODO_TIME_CLIENT_FILE = path.join(__dirname, "todo-time-client.js");
const UC_UI_DIR = path.join(__dirname, "update-checker", "ui");
const FB_UI_DIR = path.join(__dirname, "feedback", "ui");

export function renderPage(token) {
  // beautify-select 手帐风下拉组件（内联，避免外部资源鉴权问题）
  let bsCss = "";
  let bsJs = "";
  let todoTimeClientJs = "";
  let ucCss = "";
  let ucJs = "";
  let fbCss = "";
  let fbJs = "";
  try {
    bsCss = readFileSync(path.join(BS_DIR, "beautify-select.css"), "utf-8");
    bsJs = readFileSync(path.join(BS_DIR, "beautify-select.js"), "utf-8").replace(/<\/script>/gi, "<\\/script>");
  } catch {
    // 读不到不影响页面主体
  }
  try {
    todoTimeClientJs = readFileSync(TODO_TIME_CLIENT_FILE, "utf-8").replace(/<\/script>/gi, "<\\/script>");
  } catch {
    // 自动识别不可用时，手动选时间仍可正常使用
  }
  try {
    ucCss = readFileSync(path.join(UC_UI_DIR, "update-checker.css"), "utf-8");
    ucJs = readFileSync(path.join(UC_UI_DIR, "update-checker.js"), "utf-8").replace(/<\/script>/gi, "<\\/script>");
    fbCss = readFileSync(path.join(FB_UI_DIR, "feedback.css"), "utf-8");
    fbJs = readFileSync(path.join(FB_UI_DIR, "feedback.js"), "utf-8").replace(/<\/script>/gi, "<\\/script>");
  } catch {
    // 更新检查/反馈不可用时，设置页仍可正常使用
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>拾光记</title>
<style>
  :root {
    --bg: #faf6ec;
    --card: #fffdf8;
    --ink: #4a463e;
    --muted: #948b7a;
    --primary: #7fb8a0;
    --primary-deep: #4d8a70;
    --primary-soft: #e7f1eb;
    --accent: #e89bb0;
    --accent-deep: #c96f87;
    --accent-soft: #f9e9ee;
    --warm: #dd9f6f;
    --warm-soft: #f9ecdf;
    --period: #d98a96;
    --period-soft: #f8e4e7;
    --line: #efe7d8;
    --shadow: 0 8px 22px rgba(96, 74, 40, 0.07);
    --shadow-up: 0 12px 30px rgba(96, 74, 40, 0.12);
    --radius: 20px;
    --radius-sm: 12px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    font-family: "霞鹜文楷", "Kaiti SC", "STKaiti", "Noto Sans SC", sans-serif;
    background: var(--bg);
    color: var(--ink);
    padding: 22px 22px 40px;
    min-height: 100vh;
    /* 极淡的手帐纸纹：细横线 + 一点暖调 */
    background-image:
      repeating-linear-gradient(0deg, transparent, transparent 27px, rgba(190, 168, 130, 0.05) 27px, rgba(190, 168, 130, 0.05) 28px),
      linear-gradient(180deg, #fcf8f0, var(--bg));
    background-attachment: fixed;
  }
  button { font-family: inherit; }

  /* ── 头部 ── */
  .header {
    display: flex; align-items: flex-end; justify-content: space-between;
    gap: 12px; margin-bottom: 18px; flex-wrap: wrap;
  }
  .brand { display: flex; align-items: baseline; gap: 12px; }
  .brand h1 {
    font-size: 28px; font-weight: 600; letter-spacing: 4px; color: var(--ink);
    position: relative;
  }
  .brand h1::after {
    content: ""; position: absolute; left: 2px; right: 2px; bottom: -3px;
    height: 6px; border-radius: 99px;
    background: linear-gradient(90deg, var(--primary) 0 42%, var(--accent) 42% 58%, transparent 58%);
    opacity: 0.55;
  }
  .brand .sub { color: var(--muted); font-size: 13px; letter-spacing: 1px; }
  .go-today-btn {
    border: 1px solid var(--line); background: var(--card); color: var(--primary-deep);
    padding: 6px 16px; border-radius: 99px; font-size: 13px; cursor: pointer;
    transition: all .18s;
  }
  .go-today-btn:hover { border-color: var(--primary); box-shadow: var(--shadow); transform: translateY(-1px); }
  .header-actions { display: flex; gap: 8px; align-items: center; }
  .settings-btn {
    border: 1px solid var(--line); background: transparent; color: var(--muted);
    padding: 6px 14px; border-radius: 99px; font-size: 13px; cursor: pointer;
    transition: all .18s;
  }
  .settings-btn:hover { border-color: var(--primary); color: var(--primary-deep); background: var(--primary-soft); }
  .context-toggle-btn {
    border: 1px solid #cfe5d8; background: var(--primary-soft); color: var(--primary-deep);
    padding: 6px 12px; border-radius: 99px; font-size: 13px; cursor: pointer;
    transition: all .18s;
  }
  .context-toggle-btn:hover { border-color: var(--primary); box-shadow: var(--shadow); transform: translateY(-1px); }
  .context-toggle-btn.off { border-color: var(--line); background: transparent; color: var(--muted); }
  .context-toggle-btn:disabled { opacity: .58; cursor: wait; transform: none; }

  /* ── 今日概览卡（手帐的「今日页」） ── */
  .today-card {
    position: relative;
    background: linear-gradient(135deg, #f2f9f5 0%, #fbf7ee 70%);
    border: 1px solid #e3ecdf;
    border-radius: var(--radius);
    padding: 20px 22px 18px;
    margin-bottom: 18px;
    box-shadow: var(--shadow);
    overflow: hidden;
    display: flex; gap: 20px; align-items: center; flex-wrap: wrap;
    cursor: pointer;
    transition: box-shadow .18s, transform .18s;
  }
  .today-card:hover { box-shadow: 0 8px 24px rgba(93, 174, 142, .12); transform: translateY(-1px); }
  .today-card:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
  .today-card::before {
    content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 5px;
    background: linear-gradient(180deg, var(--primary), var(--accent));
    opacity: .85;
  }
  .today-date { display: flex; align-items: center; gap: 12px; }
  .today-date .big-day {
    font-size: 56px; line-height: 1; font-weight: 600; color: var(--primary-deep);
    font-family: "Poppins", "Segoe UI", "霞鹜文楷", sans-serif;
    font-variant-numeric: tabular-nums; letter-spacing: -2px;
  }
  .today-date .ym { display: flex; flex-direction: column; gap: 2px; }
  .today-date .ym .year { font-size: 13px; color: var(--muted); letter-spacing: 2px; }
  .today-date .ym .month { font-size: 16px; color: var(--ink); letter-spacing: 1px; }
  .today-body { flex: 1; min-width: 220px; display: flex; flex-direction: column; gap: 8px; }
  .today-fest, .today-events { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .today-fest .chip, .today-events .chip {
    font-size: 12px; padding: 3px 10px; border-radius: 99px; white-space: nowrap;
  }
  .today-fest .chip { background: var(--primary-soft); color: var(--primary-deep); }
  .today-events .chip.ep-anniversary { background: var(--accent-soft); color: var(--accent-deep); }
  .today-events .chip.ep-todo { background: var(--warm-soft); color: #b97a45; }
  .today-events .chip.ep-period { background: var(--period-soft); color: var(--period); }
  .today-events .chip.ep-event { background: var(--primary-soft); color: var(--primary-deep); }
  .today-quiet { font-size: 13px; color: var(--muted); letter-spacing: 1px; }
  .today-quiet em { font-style: normal; color: var(--primary-deep); }
  .today-weather-icon {
    position: absolute; right: 16px; top: 14px; opacity: .7; pointer-events: none;
    color: #e89bb0; transition: color .25s ease, transform .25s ease;
  }
  .today-weather-icon.weather-moon { color: #7893b4; }
  .today-weather-icon.weather-partly { color: #9b9c8a; }
  .today-weather-icon.weather-cloud { color: #86a49f; }
  .today-weather-icon.weather-rain { color: #6f9fb8; }
  .today-weather-icon.weather-snow { color: #8ba9c0; }
  .today-weather-icon.weather-fog { color: #a69186; }
  .today-weather-icon.weather-storm { color: #806c99; }

  /* ── 导航 ── */
  .nav-tabs { display: flex; gap: 6px; margin-bottom: 16px; flex-wrap: wrap; }
  .nav-tabs button {
    border: 1px solid transparent; background: transparent; color: var(--muted);
    font-size: 15px; padding: 7px 18px; border-radius: 99px; cursor: pointer;
    transition: all .18s; letter-spacing: 1px;
  }
  .nav-tabs button:hover { color: var(--primary-deep); background: var(--primary-soft); }
  .nav-tabs button.active {
    background: var(--primary); color: #fff; box-shadow: var(--shadow);
  }

  /* ── 月导航条 ── */
  .month-bar {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    margin-bottom: 12px; padding: 0 2px;
  }
  .month-bar .month-title {
    font-size: 18px; letter-spacing: 2px; min-width: 120px; text-align: center;
    font-weight: 600; color: var(--ink);
  }
  .icon-btn {
    width: 32px; height: 32px; border-radius: 99px;
    border: 1px solid var(--line); background: var(--card); color: var(--primary-deep);
    font-size: 16px; cursor: pointer; transition: all .18s; line-height: 1;
    display: inline-flex; align-items: center; justify-content: center;
  }
  .icon-btn:hover { border-color: var(--primary); box-shadow: var(--shadow); transform: translateY(-1px); }

  /* ── 日历 ── */
  .calendar {
    display: grid; grid-template-columns: repeat(7, 1fr); gap: 7px;
    background: var(--card); padding: 13px;
    border-radius: var(--radius); border: 1px solid var(--line); box-shadow: var(--shadow);
    max-width: 980px; margin: 0 auto;
  }
  .calendar-guide {
    max-width: 980px; margin: 10px auto 0; text-align: center;
    font-size: 13px; color: var(--muted); letter-spacing: 1px;
    padding: 10px 16px; border-radius: 99px; background: var(--primary-soft);
  }
  .cal-head { text-align: center; font-size: 12px; color: var(--muted); padding: 2px 0 6px; letter-spacing: 2px; }
  .cal-head.weekend { color: var(--warm); }
  .cal-head.sunday { color: var(--accent-deep); }
  .cal-day {
    height: 70px; min-height: 0; max-height: 70px;
    border: 1px solid var(--line); border-radius: var(--radius-sm);
    padding: 6px 7px; cursor: pointer; position: relative;
    background: #fffdf9;
    transition: all .16s;
    display: flex; flex-direction: column; align-self: start;
    overflow: hidden;
  }
  .cal-day:hover { border-color: var(--primary); transform: translateY(-2px); box-shadow: var(--shadow); }
  .cal-day.empty { border: none; background: transparent; cursor: default; box-shadow: none; transform: none; }
  .cal-day.today { background: var(--accent-soft); border-color: #f0c7d2; }
  .cal-day.today:hover { border-color: var(--accent); }
  .cal-day.selected {
    border: 2px solid var(--primary-deep); padding: 5px 6px;
    background: #f1faf5;
    box-shadow: 0 0 0 3px rgba(77, 138, 112, 0.16), var(--shadow);
  }
  .cal-day.selected .num { color: var(--primary-deep); font-weight: 700; }
  .cal-day.selected .tags { padding-right: 18px; }
  .cal-day.selected::after {
    content: "✓"; position: absolute; right: 6px; bottom: 6px;
    width: 15px; height: 15px; display: inline-flex; align-items: center; justify-content: center;
    border-radius: 99px; background: var(--primary-deep); color: #fff;
    font: 600 10px/1 "Segoe UI", sans-serif;
  }
  .cal-day.today.selected {
    background: #fff3f5; border-color: var(--accent-deep);
    box-shadow: 0 0 0 3px rgba(201, 111, 135, 0.18), var(--shadow);
  }
  .cal-day.today.selected .num { color: var(--accent-deep); }
  .cal-day.today.selected::after { background: var(--accent-deep); }
  .cal-day .num {
    font-size: 13px; color: var(--muted);
    font-family: "Poppins", "Segoe UI", "霞鹜文楷", sans-serif; font-variant-numeric: tabular-nums;
    display: flex; align-items: center; justify-content: space-between;
  }
  .cal-day .num .weekend-num { color: var(--warm); }
  .cal-day.today .num { color: var(--accent-deep); font-weight: 700; }
  .cal-day .today-tag {
    font-size: 9px; color: var(--accent-deep); background: var(--accent);
    color: #fff; border-radius: 99px; padding: 1px 6px; font-weight: 400; letter-spacing: 1px;
  }
  .cal-day .sum-tag {
    font-size: 10px; color: var(--primary-deep); opacity: .8;
    line-height: 1; padding-right: 1px;
  }
  .cal-day.today .sum-tag { color: var(--primary-deep); opacity: .95; }
  .cal-day .tags {
    margin-top: auto; display: flex; flex-direction: column; gap: 2px;
    min-height: 0; max-height: 40px; overflow: hidden;
  }
  .cal-day .tag {
    font-size: 10px; padding: 0 6px; border-radius: 6px; line-height: 1.15;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .cal-day .tag.builtin { background: var(--primary-soft); color: var(--primary-deep); }
  .cal-day .tag.todo { background: var(--warm-soft); color: #b97a45; }
  .cal-day .tag.period { background: var(--period-soft); color: var(--period); }
  .cal-day .tag.period.predicted { background: transparent; border: 1px dashed #e3b7be; color: #b88790; }
  .cal-day .tag.anniversary { background: var(--accent-soft); color: var(--accent-deep); }
  .cal-day .tag.event { background: var(--primary-soft); color: var(--primary-deep); }
  .cal-day .tag.more { color: var(--muted); background: #f3ede1; }
  .cal-day .period-dot {
    display: inline-block; width: 6px; height: 6px; border-radius: 99px;
    background: var(--period); margin-left: 2px; vertical-align: 1px;
  }

  /* ── 详情面板 ── */
  .detail {
    background: var(--card); border: 1px solid var(--line);
    border-radius: var(--radius); padding: 18px 20px; margin-top: 14px;
    box-shadow: var(--shadow);
  }
  .detail-head {
    display: flex; align-items: baseline; gap: 10px; margin-bottom: 12px;
    border-bottom: 1px solid var(--line); padding-bottom: 10px;
  }
  .detail-head h3 { font-size: 17px; letter-spacing: 1px; }
  .detail-head .wk { font-size: 13px; color: var(--muted); }
  .detail .empty { color: var(--muted); font-size: 13px; line-height: 1.8; }
  .fest-row { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
  .fest-chip {
    font-size: 12px; padding: 3px 10px; border-radius: 99px;
    background: var(--primary-soft); color: var(--primary-deep);
  }
  .fest-chip.legal { background: #e3f0ea; color: #3f7d63; }
  .workday-note { font-size: 12px; color: #b97a45; background: var(--warm-soft); border-radius: 8px; padding: 5px 10px; margin-bottom: 12px; display: inline-block; }
  .event-row {
    display: flex; align-items: center; gap: 10px;
    padding: 9px 4px; border-bottom: 1px dashed var(--line);
  }
  .event-row:last-child { border-bottom: none; }
  .event-row .bar { width: 3px; height: 22px; border-radius: 99px; flex: none; }
  .event-row .bar.b-event { background: var(--primary); }
  .event-row .bar.b-anniversary { background: var(--accent); }
  .event-row .bar.b-todo { background: var(--warm); }
  .event-row .bar.b-period { background: var(--period); }
  .event-row .type { font-size: 11px; padding: 2px 7px; border-radius: 6px; flex: none; }
  .event-row .type.t-event { background: var(--primary-soft); color: var(--primary-deep); }
  .event-row .type.t-anniversary { background: var(--accent-soft); color: var(--accent-deep); }
  .event-row .type.t-todo { background: var(--warm-soft); color: #b97a45; }
  .event-row .type.t-period { background: var(--period-soft); color: var(--period); }
  .event-row .title { flex: 1; font-size: 14px; }
  .event-row .title .note { color: var(--muted); font-size: 12px; margin-left: 6px; }
  .event-row .title .todo-time {
    display: inline-block; margin-left: 7px; padding: 2px 6px; border-radius: 6px;
    background: var(--warm-soft); color: #b97a45; font-size: 11px; white-space: nowrap;
  }
  .event-row .title .todo-time.missing { color: #b88790; background: #fdf0f2; }
  .event-row .del {
    border: none; background: none; color: #c9bfae; cursor: pointer;
    font-size: 13px; padding: 4px 8px; min-width: 30px; min-height: 30px; border-radius: 99px; transition: all .15s;
  }
  .event-row .del:hover { color: var(--accent-deep); background: var(--accent-soft); }

  /* ── 生理期快捷区 ── */
  .period-quick {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    background: var(--period-soft); border: 1px solid rgba(217, 138, 150, 0.35);
    border-radius: 12px; padding: 9px 12px; margin-bottom: 12px;
  }
  .period-quick.on { background: #fdf0f2; }
  .period-quick .pq-dot {
    width: 8px; height: 8px; border-radius: 99px; background: var(--period); flex: none;
    box-shadow: 0 0 0 3px rgba(217, 138, 150, 0.18);
  }
  .period-quick .pq-text { font-size: 13px; color: #a05b66; flex: 1; }
  .period-quick .pq-text b { font-size: 16px; font-family: "Poppins", "Segoe UI", sans-serif; }
  .period-quick .pq-btn {
    border: 1px solid rgba(217, 138, 150, 0.4); background: #fff; color: #a05b66;
    font-size: 12px; padding: 4px 12px; border-radius: 99px; cursor: pointer; transition: all .15s;
  }
  .period-quick .pq-btn:hover { background: var(--period-soft); border-color: var(--period); }
  .period-quick .pq-btn.primary { background: var(--period); border-color: var(--period); color: #fff; }
  .period-quick .pq-btn.primary:hover { background: #cf7a87; }
  .period-quick .pq-picker { display: inline-flex; gap: 6px; align-items: center; }
  .period-quick .pq-picker.hidden { display: none; }
  .period-quick .pq-picker input[type="date"] {
    font-family: inherit; border: 1px solid rgba(217, 138, 150, 0.4); border-radius: 8px;
    padding: 3px 8px; font-size: 12px; background: #fff; color: var(--ink);
  }

  /* ── 类型快捷标签 ── */
  .type-tabs { display: inline-flex; gap: 4px; flex-wrap: wrap; }
  .type-tab {
    border: 1px solid var(--line); background: #fff; color: var(--muted);
    font-size: 12px; padding: 6px 12px; border-radius: 99px; cursor: pointer; transition: all .15s; white-space: nowrap;
  }
  .type-tab:hover { border-color: var(--primary); color: var(--primary-deep); }
  .type-tab.active { background: var(--primary-soft); border-color: var(--primary); color: var(--primary-deep); font-weight: 500; }
  .type-tab:disabled { opacity: .5; cursor: default; }
  .type-tab:disabled:hover { border-color: var(--line); color: var(--muted); }
  .type-tip {
    flex-basis: 100%; font-size: 12px; color: var(--muted); letter-spacing: .5px;
    padding: 4px 2px 0; line-height: 1.6;
  }

  /* ── 待办勾选 ── */
  .todo-check {
    width: 18px; height: 18px; border-radius: 99px; border: 2px solid #d8c9b4;
    background: #fff; cursor: pointer; flex: none; position: relative; transition: all .15s;
  }
  .todo-check:hover { border-color: var(--warm); }
  .todo-check.checked { background: var(--warm); border-color: var(--warm); }
  .todo-check.checked::after {
    content: ""; position: absolute; left: 5px; top: 2px; width: 4px; height: 8px;
    border: solid #fff; border-width: 0 2px 2px 0; transform: rotate(45deg);
  }
  .event-row.done .title { color: #b7ab97; text-decoration: line-through; }
  .event-row.done .type { opacity: .6; }

  .add-form { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; align-items: center; }
  .add-form input {
    font-family: inherit; border: 1px solid var(--line); border-radius: 10px;
    padding: 8px 12px; font-size: 13px; background: #fff; color: var(--ink);
    flex: 1; min-width: 140px; transition: border-color .15s;
  }
  .add-form input:focus { outline: none; border-color: var(--primary); }
  .add-form input::placeholder { color: #c9bfae; }
  .add-date-note { color: var(--muted); font-size: 12px; white-space: nowrap; }
  .add-date-note.past-note { color: #b88790; white-space: normal; }
  .todo-reminder {
    flex-basis: 100%; display: flex; align-items: center; gap: 7px; flex-wrap: wrap;
    padding: 8px 10px; background: var(--warm-soft);
    border: 1px solid rgba(203, 157, 101, 0.32); border-radius: 12px;
  }
  .todo-reminder.hidden { display: none; }
  .todo-reminder-label { color: #a96f3f; font-size: 12px; font-weight: 600; }
  .todo-time-label { color: var(--muted); font-size: 11px; white-space: nowrap; }
  .todo-time-input {
    width: 86px; margin-left: 3px; padding: 5px 7px; font: 12px "Poppins", "Segoe UI", sans-serif;
    color: var(--ink); background: #fff; border: 1px solid rgba(203, 157, 101, 0.4); border-radius: 8px;
  }
  .add-form .todo-time-input { flex: none; min-width: 0; }
  .todo-time-input:focus { outline: none; border-color: var(--warm); }
  .todo-time-sep { color: #b97a45; font-size: 12px; }
  .todo-time-preview { color: #b97a45; font-size: 11px; line-height: 1.5; }
  .todo-time-error {
    flex-basis: 100%; color: #b26d78; font-size: 12px; line-height: 1.5; padding: 0 2px;
  }
  .todo-time-error.hidden { display: none; }
  .btn {
    border: 1px solid var(--line); background: var(--card); color: var(--ink);
    padding: 7px 16px; border-radius: 10px; cursor: pointer; font-size: 13px;
    transition: all .15s;
  }
  .btn:hover { border-color: var(--primary); color: var(--primary-deep); }
  .btn.primary { background: var(--primary); color: #fff; border-color: var(--primary); }
  .btn.primary:hover { background: #6daa90; color: #fff; transform: translateY(-1px); box-shadow: var(--shadow); }
  .btn:disabled { opacity: .55; cursor: default; transform: none; box-shadow: none; }

  /* ── 时光册页面 ── */
  .summary-msg { color: var(--muted); font-size: 13px; }
  .summary-batch { margin: 14px auto 0; padding: 12px 14px; background: var(--primary-soft); border: 1px solid #cfe5d8; border-radius: 14px; max-width: 760px; }
  .summary-batch.hidden { display: none; }
  .summary-batch-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
  .summary-batch-title { color: var(--primary-deep); font-size: 14px; font-weight: 700; }
  .summary-batch-tip { color: var(--muted); font-size: 12px; }
  .summary-batch-dates { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-height: 26px; }
  .summary-batch-dates.empty { color: var(--muted); font-size: 12px; }
  .summary-batch-chip { display: inline-flex; align-items: center; gap: 5px; padding: 4px 8px 4px 10px; border: 1px solid #b9d9c6; border-radius: 99px; background: #fff; color: var(--primary-deep); font: 12px "Poppins", "Segoe UI", sans-serif; }
  .summary-batch-chip button { border: none; background: none; color: var(--muted); padding: 0; cursor: pointer; font-size: 15px; line-height: 1; }
  .summary-batch-actions { position: sticky; bottom: 0; display: flex; align-items: center; justify-content: flex-end; gap: 7px; flex-wrap: wrap; margin-top: 9px; padding-top: 7px; background: var(--primary-soft); }
  .summary-batch-count { color: var(--muted); font-size: 12px; margin-right: auto; }
  .summary-batch-actions .btn { padding: 5px 11px; }
  .summary-batch-toggle { margin-left: auto; white-space: nowrap; }
  .cal-day.batch-selected { border: 2px solid var(--primary-deep); padding: 5px 6px; background: #f1faf5; box-shadow: 0 0 0 3px rgba(77, 138, 112, 0.16), var(--shadow); }
  .cal-day.batch-selected .num { color: var(--primary-deep); font-weight: 700; }
  .cal-day.batch-selected::after { content: "✓"; position: absolute; right: 6px; bottom: 6px; width: 15px; height: 15px; display: inline-flex; align-items: center; justify-content: center; border-radius: 99px; background: var(--primary-deep); color: #fff; font: 600 10px/1 "Segoe UI", sans-serif; }
  .cal-day.batch-disabled { opacity: .42; cursor: default; }
  .cal-day.batch-disabled:hover { border-color: var(--line); box-shadow: none; transform: none; }
  @media (max-width: 560px) {
    .calendar { gap: 4px; padding: 8px; }
    .cal-day { height: 58px; min-height: 0; max-height: 58px; padding: 5px 4px; border-radius: 10px; }
    .cal-day .tags { max-height: 34px; }
    .cal-day .num { font-size: 12px; }
    .cal-day .today-tag { font-size: 8px; padding: 1px 3px; letter-spacing: 0; }
    .cal-day .tag { font-size: 9px; padding: 1px 3px; }
    .cal-day .tag.more { display: none; }
    .cal-day.selected, .cal-day.batch-selected { padding: 4px 3px; }
    .cal-day.selected .tags { padding-right: 14px; }
    .cal-day.selected::after, .cal-day.batch-selected::after { right: 3px; bottom: 3px; width: 13px; height: 13px; }
    .month-bar .month-title { min-width: 96px; font-size: 16px; }
    .summary-batch-actions { justify-content: flex-start; }
    .summary-batch-count { width: 100%; margin-right: 0; }
    .todo-reminder { gap: 6px; }
    .todo-time-input { width: 78px; }
    .todo-time-preview { flex-basis: 100%; margin-left: 2px; }
  }
  @media (max-width: 380px) {
    .todo-reminder { flex-direction: column; align-items: flex-start; gap: 4px; }
    .todo-time-preview { flex-basis: auto; margin-left: 0; }
    .todo-time-sep { margin-left: 18px; }
  }
  .summary-overview { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin: 0 0 14px; }
  .summary-overview-title { font-size: 20px; color: var(--primary-deep); letter-spacing: 2px; }
  .summary-overview-tip { color: var(--muted); font-size: 13px; }
  .summary-jobs { margin: 0 0 16px; padding: 11px 14px; border: 1px solid var(--line); border-radius: 14px; background: var(--card); }
  .summary-jobs.hidden { display: none; }
  .summary-job-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; color: var(--primary-deep); font-size: 13px; font-weight: 700; }
  .summary-job-status { color: var(--muted); font-size: 12px; font-weight: 400; }
  .summary-job-track { height: 7px; margin: 9px 0 6px; border-radius: 99px; background: #e9efe9; overflow: hidden; }
  .summary-job-progress { height: 100%; border-radius: inherit; background: var(--primary); transition: width .25s ease; }
  .summary-job-detail { color: var(--muted); font-size: 12px; line-height: 1.6; }
  .summary-job-error { margin-top: 3px; color: var(--accent-deep); font-size: 12px; }
  .summary-job-failed { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; }
  .summary-job-failed-item { font-size: 12px; color: var(--muted); line-height: 1.5; }
  .summary-job-failed-item::before { content: '✗ '; color: var(--accent-deep); }
  .summary-job-retry-btn { margin-top: 8px; }
  .summary-job-dismiss-btn { margin-top: 8px; }
  .archive { display: flex; flex-direction: column; gap: 10px; }
  /* 按月 → 按天 → 按助手 三级分组：天的小节标题（像日记本翻页） */
  .day-title {
    display: flex; align-items: center; gap: 8px;
    margin: 8px 2px 2px; padding: 6px 2px 4px;
    border-bottom: 1px solid var(--line);
  }
  .day-title::before {
    content: ''; width: 4px; height: 14px; border-radius: 2px;
    background: var(--primary); flex-shrink: 0;
  }
  .day-title .day-date {
    font-size: 15px; font-weight: 600; color: var(--ink);
    letter-spacing: 1px; font-variant-numeric: tabular-nums;
    font-family: "Poppins", "Segoe UI", sans-serif;
  }
  .day-title .day-label {
    font-size: 12px; color: var(--muted); letter-spacing: 2px;
  }
  .archive-item {
    background: var(--card); border: 1px solid var(--line); border-radius: var(--radius);
    padding: 14px 18px; box-shadow: var(--shadow); transition: all .16s;
  }
  .archive-item:hover { box-shadow: var(--shadow-up); transform: translateY(-1px); }
  .archive-item .a-date {
    display: inline-block; font-size: 12px; color: #fff; background: var(--primary);
    border-radius: 99px; padding: 2px 12px; margin-bottom: 8px; letter-spacing: 1px;
    font-family: "Poppins", "Segoe UI", sans-serif; font-variant-numeric: tabular-nums;
  }
  .archive-item .a-agent { display: inline-block; margin: 0 0 8px 6px; padding: 2px 9px; border-radius: 99px; background: var(--primary-soft); color: var(--primary-deep); font-size: 12px; }
  .archive-item .a-agent.legacy { background: #f3eee5; color: var(--muted); }
  .archive-item .a-text { font-size: 14px; line-height: 1.9; color: #5a5549; }
  .archive-actions { display: flex; gap: 7px; margin-top: 10px; flex-wrap: wrap; }
  .archive-actions button { border: none; background: var(--primary-soft); color: var(--primary-deep); padding: 4px 10px; border-radius: 99px; cursor: pointer; font-family: inherit; }
  .archive-actions button.danger { background: var(--accent-soft); color: var(--accent-deep); }
  .archive-editor { width: 100%; min-height: 92px; border: 1px solid var(--line); border-radius: 10px; padding: 10px; font: inherit; color: var(--ink); background: #fff; resize: vertical; }
  .archive-empty {
    background: var(--card); border: 1px dashed var(--line); border-radius: var(--radius);
    padding: 34px 20px; text-align: center; color: var(--muted); font-size: 13px; line-height: 2;
  }

  /* ── 详情面板内的这一页区块 ── */
  .sum-block {
    margin-top: 14px; background: var(--card); border: 1px solid var(--line);
    border-radius: 12px; padding: 12px 14px; box-shadow: var(--shadow);
  }
  .sum-block.empty { background: transparent; border: 1px dashed var(--line); box-shadow: none; }
  .sum-block .sum-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
  .sum-block .sum-actions { display: flex; align-items: center; gap: 2px; flex-wrap: wrap; justify-content: flex-end; }
  .sum-block .sum-title { font-size: 13px; font-weight: 700; color: var(--primary-deep); }
  .sum-block .sum-link { border: none; background: none; color: var(--primary-deep); font-size: 12px; cursor: pointer; font-family: inherit; padding: 2px 6px; border-radius: 6px; }
  .sum-block .sum-link:hover { background: var(--primary-soft); }
  .sum-block .sum-text {
    font-size: 13px; color: var(--ink); line-height: 1.85; white-space: pre-wrap;
    max-height: 220px; overflow-y: auto;
  }
  .sum-agent + .sum-agent { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line); }
  .sum-agent-name { display: block; margin-bottom: 4px; color: var(--primary-deep); font-size: 12px; font-weight: 700; }
  .sum-block .sum-text.muted { color: var(--muted); }
  .sum-block .sum-msg { display: inline-block; margin-left: 8px; font-size: 12px; color: var(--muted); }
  .sum-block .sum-preview {
    margin-top: 10px; white-space: pre-wrap; background: var(--primary-soft);
    border-radius: 10px; padding: 10px 12px; color: var(--primary-deep); font-size: 12px; line-height: 1.7;
  }
  .sum-block .sum-preview.hidden { display: none; }
  .archive-empty b { color: var(--primary-deep); font-weight: 500; }

  /* ── 和小花聊聊：对话式修订小窗 ── */
  .summary-chat-panel {
    position: relative; width: min(520px, calc(100vw - 28px)); height: min(650px, 84vh);
    background: var(--card); border-radius: 22px;
    box-shadow: 0 18px 54px rgba(60, 45, 25, 0.26); overflow: hidden;
    display: flex; flex-direction: column;
  }
  .summary-chat-head { flex: 0 0 auto; align-items: flex-start; }
  .summary-chat-heading { min-width: 0; }
  .summary-chat-subtitle { display: block; margin-top: 3px; color: var(--muted); font-size: 11px; letter-spacing: 0; }
  .summary-chat-context {
    flex: 0 0 auto; position: relative; z-index: 2;
    margin: 10px 16px 0; padding: 7px 10px; border: 1px solid var(--line); border-radius: 10px;
    color: var(--muted); font-size: 11px; background: var(--card);
  }
  .summary-chat-context summary { cursor: pointer; color: var(--primary-deep); }
  .summary-chat-original { margin-top: 7px; max-height: 82px; overflow-y: auto; white-space: pre-wrap; line-height: 1.65; color: var(--ink); }
  .summary-chat-messages {
    flex: 1 1 auto; min-height: 0; overflow-y: auto;
    padding: 14px 16px; display: flex; flex-direction: column; gap: 9px;
  }
  .summary-chat-bubble {
    max-width: 84%; padding: 9px 12px; border-radius: 14px;
    font-size: 13px; line-height: 1.65; white-space: pre-wrap; word-break: break-word;
  }
  .summary-chat-bubble.assistant { align-self: flex-start; background: var(--primary-soft); color: var(--primary-deep); border-bottom-left-radius: 5px; }
  .summary-chat-bubble.user { align-self: flex-end; background: #f5e8dd; color: var(--ink); border-bottom-right-radius: 5px; }
  .summary-chat-bubble.thinking { align-self: flex-start; color: var(--muted); background: #f4f0e9; }
  .summary-chat-bubble.error { align-self: flex-start; color: var(--accent-deep); background: var(--accent-soft); }
  .summary-chat-suggestion {
    flex: 0 1 42%; min-height: 0; margin: 0 16px 10px; padding: 11px 12px;
    border: 1px solid #b9d7c8; border-radius: 14px; background: #f2faf6;
    display: flex; flex-direction: column; gap: 8px; overflow: hidden;
  }
  .summary-chat-suggestion[hidden] { display: none; }
  .summary-chat-suggestion-title { color: var(--primary-deep); font-size: 13px; font-weight: 700; }
  .summary-chat-diff { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: grid; gap: 7px; }
  .summary-chat-version { padding: 8px 9px; border-radius: 9px; background: rgba(255,255,255,.72); }
  .summary-chat-version b { display: block; margin-bottom: 4px; color: var(--muted); font-size: 11px; }
  .summary-chat-version.after b { color: var(--primary-deep); }
  .summary-chat-version-text { color: var(--ink); font-size: 12px; line-height: 1.65; white-space: pre-wrap; }
  .summary-chat-suggestion-actions { display: flex; justify-content: flex-end; gap: 8px; padding-top: 2px; }
  .summary-chat-composer { padding: 11px 16px 14px; border-top: 1px solid var(--line); background: var(--card); }
  .summary-chat-composer-row { display: flex; gap: 8px; align-items: flex-end; }
  .summary-chat-input {
    flex: 1; min-height: 42px; max-height: 96px; resize: none;
    border: 1px solid var(--line); border-radius: 12px; padding: 9px 11px;
    background: #fff; color: var(--ink); font: inherit; font-size: 13px; line-height: 1.5;
  }
  .summary-chat-input:focus { outline: none; border-color: var(--primary); }
  .summary-chat-hint { margin-top: 5px; color: var(--muted); font-size: 10px; }

  /* ── 设置弹窗（无边框 + 柔和阴影，内部 1px 细线分隔） ── */
  .set-modal { position: fixed; inset: 0; z-index: 9999; display: flex; align-items: center; justify-content: center; }
  .set-modal[hidden] { display: none; }
  .set-modal-mask { position: absolute; inset: 0; background: rgba(58, 48, 36, 0.42); backdrop-filter: blur(2px); }
  .set-modal-panel {
    position: relative;
    width: min(460px, calc(100vw - 40px));
    max-height: 84vh;
    display: flex; flex-direction: column;
    background: var(--card);
    border-radius: 22px;
    box-shadow: 0 18px 54px rgba(60, 45, 25, 0.26);
    overflow: hidden;
  }
  .set-modal-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 15px 20px;
    border-bottom: 1px solid var(--line);
  }
  .set-modal-title { font-size: 16px; font-weight: 600; letter-spacing: 2px; }
  .set-modal-close {
    border: none; background: none; font-size: 22px; line-height: 1;
    color: var(--muted); cursor: pointer; padding: 2px 8px; border-radius: 99px; transition: all .15s;
  }
  .set-modal-close:hover { color: var(--accent-deep); background: var(--accent-soft); }
  .set-modal-body {
    padding: 16px 20px 20px;
    overflow-y: auto;
    display: flex; flex-direction: column; gap: 16px;
  }
  .set-group {
    border: 1px solid var(--line); border-radius: 16px; padding: 14px 16px;
  }
  .set-group h3 { font-size: 15px; letter-spacing: 1px; margin-bottom: 4px; }
  .set-desc { font-size: 12px; color: var(--muted); margin-bottom: 10px; line-height: 1.7; }
  .set-row { display: flex; align-items: center; gap: 12px; padding: 6px 0; font-size: 14px; flex-wrap: wrap; }
  .set-label { width: 86px; flex: none; color: var(--ink); }
  .set-tip { font-size: 12px; color: var(--muted); line-height: 1.6; }
  /* 检查更新 / 反馈：左右双栏并排，中间细竖线分隔；窄屏回退上下堆叠 */
  .uc-fb-cols { display: flex; align-items: stretch; gap: 0; }
  .uc-fb-col { flex: 1 1 0; min-width: 0; padding: 2px 0; }
  .uc-fb-col + .uc-fb-col { padding-left: 16px; }
  .uc-fb-divider { width: 1px; flex: none; background: var(--line); margin: 4px 16px; }
  .uc-fb-body { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; min-height: 30px; }
  .uc-fb-note { font-size: 12px; color: var(--muted); line-height: 1.6; margin-top: 8px; }
  @media (max-width: 520px) {
    .uc-fb-cols { flex-direction: column; }
    .uc-fb-divider { width: auto; height: 1px; margin: 10px 0; }
    .uc-fb-col + .uc-fb-col { padding-left: 0; }
  }
  .summary-agent-picker { flex: 1 1 360px; min-width: 220px; }
  .summary-agent-options { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px; }
  .summary-agent-option {
    display: flex; align-items: center; gap: 7px; min-width: 0;
    border: 1px solid var(--line); border-radius: 10px; padding: 7px 9px;
    background: var(--card); color: var(--ink); font-size: 12px; cursor: pointer;
  }
  .summary-agent-option:hover { border-color: var(--primary); background: var(--primary-soft); }
  .summary-agent-option input { flex: none; accent-color: var(--primary); }
  .summary-agent-option span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .summary-agent-actions { display: flex; gap: 12px; margin-top: 7px; }
  .set-input, .set-select {
    font-family: inherit; border: 1px solid var(--line);
    border-radius: 10px; padding: 7px 11px; font-size: 13px;
    background: #fff; color: var(--ink); flex: 1; min-width: 130px;
  }
  .set-input:focus, .set-select:focus { outline: none; border-color: var(--primary); }
  .weather-region-selects {
    flex: 1 1 360px; min-width: 250px; display: flex; gap: 8px; flex-wrap: wrap;
  }
  .weather-region-field {
    flex: 1 1 105px; min-width: 100px; display: flex; flex-direction: column; gap: 4px;
    color: var(--muted); font-size: 11px;
  }
  .weather-region-field .dd { width: 100%; max-width: none; }
  .weather-region-field .dd-trigger { width: 100%; }
  .weather-region-field .dd-trigger:disabled,
  .weather-region-field .dd.disabled .dd-trigger { opacity: .52; cursor: not-allowed; }
  .weather-clear-btn { flex: none; align-self: flex-end; }
  .seg { display: inline-flex; gap: 6px; }
  .seg-btn {
    font-family: inherit;
    border: 1px solid var(--line); background: var(--card);
    color: var(--muted); padding: 5px 15px; border-radius: 99px;
    font-size: 13px; cursor: pointer; transition: all .15s;
  }
  .seg-btn:hover { border-color: var(--primary); color: var(--primary-deep); }
  .seg-btn.active { background: var(--primary); border-color: var(--primary); color: #fff; box-shadow: var(--shadow); }
  .save-btn { margin-top: 8px; }
  .link-btn {
    border: none; background: none; padding: 0; font-size: 12px;
    color: var(--warm); text-decoration: underline; cursor: pointer;
  }
  .link-btn:hover { color: #b97a45; }
  /* 模型配置 */
  .mc-current {
    margin-bottom: 12px; padding: 9px 13px;
    border-left: 3px solid var(--primary);
    background: var(--primary-soft); border-radius: 10px;
    font-size: 13px; color: var(--primary-deep);
  }
  .mc-sources { display: flex; gap: 6px; margin-bottom: 12px; }
  .mc-source-btn {
    font-family: inherit; flex: 1;
    border: 1px solid var(--line); background: var(--card);
    color: var(--muted); padding: 8px 0; border-radius: 10px;
    font-size: 13px; cursor: pointer; transition: all .15s;
  }
  .mc-source-btn:hover { border-color: var(--primary); color: var(--primary-deep); }
  .mc-source-btn.active {
    background: var(--primary-soft); border-color: var(--primary); color: var(--primary-deep); font-weight: 600;
  }
  .mc-actions {
    display: flex; align-items: center; gap: 10px;
    margin-top: 14px; padding-top: 13px; border-top: 1px solid var(--line); flex-wrap: wrap;
  }
  .mc-actions .spacer { flex: 1; }
  .mc-hana-fields { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; }
  .mc-hana-fields .mc-field { flex: 1 1 170px; min-width: 140px; max-width: 220px; font-size: 12px; color: var(--muted); }
  .mc-hana-fields .dd { width: 100%; }
  .mc-hana-fields .dd-trigger { min-height: 34px; padding: 6px 10px; font-size: 13px; }
  .set-row .dd { flex: 1; max-width: 220px; }
  .set-row .weather-region-field .dd { max-width: none; }

  /* ── 滚动条（细薄荷圆条） ── */
  *::-webkit-scrollbar { width: 8px; height: 8px; }
  *::-webkit-scrollbar-track { background: transparent; }
  *::-webkit-scrollbar-thumb { background: #c9dfd3; border-radius: 99px; border: 2px solid var(--bg); }
  *::-webkit-scrollbar-thumb:hover { background: var(--primary); }
  * { scrollbar-width: thin; scrollbar-color: #c9dfd3 transparent; }
  .set-modal-body::-webkit-scrollbar-thumb { border-color: var(--card); }
  .settings-save-sticky { position: sticky; bottom: 0; z-index: 8; width: 100%; padding: 10px 16px; box-shadow: 0 -8px 18px rgba(96, 74, 40, .08); }

  .hidden { display: none !important; }
  .toast {
    position: fixed; bottom: 26px; left: 50%; transform: translateX(-50%);
    background: var(--ink); color: #fff; padding: 10px 22px;
    border-radius: 12px; font-size: 13px; opacity: 0;
    transition: opacity .3s; pointer-events: none; z-index: 99999;
    box-shadow: 0 8px 24px rgba(0,0,0,.18); letter-spacing: 1px;
  }
  .toast.show { opacity: 1; }
  ${bsCss}
  ${ucCss}
  ${fbCss}
  /* 反馈弹窗盖在设置弹窗之上（z-index 提升一层） */
  .fb-modal { z-index: 10001; }
</style>
</head>
<body>

<!-- 头部 -->
<div class="header">
  <div class="brand">
    <h1>拾光记</h1>
    <span class="sub">捡拾起每一天的光</span>
  </div>
  <div class="header-actions">
    <button class="go-today-btn" onclick="goToday()">回到今天</button>
    <button class="context-toggle-btn" id="context-toggle-btn" onclick="toggleInjectionQuick()" aria-pressed="true">情境注入·开</button>
    <button class="settings-btn" onclick="openSettingsModal()">设置</button>
  </div>
</div>

<!-- 今日概览：整体可点击，点了展开今天详情（记一笔的替代入口） -->
<section class="today-card" id="today-card" role="button" tabindex="0" onclick="goToday()" onkeydown="if(event.key==='Enter'||event.key===' '){goToday()}">
  <svg id="today-weather-icon" class="today-weather-icon weather-sun" width="46" height="46" viewBox="0 0 46 46" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-label="当前天气">
    <circle cx="23" cy="23" r="7" fill="currentColor" opacity=".18"/>
    <path d="M23 5v5M23 36v5M5 23h5M36 23h5M10.5 10.5l3.5 3.5M32 32l3.5 3.5M35.5 10.5L32 14M14 32l-3.5 3.5"/>
  </svg>
  <div class="today-date">
    <span class="big-day" id="today-bigday">--</span>
    <div class="ym">
      <span class="year" id="today-year"></span>
      <span class="month" id="today-month"></span>
    </div>
  </div>
  <div class="today-body">
    <div class="today-fest" id="today-fest"></div>
    <div class="today-events" id="today-events"></div>
    <div class="today-quiet hidden" id="today-weather"></div>
    <div class="today-quiet hidden" id="today-quiet">今天没什么特别的日子，但也是好日子<em> ✿</em></div>
  </div>
</section>

<!-- 导航 -->
<div class="nav-tabs">
  <button id="tab-calendar" class="active" onclick="switchTab('calendar')">日历</button>
  <button id="tab-summary" onclick="switchTab('summary')">时光册</button>
</div>

<!-- 日历页 -->
<div id="panel-calendar">
  <div class="month-bar">
    <button class="icon-btn" onclick="shiftMonth(-1)" title="上个月">‹</button>
    <span class="month-title" id="month-title"></span>
    <button class="icon-btn" onclick="shiftMonth(1)" title="下个月">›</button>
    <button class="btn summary-batch-toggle" id="summary-batch-toggle" onclick="toggleSummaryBatchMode()">选几天做成册</button>
  </div>
  <div class="calendar" id="calendar"></div>
  <div class="calendar-guide hidden" id="calendar-guide">点任意日期，记下那天的事 ✿</div>
  <div class="summary-batch hidden" id="summary-batch-panel">
    <div class="summary-batch-head">
      <span class="summary-batch-title">选几天做成册</span>
      <span class="summary-batch-tip">只处理已经结束的日子；还没翻篇的昨天和以后的日子选不了。点日期可以反复选择。</span>
    </div>
    <div class="summary-batch-dates empty" id="summary-batch-dates">还没选日期</div>
    <div class="summary-batch-actions">
      <span class="summary-batch-count" id="summary-batch-count">已选 0 天</span>
      <span class="summary-msg" id="summary-batch-msg"></span>
      <button class="btn" onclick="clearSummaryBatchDates()">清空</button>
      <button class="btn primary" id="summary-batch-run-btn" onclick="runSummaryBatch()">做成册</button>
      <button class="btn" onclick="toggleSummaryBatchMode(false)">取消</button>
    </div>
  </div>
  <div class="summary-jobs hidden" id="summary-jobs-calendar"></div>
  <div class="detail hidden" id="detail">
    <div class="detail-head">
      <h3 id="detail-title">点一个日子看看</h3>
      <span class="wk" id="detail-wk"></span>
    </div>
    <div id="detail-body" class="empty">选一天，看看那天有什么好日子。</div>
  </div>
</div>

<!-- 时光册页：整体浏览与管理已经做好的页面 -->
<div id="panel-summary" class="hidden">
  <div class="summary-overview">
    <div>
      <h2 class="summary-overview-title">时光册</h2>
      <span class="summary-overview-tip">一天一页，几天成册；已经做好的时光都放在这里。</span>
    </div>
    <button class="btn" onclick="switchTab('calendar')">回到日历</button>
  </div>
  <div class="summary-jobs hidden" id="summary-jobs"></div>
  <p class="set-tip">这里可以翻看、编辑和管理每一天的页面；想新做一页，回到日历点选日期。</p>
  <div class="archive" id="summaries-list"></div>
</div>

<div class="toast" id="toast"></div>

<div class="set-modal" id="confirm-modal" hidden>
  <div class="set-modal-mask" onclick="closeConfirm()"></div>
  <div class="set-modal-panel" style="max-width:420px;height:auto;max-height:none">
    <div class="set-modal-head"><span class="set-modal-title">确认一下</span><button class="set-modal-close" onclick="closeConfirm()">×</button></div>
    <div class="set-modal-body">
      <p id="confirm-text" style="line-height:1.8"></p>
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button class="btn" onclick="closeConfirm()">取消</button>
        <button class="btn primary" onclick="confirmYes()">确定</button>
      </div>
    </div>
  </div>
</div>

<!-- 对话式修订：自然语言聊清楚 → 建议预览 → 用户确认后才落库 -->
<div class="set-modal" id="summary-chat-modal" hidden>
  <div class="set-modal-mask"></div>
  <div class="summary-chat-panel" role="dialog" aria-modal="true" aria-labelledby="summary-chat-title">
    <div class="set-modal-head summary-chat-head">
      <div class="summary-chat-heading">
        <span class="set-modal-title" id="summary-chat-title">和小花聊聊这一页</span>
        <span class="summary-chat-subtitle" id="summary-chat-subtitle"></span>
      </div>
      <button class="set-modal-close" onclick="closeSummaryChat()" title="关闭">×</button>
    </div>
    <details class="summary-chat-context">
      <summary>看看当前这一页</summary>
      <div class="summary-chat-original" id="summary-chat-original"></div>
    </details>
    <div class="summary-chat-messages" id="summary-chat-messages"></div>
    <div class="summary-chat-suggestion" id="summary-chat-suggestion" hidden>
      <div class="summary-chat-suggestion-title">我们说好的修改建议</div>
      <div class="summary-chat-diff">
        <div class="summary-chat-version"><b>修改前</b><div class="summary-chat-version-text" id="summary-chat-before"></div></div>
        <div class="summary-chat-version after"><b>修改后</b><div class="summary-chat-version-text" id="summary-chat-after"></div></div>
      </div>
      <div class="summary-chat-suggestion-actions">
        <button class="btn" onclick="continueSummaryChat()">继续聊聊</button>
        <button class="btn primary" id="summary-chat-confirm" onclick="confirmSummaryChat()">确认修改</button>
      </div>
    </div>
    <div class="summary-chat-composer">
      <div class="summary-chat-composer-row">
        <textarea class="summary-chat-input" id="summary-chat-input" maxlength="1000" placeholder="告诉小花哪里不对、想怎么改…"></textarea>
        <button class="btn primary" id="summary-chat-send" onclick="sendSummaryChat()">发送</button>
      </div>
      <div class="summary-chat-hint">Enter 发送，Shift + Enter 换行；没点确认前不会修改。</div>
    </div>
  </div>
</div>

<!-- 设置弹窗（二级弹窗） -->
<div class="set-modal" id="set-modal" hidden>
  <div class="set-modal-mask" onclick="closeSettingsModal()"></div>
  <div class="set-modal-panel">
    <div class="set-modal-head">
      <span class="set-modal-title">设置</span>
      <button class="set-modal-close" onclick="closeSettingsModal()" title="关闭">×</button>
    </div>
    <div class="set-modal-body">
      <div class="set-group">
        <h3>情境注入</h3>
        <p class="set-desc">打开后，助手会适时知道今天的日子、待办和天气；关掉后，拾光记仍可当日历和时光册使用。</p>
        <div class="set-row">
          <span class="set-label">助手情境</span>
          <div class="seg" id="injection-enabled-seg">
            <button class="seg-btn active" data-val="true">开</button>
            <button class="seg-btn" data-val="false">关</button>
          </div>
        </div>
        <p class="set-tip hidden" id="injection-disabled-tip">当前不带入助手对话；重新打开后会继续使用原来的带入方式和间隔。</p>
        <div id="injection-options">
          <div class="set-row">
            <span class="set-label">带入方式</span>
            <div class="seg" id="mode-seg">
              <button class="seg-btn" data-mode="economical">适时</button>
              <button class="seg-btn active" data-mode="balanced">相伴</button>
              <button class="seg-btn" data-mode="always">常在</button>
            </div>
          </div>
          <div class="set-row" id="mode-tip-row"><span class="set-tip" id="mode-tip"></span></div>
          <div class="set-row hidden" id="interval-row">
            <span class="set-label">回来多久后更新</span>
            <div class="seg" id="interval-seg">
              <button class="seg-btn" data-val="0.5">30 分钟</button>
              <button class="seg-btn" data-val="1">1 小时</button>
              <button class="seg-btn active" data-val="4">4 小时</button>
              <button class="seg-btn" data-val="8">8 小时</button>
            </div>
          </div>
          <div class="set-row hidden" id="interval-extra-row">
            <span class="set-tip" id="interval-tip"></span>
          </div>
        </div>
      </div>

      <div class="set-group">
        <h3>每日做册</h3>
        <p class="set-desc">一天完整结束后，按伙伴分别把前一天的可见对话做成一页，收进加密时光册；内容会交给你选的模型处理。</p>
        <div class="set-row">
          <span class="set-label">自动做册</span>
          <div class="seg" id="autosum-seg">
            <button class="seg-btn active" data-val="false">关</button>
            <button class="seg-btn" data-val="true">开</button>
          </div>
        </div>
        <div class="set-row" id="boundary-row">
          <span class="set-label">一天何时翻篇</span>
          <select id="boundary-select" class="set-select">
            <option value="0">午夜</option>
            <option value="2">凌晨 2 点</option>
            <option value="4">凌晨 4 点</option>
          </select>
        </div>
        <div class="set-row">
          <span class="set-label">近期动态</span>
          <div class="seg" id="summary-shared-seg">
            <button class="seg-btn active" data-val="false">各自保留</button>
            <button class="seg-btn" data-val="true">共享动态</button>
          </div>
        </div>
        <p class="set-tip">默认每个伙伴只带自己的最近三天；打开后，近期做好的页面才会让其他伙伴也看到。更早的内容只在话题相关时带入。</p>
        <div class="set-row">
          <span class="set-label">做册伙伴</span>
          <div class="summary-agent-picker" id="summary-agent-picker"><span class="set-tip">读取中…</span></div>
        </div>
        <p class="set-tip">这是全局范围，不随日期变化。默认全选；保存后，点击任意日期的「做成一页」只会调用选中的伙伴。</p>
      </div>

      <div class="set-group">
        <h3>生理期记录</h3>
        <p class="set-desc">在日历上记录生理期周期。不想要这个功能就关掉。</p>
        <div class="set-row">
          <span class="set-label">生理期</span>
          <div class="seg" id="period-seg">
            <button class="seg-btn active" data-val="true">开</button>
            <button class="seg-btn" data-val="false">关</button>
          </div>
        </div>
        <p class="set-tip">关闭后日历、添加表单和助手注入里都不会出现生理期，已记的数据会保留。</p>

      </div>

      <div class="set-group">
        <h3>今日天气</h3>
        <p class="set-desc">打开后，主页今日卡会显示天气；情境注入也打开时，天气会成为助手收到的今日情境。关掉后不查询，已选地点会保留。</p>
        <div class="set-row">
          <span class="set-label">今日天气</span>
          <div class="seg" id="weather-seg">
            <button class="seg-btn active" data-val="true">开</button>
            <button class="seg-btn" data-val="false">关</button>
          </div>
        </div>
        <div class="set-row">
          <span class="set-label">居住地</span>
          <div class="weather-region-selects" id="weather-region-selects">
            <label class="weather-region-field">省份
              <select id="weather-province" class="set-select">
                <option value="">选择省份</option>
              </select>
            </label>
            <label class="weather-region-field">城市
              <select id="weather-city" class="set-select" disabled>
                <option value="">先选省份</option>
              </select>
            </label>
            <label class="weather-region-field">区县
              <select id="weather-district" class="set-select" disabled>
                <option value="">先选城市</option>
              </select>
            </label>
          </div>
          <button class="btn weather-clear-btn" type="button" onclick="clearWeatherRegion()">清除</button>
        </div>
        <p class="set-tip" id="weather-legacy-note"></p>
        <p class="set-tip">天气会按区县中心点查询，精度到区域附近，不代表具体门牌。Open-Meteo 免费查询，无需配置。</p>
        <button class="btn" id="weather-test-btn" onclick="testWeather()">测试一下</button>
        <span class="summary-msg" id="weather-test-msg"></span>
      </div>

      <div class="set-group">
        <h3>助手收到的今日情境</h3>
        <p class="set-desc">只预览日子、天气和待办，不会展示其他助手的私密对话。</p>
        <button class="btn" onclick="previewInjection()">看看今天会收到什么</button>
        <div class="preview-box hidden" id="inject-preview"></div>
      </div>

      <div class="set-group">
        <h3>做册用的模型</h3>
        <p class="set-desc">做成一页要走一次模型，选个顺手的。</p>
        <div class="mc-current" id="mc-current">当前使用：读取中…</div>
        <div class="mc-sources">
          <button class="mc-source-btn active" data-source="agent" onclick="mcSetSource('agent')">跟随助手</button>
          <button class="mc-source-btn" data-source="hana" onclick="mcSetSource('hana')">从 Hana 选</button>
          <button class="mc-source-btn" data-source="custom" onclick="mcSetSource('custom')">自定义 API</button>
        </div>
        <div class="mc-form" id="mc-form-agent">
          <p class="set-tip">用你当前对话里的模型，不用额外配置。</p>
        </div>
        <div class="mc-form" id="mc-form-hana" style="display:none">
          <div class="mc-hana-fields">
            <label class="mc-field">供应商
              <select id="mc-provider" class="set-select"><option value="">加载中…</option></select>
            </label>
            <label class="mc-field">模型
              <select id="mc-model" class="set-select"><option value="">先选供应商</option></select>
            </label>
          </div>
          <p class="set-tip">从 Hana 已配置的模型里选，密钥不交给插件。</p>
        </div>
        <div class="mc-form" id="mc-form-custom" style="display:none">
          <div class="set-row">
            <span class="set-label">API 地址</span>
            <input id="mc-custom-url" class="set-input" placeholder="https://api.example.com/v1">
          </div>
          <div class="set-row">
            <span class="set-label">API Key</span>
            <input type="password" id="mc-custom-key" class="set-input" placeholder="留空表示不修改">
          </div>
          <div class="set-row">
            <span class="set-label">模型名</span>
            <input id="mc-custom-model" class="set-input" placeholder="如 gpt-4o-mini">
          </div>
          <div class="set-row">
            <span class="set-label">接口格式</span>
            <select id="mc-custom-api" class="set-select">
              <option value="openai-completions">OpenAI 兼容（chat/completions）</option>
              <option value="openai-responses">OpenAI 新版（responses）</option>
              <option value="anthropic-messages">Anthropic 格式</option>
            </select>
          </div>
          <p class="set-tip" id="mc-key-hint"></p>
          <div class="set-row">
            <button class="link-btn hidden" id="mc-clear-key-btn" onclick="mcClearKey()">清除已存 Key</button>
          </div>
        </div>
        <div class="mc-actions">
          <button class="btn primary" id="mc-test-btn" onclick="mcTest()">测试一下</button>
          <span id="mc-test-result" class="set-tip"></span>
          <span class="spacer"></span>
          <button class="btn primary" id="mc-save-btn" onclick="mcSave()">保存模型</button>
        </div>
      </div>

      <div class="set-group">
        <h3>检查更新 / 反馈</h3>
        <div class="uc-fb-cols">
          <div class="uc-fb-col">
            <div class="uc-fb-body">
              <div class="uc-wrap">
                <button type="button" class="uc-btn" id="uc-check-btn">检查更新</button>
                <span class="uc-result" id="uc-result"></span>
                <a class="uc-link" id="uc-link" target="_blank" rel="noopener" hidden>去看看</a>
              </div>
            </div>
            <div class="uc-fb-note">看看 GitHub 上有没有新版本</div>
          </div>
          <div class="uc-fb-divider"></div>
          <div class="uc-fb-col">
            <div class="uc-fb-body">
              <button type="button" class="fb-open-btn" id="fb-open-btn">反馈</button>
            </div>
            <div class="uc-fb-note">想说啥用大白话讲，它帮你整理成规范 Issue 再提交</div>
          </div>
        </div>
      </div>
      <button class="btn primary settings-save-sticky" onclick="saveAllSettings()">保存全部日常设置</button>
    </div>
  </div>
</div>

<!-- 反馈小助手弹窗（独立于设置弹窗，避免被 overflow 裁切） -->
<div class="fb-modal" id="fb-modal" hidden role="dialog" aria-modal="true" aria-labelledby="fb-modal-title">
  <div class="fb-modal-mask" data-fb-close></div>
  <div class="fb-modal-panel">
    <div class="fb-modal-head">
      <div class="fb-modal-titles"><span class="fb-modal-title" id="fb-modal-title">反馈小助手</span><span class="fb-modal-sub">想说啥用大白话讲，它帮你整理成规范反馈</span></div>
      <button type="button" class="fb-modal-close" data-fb-close aria-label="关闭反馈窗口">×</button>
    </div>
    <div class="fb-messages" id="fb-messages"></div>
    <div class="fb-issue-preview" id="fb-issue-preview" hidden></div>
    <div class="fb-input-row">
      <textarea id="fb-input" placeholder="比如：更新完设置就打不开了…" rows="2"></textarea>
      <button type="button" class="fb-send-btn" id="fb-send-btn">发送</button>
    </div>
    <div class="fb-actions" id="fb-actions" hidden>
      <a class="fb-btn fb-btn-primary" id="fb-submit-link" target="_blank" rel="noopener" hidden>生成提交页</a>
      <button type="button" class="fb-btn" id="fb-copy-btn">复制文案</button>
      <span class="fb-actions-hint" id="fb-actions-hint">检查整理好的内容后再提交</span>
    </div>
  </div>
</div>

<script>${bsJs}</script>
<script>${ucJs}</script>
<script>${fbJs}</script>
<script>
${todoTimeClientJs}
// iframe 握手：告诉宿主页面加载完成（宿主不要求时忽略，无害）
window.parent.postMessage({ protocol: 'hana.plugin.ui', version: 1, kind: 'event', type: 'hana.ready' }, '*');
window.__TOKEN = ${JSON.stringify(token)};
var BASE = '/api/plugins/shiguangji';
function api(path, opts) {
  var tokenSep = path.indexOf('?') >= 0 ? '&' : '?';
  return fetch(BASE + '/' + path.replace(/^\\/+/, '') + tokenSep + 'token=' + encodeURIComponent(window.__TOKEN), opts)
    .then(function (r) { return r.json().catch(function () { return { ok: false }; }); });
}

var curYear = new Date().getFullYear();
var curMonth = new Date().getMonth() + 1;
var selectedDate = null;
var editingEventId = '';
var editingTodoNeedsReminderTime = false;
var todoReminderManual = false;
// autofilled=true 只表示当前时间值来自标题识别；用户触碰时间输入后必须清零并锁定手动值。
var todoReminderAutofilled = false;
var todoReminderAutofilling = false;
var dayEventCache = {};
var appSettings = { showPeriod: true, injectionEnabled: true, weatherEnabled: true }; // 全局设置缓存（启动时从后端同步）
var weatherRegions = [];
var weatherRegionsPromise = null;
var summaryAgents = [];
var summaryAgentSelectionLoaded = false;
var summaryBatchDates = [];
var summarySelectMode = false;
var summaryJobsTimer = null;
var summaryJobWasActive = false;
var monthRequestSeq = 0;
var todayRequestSeq = 0;
var todayRefreshTimer = null;
var weatherSettingsState = { location: '', area: null };
var weatherSelectionTouched = false;
var WEEK = ['日', '一', '二', '三', '四', '五', '六'];
var TYPE_NAME = { event: '日子', anniversary: '纪念日', todo: '待办', period: '生理' };
// 新增表单：不同类型的名称占位提示与一句话讲解（切换类型时联动）。
// 按钮名统一两个字：随记 / 纪念 / 待办。
var NEW_TITLE_PLACEHOLDER = {
  event: '记下这一天发生的事',
  anniversary: '每年都会再来的日子',
  todo: '要做的事，标题里的时间会自动填入',
};
var TYPE_TIPS = {
  event: '只记这一天，过了就过了',
  anniversary: '每年都到，比如生日、纪念日',
  todo: '标题里有明确时间会自动填入；当天白天写“两点”会按下午两点；有“提醒”时优先它旁边的时间',
};
var WEATHER_ICON_SVG = {
  sun: '<circle cx="23" cy="23" r="7" fill="currentColor" opacity=".18"></circle>' +
    '<path d="M23 5v5M23 36v5M5 23h5M36 23h5M10.5 10.5l3.5 3.5M32 32l3.5 3.5M35.5 10.5L32 14M14 32l-3.5 3.5"></path>',
  moon: '<path d="M30 8C23 10 19 16 19 23c0 8 6 14 14 14 3 0 6-1 8-3-2 5-7 8-13 8-11 0-19-8-19-18S17 8 27 8c1 0 2 0 3 .2Z" fill="currentColor" opacity=".18"></path>' +
    '<path d="M30 8C23 10 19 16 19 23c0 8 6 14 14 14 3 0 6-1 8-3"></path>',
  partly: '<circle cx="17" cy="16" r="5" fill="currentColor" opacity=".16"></circle>' +
    '<path d="M17 7v3M8 16h3M10.5 9.5l2 2M23.5 9.5l-2 2"></path>' +
    '<path d="M13 36h22c4 0 7-3 7-7s-3-7-7-7c-1 0-2 .2-3 .6C35 17 31 14 26 14c-6 0-10 4-11 9.5C11 23.7 8 26.4 8 30c0 3 2 6 5 6Z" fill="currentColor" opacity=".18"></path>' +
    '<path d="M13 36h22c4 0 7-3 7-7s-3-7-7-7c-1 0-2 .2-3 .6C35 17 31 14 26 14c-6 0-10 4-11 9.5C11 23.7 8 26.4 8 30c0 3 2 6 5 6Z"></path>',
  cloud: '<path d="M8 35h28c4 0 7-3 7-7s-3-7-7-7c-1 0-2 .2-3 .6C32 17 28 14 23 14c-6 0-10 4-11 9.5C8 23.7 5 26.4 5 30c0 3 1 5 3 5Z" fill="currentColor" opacity=".18"></path>' +
    '<path d="M8 35h28c4 0 7-3 7-7s-3-7-7-7c-1 0-2 .2-3 .6C32 17 28 14 23 14c-6 0-10 4-11 9.5C8 23.7 5 26.4 5 30c0 3 1 5 3 5Z"></path>',
  rain: '<path d="M8 31h28c4 0 7-3 7-7s-3-7-7-7c-1 0-2 .2-3 .6C32 13 28 10 23 10c-6 0-10 4-11 9.5C8 19.7 5 22.4 5 26c0 3 1 5 3 5Z" fill="currentColor" opacity=".18"></path>' +
    '<path d="M8 31h28c4 0 7-3 7-7s-3-7-7-7c-1 0-2 .2-3 .6C32 13 28 10 23 10c-6 0-10 4-11 9.5C8 19.7 5 22.4 5 26c0 3 1 5 3 5ZM15 36l-2 5M24 36l-2 5M33 36l-2 5"></path>',
  snow: '<path d="M8 31h28c4 0 7-3 7-7s-3-7-7-7c-1 0-2 .2-3 .6C32 13 28 10 23 10c-6 0-10 4-11 9.5C8 19.7 5 22.4 5 26c0 3 1 5 3 5Z" fill="currentColor" opacity=".18"></path>' +
    '<path d="M8 31h28c4 0 7-3 7-7s-3-7-7-7c-1 0-2 .2-3 .6C32 13 28 10 23 10c-6 0-10 4-11 9.5C8 19.7 5 22.4 5 26c0 3 1 5 3 5ZM16 36v8M12 40h8M13.2 37.2l5.6 5.6M18.8 37.2l-5.6 5.6M30 36v8M26 40h8M27.2 37.2l5.6 5.6M32.8 37.2l-5.6 5.6" stroke-width="2.4"></path>',
  fog: '<path d="M11 16h24M8 24h30M11 32h24M15 40h16"></path>',
  storm: '<path d="M8 31h28c4 0 7-3 7-7s-3-7-7-7c-1 0-2 .2-3 .6C32 13 28 10 23 10c-6 0-10 4-11 9.5C8 19.7 5 22.4 5 26c0 3 1 5 3 5Z" fill="currentColor" opacity=".18"></path>' +
    '<path d="M8 31h28c4 0 7-3 7-7s-3-7-7-7c-1 0-2 .2-3 .6C32 13 28 10 23 10c-6 0-10 4-11 9.5C8 19.7 5 22.4 5 26c0 3 1 5 3 5ZM24 30l-4 7h5l-3 7 8-10h-5l4-4"></path>',
};

function pad(n) { return String(n).padStart(2, '0'); }
function dk(y, m, d) { return y + '-' + pad(m) + '-' + pad(d); }

function weatherIsDay(weather) {
  if (weather && typeof weather.isDay === 'boolean') return weather.isDay;
  if (weather && (weather.isDay === 1 || weather.isDay === 0)) return weather.isDay === 1;
  var line = String(weather && weather.line || '');
  if (line.indexOf('天已经黑') >= 0 || line.indexOf('夜') >= 0) return false;
  if (line.indexOf('清晨') >= 0 || line.indexOf('正午') >= 0 || line.indexOf('傍晚') >= 0) return true;
  var hour = new Date().getHours();
  return hour >= 6 && hour < 20;
}

function weatherIconKind(weather) {
  var rawCode = weather && weather.code;
  var code = rawCode === '' || rawCode == null ? NaN : Number(rawCode);
  if (!Number.isFinite(code)) {
    var line = String(weather && weather.line || '');
    if (/雷|冰雹/.test(line)) return 'storm';
    if (/雨/.test(line)) return 'rain';
    if (/雪|米雪/.test(line)) return 'snow';
    if (/雾|雾凇/.test(line)) return 'fog';
    if (/多云|阴天/.test(line)) return 'cloud';
  }
  if (code === 45 || code === 48) return 'fog';
  if ((code >= 71 && code <= 77) || (code >= 85 && code <= 86)) return 'snow';
  if (code >= 95 && code <= 99) return 'storm';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if (code === 1) return weatherIsDay(weather) ? 'partly' : 'moon';
  if (code === 2 || code === 3) return 'cloud';
  return weatherIsDay(weather) ? 'sun' : 'moon';
}

function renderTodayWeatherIcon(weather) {
  var icon = document.getElementById('today-weather-icon');
  if (!icon) return;
  var kind = weatherIconKind(weather);
  icon.setAttribute('class', 'today-weather-icon weather-' + kind + (appSettings.weatherEnabled === false ? ' hidden' : ''));
  icon.innerHTML = WEATHER_ICON_SVG[kind] || WEATHER_ICON_SVG.sun;
  icon.setAttribute('aria-label', weather && weather.line ? weather.line : '当前时段');
}

function applyTodayWeather(weather) {
  var weatherEl = document.getElementById('today-weather');
  renderTodayWeatherIcon(weather);
  if (weather && weather.line) {
    weatherEl.textContent = '窗外：' + weather.line;
    weatherEl.classList.remove('hidden');
    return true;
  }
  weatherEl.textContent = '';
  weatherEl.classList.add('hidden');
  return false;
}

function toast(msg) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(function () { t.classList.remove('show'); }, 2200);
}

var confirmCallback = null;
function askConfirm(text, callback) {
  confirmCallback = callback;
  document.getElementById('confirm-text').textContent = text;
  document.getElementById('confirm-modal').hidden = false;
}
function closeConfirm() {
  confirmCallback = null;
  document.getElementById('confirm-modal').hidden = true;
}
function confirmYes() {
  var fn = confirmCallback;
  closeConfirm();
  if (typeof fn === 'function') fn();
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// 事件类型只允许进白名单：拼进 class / 文案前先归一，防脏数据把任意字符串带进 HTML。
var EVENT_TYPE_WHITELIST = { event: true, anniversary: true, todo: true, period: true };
function safeType(t) {
  return EVENT_TYPE_WHITELIST[t] ? t : 'event';
}

function switchTab(tab) {
  if (tab === 'summary' && summarySelectMode) toggleSummaryBatchMode(false);
  var tabs = document.querySelectorAll('.nav-tabs button');
  for (var i = 0; i < tabs.length; i++) tabs[i].classList.remove('active');
  document.getElementById('tab-' + tab).classList.add('active');
  document.getElementById('panel-calendar').classList.toggle('hidden', tab !== 'calendar');
  document.getElementById('panel-summary').classList.toggle('hidden', tab !== 'summary');
  if (tab === 'calendar') loadMonth();
  if (tab === 'summary') loadSummaries();
}

/* ── 今日概览 ── */
function loadToday() {
  var requestId = ++todayRequestSeq;
  var now = new Date();
  var key = dk(now.getFullYear(), now.getMonth() + 1, now.getDate());
  var weatherRequest = appSettings.weatherEnabled !== false && appSettings.weatherLocation
    ? api('api/weather/current').catch(function () { return { ok: false }; })
    : Promise.resolve({ ok: false });
  document.getElementById('today-bigday').textContent = pad(now.getDate());
  document.getElementById('today-year').textContent = now.getFullYear();
  document.getElementById('today-month').textContent =
    now.getMonth() + 1 + ' 月 · 星期' + WEEK[now.getDay()];
  api('api/events/' + key).then(function (res) {
    if (requestId !== todayRequestSeq || !res.ok || !res.day) return;
    var day = res.day;
    var fest = document.getElementById('today-fest');
    var evs = document.getElementById('today-events');
    var quiet = document.getElementById('today-quiet');
    fest.innerHTML = '';
    evs.innerHTML = '';
    var has = false;
    (day.builtin || []).forEach(function (f) {
      fest.innerHTML += '<span class="chip">' + esc(f.emoji) + ' ' + esc(f.name) + '</span>';
      has = true;
    });
    var showPeriod = appSettings.showPeriod !== false;
    var all = (day.userEvents || []).concat((showPeriod ? (day.periods || []) : []).map(function (p) {
      var x = Object.assign({}, p); x.type = 'period';
      if (p.predicted) x.title = '预计生理期';
      return x;
    }));
    all.forEach(function (e) {
      var cls = 'ep-' + (e.type || 'event');
      var label = TYPE_NAME[e.type] ? '[' + TYPE_NAME[e.type] + '] ' : '';
      evs.innerHTML += '<span class="chip ' + cls + '">' + esc(label + e.title) + '</span>';
      has = true;
    });
    if (applyTodayWeather(day.weather)) has = true;
    var overdue = day.overdueTodos || [];
    if (overdue.length) {
      evs.innerHTML += '<span class="chip ep-todo">有 ' + overdue.length + ' 条待办已经逾期</span>';
      has = true;
    }
    quiet.classList.toggle('hidden', has);
    weatherRequest.then(function (weatherRes) {
      if (requestId !== todayRequestSeq || !weatherRes || !weatherRes.ok || !weatherRes.weather) return;
      applyTodayWeather(weatherRes.weather);
      quiet.classList.add('hidden');
    });
  });
}

/* ── 日历 ── */
function syncSelectedCellState() {
  var cells = document.querySelectorAll('.cal-day[data-date]');
  for (var i = 0; i < cells.length; i++) {
    var date = cells[i].getAttribute('data-date');
    var selected = !summarySelectMode && date === selectedDate;
    var batchSelected = summarySelectMode && summaryBatchDates.indexOf(date) >= 0;
    cells[i].classList.toggle('selected', selected);
    cells[i].classList.toggle('batch-selected', batchSelected);
    cells[i].setAttribute('aria-pressed', selected || batchSelected ? 'true' : 'false');
  }
}

function shiftMonth(d) {
  curMonth += d;
  if (curMonth < 1) { curMonth = 12; curYear--; }
  if (curMonth > 12) { curMonth = 1; curYear++; }
  selectedDate = null;
  syncSelectedCellState();
  document.getElementById('detail-title').textContent = '点一个日子看看';
  document.getElementById('detail-wk').textContent = '';
  document.getElementById('detail').classList.add('hidden');
  document.getElementById('detail-body').innerHTML = '<div class="empty">选一天，看看那天有什么好日子。</div>';
  loadMonth();
}

function goToday() {
  var n = new Date();
  curYear = n.getFullYear(); curMonth = n.getMonth() + 1;
  loadMonth();
  if (summarySelectMode) {
    selectedDate = null;
    document.getElementById('detail-title').textContent = '点一个日子看看';
    document.getElementById('detail-wk').textContent = '';
    document.getElementById('detail').classList.add('hidden');
    document.getElementById('detail-body').innerHTML = '<div class="empty">选一天，看看那天有什么好日子。</div>';
    return;
  }
  selectDay(dk(curYear, curMonth, n.getDate()));
}

function startTodayRefresher() {
  if (todayRefreshTimer) return;
  // 天气后台按自己的缓存间隔刷新；页面定期重读，让最新缓存及时反映到今日卡。
  todayRefreshTimer = setInterval(loadToday, 15 * 60 * 1000);
}

function loadMonth() {
  var requestId = ++monthRequestSeq;
  document.getElementById('month-title').textContent = curYear + ' 年 ' + curMonth + ' 月';
  api('api/month/' + curYear + '/' + curMonth).then(function (res) {
    if (requestId !== monthRequestSeq) return;
    if (!res.ok) {
      document.getElementById('calendar').innerHTML = '<div style="grid-column:1/-1;color:var(--muted);padding:20px">加载失败，稍后再试</div>';
      return;
    }
    renderCalendar(res.days);
    renderEmptyGuide(res.hasAnyRecord === false);
  });
}

function renderCalendar(days) {
  var first = new Date(curYear, curMonth - 1, 1);
  var lead = first.getDay();
  var now = new Date();
  var todayStr = dk(now.getFullYear(), now.getMonth() + 1, now.getDate());
  var html = '';
  for (var w = 0; w < 7; w++) {
    var cls = 'cal-head' + (w === 0 ? ' sunday' : (w === 6 ? ' weekend' : ''));
    html += '<div class="' + cls + '">' + WEEK[w] + '</div>';
  }
  for (var i = 0; i < lead; i++) html += '<div class="cal-day empty"></div>';
  days.forEach(function (d) {
    var isToday = d.date === todayStr;
    var isSelected = !summarySelectMode && d.date === selectedDate;
    var isBatchSelected = summarySelectMode && summaryBatchDates.indexOf(d.date) >= 0;
    var canBatch = d.canBatchSummary !== false;
    var dt = new Date(d.date + 'T00:00:00');
    var wd = dt.getDay();
    var numCls = (wd === 0 || wd === 6) ? ' weekend-num' : '';
    var showPeriod = appSettings.showPeriod !== false;
    var userList = (d.user || []).filter(function (u) { return showPeriod || u.type !== 'period'; });
    var periodCount = showPeriod ? (d.periods || 0) : 0;
    var predictedPeriodCount = showPeriod ? (d.predictedPeriods || 0) : 0;
    var tags = [];
    if (d.builtin && d.builtin.length) {
      var b = d.builtin[0];
      tags.push('<span class="tag builtin">' + esc(b.emoji) + ' ' + esc(b.name) + '</span>');
    }
    var userShown = 0;
    var periodShown = false;
    userList.forEach(function (u) {
      if (u.type === 'period') { periodShown = true; return; }
      if (userShown >= 2) return;
      tags.push('<span class="tag ' + esc(u.type || 'event') + '">' + esc(u.title) + '</span>');
      userShown++;
    });
    if (periodCount > 0 && !periodShown) {
      var dot = '<span class="period-dot"></span>';
      if (tags.length < 3) tags.push('<span class="tag period">' + dot + '生理期</span>');
      else tags[tags.length - 1] += dot;
    } else if (predictedPeriodCount > 0 && !periodShown && tags.length < 3) {
      tags.push('<span class="tag period predicted">预计生理期</span>');
    }
    var total = (d.builtin ? d.builtin.length : 0) + userList.length + (periodCount || predictedPeriodCount ? 1 : 0);
    if (total > tags.length) {
      tags.push('<span class="tag more">+' + (total - tags.length) + '</span>');
    }
    var cellClass = 'cal-day' + (isToday ? ' today' : '') + (isSelected ? ' selected' : '') + (isBatchSelected ? ' batch-selected' : '');
    if (summarySelectMode && !canBatch) cellClass += ' batch-disabled';
    var pressed = summarySelectMode ? isBatchSelected : isSelected;
    var onclick = summarySelectMode
      ? (canBatch ? 'toggleSummaryBatchDate(' + jsArg(d.date) + ')' : 'return false')
      : 'selectDay(' + jsArg(d.date) + ', true)';
    var keyAction = summarySelectMode
      ? (canBatch ? "if(event.key==='Enter'||event.key===' '){toggleSummaryBatchDate(" + jsArg(d.date) + ')}' : 'return false')
      : "if(event.key==='Enter'||event.key===' '){selectDay(" + jsArg(d.date) + ',true)}';
    var cellTitle = summarySelectMode && !canBatch ? '这一天还没结束，暂时不能做成册' : '';
    html += '<div class="' + cellClass + '" data-date="' + esc(d.date) + '" role="button" aria-pressed="' + (pressed ? 'true' : 'false') + '" aria-disabled="' + (summarySelectMode && !canBatch ? 'true' : 'false') + '" tabindex="0" title="' + cellTitle + '" onclick="' + onclick + '" onkeydown="' + keyAction + '">' +
      '<div class="num"><span class="' + numCls + '">' + d.date.slice(8) + '</span>' +
      (isToday ? '<span class="today-tag">今天</span>' : '') +
      (d.hasSummary ? '<span class="sum-tag" title="这天已收进时光册">✦</span>' : '') + '</div>' +
      '<div class="tags">' + tags.slice(0, 3).join('') + '</div>' +
      '</div>';
  });
  document.getElementById('calendar').innerHTML = html;
}

// 新手引导：当月完全没有记录时，告诉新用户点日期就能记。
// 一旦任何一天有了记录，引导自动消失，不再打扰。
function renderEmptyGuide(empty) {
  var guide = document.getElementById('calendar-guide');
  if (!guide) return;
  if (empty) {
    guide.classList.remove('hidden');
  } else {
    guide.classList.add('hidden');
  }
}

/* ── 点天详情 ── */
function selectDay(date, userInitiated) {
  selectedDate = date;
  document.getElementById('detail').classList.remove('hidden');
  syncSelectedCellState();
  var dt = new Date(date + 'T00:00:00');
  document.getElementById('detail-title').textContent = date.slice(5).replace('-', ' 月 ') + ' 日';
  document.getElementById('detail-wk').textContent = '星期' + WEEK[dt.getDay()];
  api('api/events/' + date).then(function (res) {
    if (!res.ok) {
      document.getElementById('detail-body').innerHTML = '<div class="empty">加载失败</div>';
      return;
    }
    renderDetail(res.day);
    if (userInitiated) {
      setTimeout(function () { document.getElementById('detail').scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 30);
    }
  });
}

function renderDetail(day) {
  editingTodoNeedsReminderTime = false;
  todoReminderManual = false;
  todoReminderAutofilled = false;
  todoReminderAutofilling = false;
  var html = '';
  if (day.builtin && day.builtin.length) {
    html += '<div class="fest-row">' + day.builtin.map(function (f) {
      var cls = f.kind === 'legal' ? 'fest-chip legal' : 'fest-chip';
      return '<span class="' + cls + '">' + esc(f.emoji) + ' ' + esc(f.name) + ' · ' + esc(f.source) + '</span>';
    }).join('') + '</div>';
  }
  if (day.workday) {
    html += '<span class="workday-note">调休上班日，记得定闹钟</span>';
  }
  var showPeriod = appSettings.showPeriod !== false;
  var userList = (day.userEvents || []).filter(function (u) { return showPeriod || u.type !== 'period'; });
  var periods = (showPeriod ? (day.periods || []) : []);
  var canAddTodo = day.canAddTodo !== false;
  // 当前/未来生活日更偏向安排接下来要做的事；已翻篇的日子默认补记随记。
  var defaultType = canAddTodo ? 'todo' : 'event';
  var hasHistoricalTodo = userList.some(function (event) { return event.type === 'todo'; });

  // ── 生理期快捷区 ──
  if (showPeriod) {
    if (periods.length) {
      var p = periods[0];
      var dayN = p.day || 1;
      var todayKey = dk(new Date().getFullYear(), new Date().getMonth() + 1, new Date().getDate());
      var prefix = selectedDate === todayKey ? '今天' : '这天';
      var periodText = p.predicted
        ? '预计是生理期第 <b>' + dayN + '</b> 天'
        : prefix + '是生理期第 <b>' + dayN + '</b> 天';
      var periodAction = p.predicted
        ? '<button class="pq-btn primary" onclick="markPeriod(\\'' + selectedDate + '\\')">确认这天</button>'
        : '<button class="pq-btn" onclick="unmarkPeriod(\\'' + selectedDate + '\\')">从这天结束</button>';
      html += '<div class="period-quick on">' +
        '<span class="pq-dot"></span>' +
        '<span class="pq-text">' + periodText + '</span>' + periodAction +
        '</div>';
    } else {
      // 不在生理期内：按日期相对今天分时态给动作
      var todayStr = dk(new Date().getFullYear(), new Date().getMonth() + 1, new Date().getDate());
      var isToday = selectedDate === todayStr;
      var isFuture = selectedDate > todayStr; // YYYY-MM-DD 字符串可直接比较
      var prevConfirmed = (day.prevPeriods || []).some(function (p) { return !p.predicted; });
      var recentPeriod = (day.prevPeriods || []).length > 0;
      // 已确认结束：昨天/最近在周期内且周期已确认结束（confirmedThrough < 今天）→ 显示「已结束」确认条
      var endedOn = '';
      var prevPeriods = day.prevPeriods || [];
      for (var pi = 0; pi < prevPeriods.length; pi++) {
        var pp = prevPeriods[pi];
        if (pp.confirmedThrough && pp.confirmedThrough < todayStr) {
          endedOn = pp.confirmedThrough;
          break;
        }
      }
      var htmlBtn = '';
      if (isToday && endedOn) {
        // 今天已确认结束：显示结束确认条，不再给操作按钮
        htmlBtn = '';
        html += '<div class="period-quick on">' +
          '<span class="pq-dot"></span>' +
          '<span class="pq-text">生理期已于 <b>' + endedOn.slice(5) + '</b> 结束 ✦</span>' +
          '</div>';
      } else if (isToday && prevConfirmed) {
        htmlBtn = '<button class="pq-btn primary" onclick="markPeriod(\\'' + selectedDate + '\\')">今天也是生理期</button>' +
          '<button class="pq-btn" onclick="endPeriod(\\'' + selectedDate + '\\')">今天结束了</button>';
      } else if (isToday && recentPeriod) {
        // 昨天在周期内、今天不在：今天已结束，给「确认结束」入口，不误删昨天
        htmlBtn = '<button class="pq-btn primary" onclick="endPeriod(\\'' + selectedDate + '\\')">今天结束了</button>';
      } else if (isToday) {
        htmlBtn = '<button class="pq-btn primary" onclick="markPeriod(\\'' + selectedDate + '\\')">今天开始生理期</button>';
      } else if (isFuture) {
        htmlBtn = '<button class="pq-btn primary" onclick="markPeriod(\\'' + selectedDate + '\\')">预计这天开始生理期</button>';
      }
      // 补记开始日：今天与过去显示；未来只有预计，不显示补记
      var showPick = !isFuture && !endedOn;
      if (!(isToday && endedOn)) {
        html += '<div class="period-quick">' +
          '<span class="pq-dot"></span>' +
          htmlBtn +
          (showPick ? '<button class="pq-btn" onclick="togglePeriodPicker()">补记开始日</button>' : '') +
          '<span class="pq-picker hidden" id="period-picker">' +
          '<input type="date" id="period-start" value="' + selectedDate + '">' +
          '<button class="pq-btn" onclick="markPeriodFromPicker()">确定</button>' +
          '</span>' +
          '</div>';
      }
    }
  }

  // ── 事件列表 ──
  dayEventCache = {};
  var all = userList.concat(periods.map(function (p) {
    var x = Object.assign({}, p); x.type = 'period'; return x;
  }));
  if (all.length) {
    all.forEach(function (e) {
      dayEventCache[e.id] = e;
      var t = e.type || 'event';
      var titleHtml = esc(e.title);
      if (t === 'period') titleHtml = (e.predicted ? '预计生理期' : '生理期') + (e.day ? ' · 第' + e.day + '天' : '');
      var todoTimeText = '';
      if (t === 'todo') {
        var timeStart = String(e.reminderStart || '');
        var timeEnd = String(e.reminderEnd || '');
        if (timeStart && timeEnd) {
          todoTimeText = timeStart === timeEnd ? timeStart + ' 准点' : timeStart + '–' + timeEnd;
        } else {
          todoTimeText = '待补提醒时间';
        }
      }
      var left = '';
      if (t === 'todo') {
        var done = e.done ? ' checked' : '';
        left = '<button class="todo-check' + done + '" onclick="toggleTodo(\\'' + e.id + '\\')" title="完成/取消"></button>';
      } else {
        left = '<span class="bar b-' + safeType(t) + '"></span>';
      }
      var actions = t === 'period'
        ? ''
        : '<button class="del" onclick="startEditEvent(\\'' + e.id + '\\')" title="编辑">改</button>' +
          '<button class="del" onclick="delEvent(\\'' + e.id + '\\')" title="删除">✕</button>';
      html += '<div class="event-row' + (e.done ? ' done' : '') + '">' +
        left +
        '<span class="type t-' + safeType(t) + '">' + (TYPE_NAME[t] || '日子') + '</span>' +
        '<span class="title">' + titleHtml +
        (t === 'todo' ? '<span class="todo-time' + (todoTimeText === '待补提醒时间' ? ' missing' : '') + '">' + esc(todoTimeText) + '</span>' : '') +
        (e.note && t !== 'period' ? '<span class="note">' + esc(e.note) + '</span>' : '') + '</span>' + actions +
        '</div>';
    });
  } else if (!periods.length) {
    html += '<div class="empty">这一天还没记下什么，写下第一笔吧。</div>';
  }

  // ── 这一天的这一页 ──
  html += renderSummaryBlock(day);

  // 生理期走上面的快捷区；新增时日期沿用刚刚点选的这一天，编辑时才展开改日期。
  var todoTab = canAddTodo
    ? '<button class="type-tab' + (defaultType === 'todo' ? ' active' : '') + '" data-type="todo">待办</button>'
    : (hasHistoricalTodo ? '<button class="type-tab" data-type="todo" disabled title="历史待办保留在记录里，编辑时可以保留">待办（已有）</button>' : '');
  var dateStateNote = canAddTodo ? '' : '<span class="add-date-note past-note">这天已翻篇，只能补记</span>';
  html += '<div class="add-form">' +
    '<input id="new-title" placeholder="' + NEW_TITLE_PLACEHOLDER[defaultType] + '" maxlength="40">' +
    '<span class="add-date-note" id="new-date-note">记到 ' + esc(selectedDate) + '</span>' +
    dateStateNote +
    '<input type="date" id="new-date" class="hidden" value="' + selectedDate + '">' +
    '<input id="new-note" placeholder="备注（可不填）" maxlength="80">' +
    '<div class="type-tabs" id="type-tabs">' +
    '<button class="type-tab' + (defaultType === 'event' ? ' active' : '') + '" data-type="event">随记</button>' +
    '<button class="type-tab" data-type="anniversary">纪念</button>' +
    todoTab +
    '</div>' +
    '<div class="type-tip" id="new-type-tip">' + TYPE_TIPS[defaultType] + '</div>' +
    '<div class="todo-reminder' + (defaultType === 'todo' ? '' : ' hidden') + '" id="todo-reminder">' +
      '<span class="todo-reminder-label">提醒时间</span>' +
      '<label class="todo-time-label">从 <input type="time" id="new-reminder-start" class="todo-time-input" aria-label="提醒开始时间"></label>' +
      '<span class="todo-time-sep">到</span>' +
      '<label class="todo-time-label"><input type="time" id="new-reminder-end" class="todo-time-input" aria-label="提醒结束时间"></label>' +
      '<span class="todo-time-preview" id="todo-time-preview">标题里写明确时间（如“下午三点”或“9点”）会自动填入；当天白天写“两点”会按下午两点；有“提醒”时优先它旁边的时间</span>' +
    '</div>' +
    '<div class="todo-time-error hidden" id="todo-time-error"></div>' +
    '<button class="btn primary" id="event-save-btn" onclick="saveEvent()">记下</button>' +
    '<button class="btn hidden" id="event-cancel-btn" onclick="cancelEditEvent()">取消编辑</button>' +
    '</div>';
  document.getElementById('detail-body').innerHTML = html;
  syncTodoReminderUI(defaultType);
}

// ── 这一天的这一页 ──
function renderSummaryBlock(day) {
  var entries = day.summaries || (day.summary ? [day.summary] : []);
  var canSum = day.canSummary;
  var isToday = selectedDate === dk(new Date().getFullYear(), new Date().getMonth() + 1, new Date().getDate());
  var html = '';
  if (entries.length) {
    html += '<div class="sum-block">' +
      '<div class="sum-head">' +
      '<span class="sum-title">这一页</span>' +
      '<div class="sum-actions">' +
      '<button class="sum-link" onclick="openSummaryTab(\\'' + selectedDate + '\\')">查看时光册</button>' +
      '<button class="sum-link" onclick="runSummaryFromDay(\\'' + selectedDate + '\\')">重新做这一页</button>' +
      '</div></div>';
    entries.forEach(function (entry) {
      var key = summaryDomKey(selectedDate, entry.agentId || '');
      html += '<div class="sum-agent">' +
        '<span class="sum-agent-name">' + esc(entry.agentName || (entry.agentId ? entry.agentId : '未分类的一页')) + '</span>' +
        '<div class="sum-text" id="archive-text-' + key + '">' + esc(entry.text) + '</div>' +
        '<div class="archive-actions">' +
        '<button onclick="editSummary(\\'' + selectedDate + '\\',' + jsArg(entry.agentId || '') + ')">修改</button>' +
        '<button onclick="openSummaryChat(\\'' + selectedDate + '\\',' + jsArg(entry.agentId || '') + ',' + jsArg(entry.agentName || (entry.agentId ? entry.agentId : '未分类的一页')) + ')">和小花聊聊</button>' +
        '</div>' +
        '</div>';
    });
    html += '</div>';
  } else if (canSum) {
    html += '<div class="sum-block empty">' +
      '<div class="sum-text muted">这一天还没有做成一页。把和伙伴们做过的事收进来，日后翻看会很有味道。</div>' +
      '<button class="btn primary" onclick="runSummaryFromDay(\\'' + selectedDate + '\\')">做成这一页</button>' +
      '<span class="sum-msg" id="detail-summary-msg"></span>' +
      '</div>';
  } else if (isToday) {
    html += '<div class="sum-block empty">' +
      '<div class="sum-text muted">今天还没结束，可以先看看这一页到目前为止的回忆。</div>' +
      '<button class="btn" onclick="previewDay(\\'' + selectedDate + '\\')">预看这一页</button>' +
      '<div class="sum-preview hidden" id="detail-summary-preview"></div>' +
      '</div>';
  }
  return html;
}

function runSummaryFromDay(date) {
  var msgEl = document.getElementById('detail-summary-msg');
  queueSummaryDates([date], msgEl, false);
}

function previewDay(date) {
  var box = document.getElementById('detail-summary-preview');
  api('api/summaries/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: date, preview: true }),
  }).then(function (res) {
    if (res.ok && res.text) {
      // 把预览内容直接显示在这一页区块里
      if (box) {
        box.classList.remove('hidden');
        box.textContent = res.text;
        box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } else {
        toast('这一页已预看，切到时光册查看');
        loadMonth(); selectDay(selectedDate);
      }
    } else toast(res.error || '预览失败');
  });
}

function openSummaryTab(date) {
  switchTab('summary');
  if (date) {
    setTimeout(function () {
      var item = document.querySelector('.archive-item[data-summary-date="' + date + '"]');
      if (item) item.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 200);
  }
}

// 类型切换联动：更新输入框占位提示和一句话讲解。
function updateTypeGuide(type) {
  var kind = TYPE_TIPS[type] ? type : 'event';
  var titleInput = document.getElementById('new-title');
  if (titleInput) titleInput.placeholder = NEW_TITLE_PLACEHOLDER[kind] || NEW_TITLE_PLACEHOLDER.event;
  var tip = document.getElementById('new-type-tip');
  if (tip) tip.textContent = TYPE_TIPS[kind] || TYPE_TIPS.event;
  syncTodoReminderUI(kind);
  if (kind === 'todo') autofillTodoReminderFromTitle();
}

function todoTimeMinutes(value) {
  var parts = String(value || '').split(':');
  if (parts.length !== 2) return NaN;
  var hour = Number(parts[0]);
  var minute = Number(parts[1]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return NaN;
  return hour * 60 + minute;
}

function autofillTodoReminderFromTitle() {
  var typeTab = document.querySelector('#type-tabs .type-tab.active');
  if (!typeTab || typeTab.getAttribute('data-type') !== 'todo' || todoReminderManual) return;
  var titleInput = document.getElementById('new-title');
  var start = document.getElementById('new-reminder-start');
  var end = document.getElementById('new-reminder-end');
  if (!titleInput || !start || !end || typeof parseTodoReminderText !== 'function') return;
  var parsed = null;
  try { parsed = parseTodoReminderText(titleInput.value, { now: new Date(), targetDate: selectedDate || '' }); } catch (_) { parsed = null; }
  if (!parsed) {
    if (todoReminderAutofilled) {
      todoReminderAutofilling = true;
      start.value = '';
      end.value = '';
      todoReminderAutofilling = false;
      todoReminderAutofilled = false;
      syncTodoReminderUI('todo');
    }
    return;
  }
  if ((start.value || end.value) && !todoReminderAutofilled) return;
  todoReminderAutofilling = true;
  start.value = parsed.reminderStart;
  end.value = parsed.reminderEnd;
  todoReminderAutofilling = false;
  todoReminderAutofilled = true;
  syncTodoReminderUI('todo');
}

function syncTodoReminderUI(type) {
  var isTodo = type === 'todo';
  var box = document.getElementById('todo-reminder');
  var error = document.getElementById('todo-time-error');
  var preview = document.getElementById('todo-time-preview');
  var start = document.getElementById('new-reminder-start');
  var end = document.getElementById('new-reminder-end');
  var save = document.getElementById('event-save-btn');
  if (box) box.classList.toggle('hidden', !isTodo);
  if (!isTodo) {
    if (error) error.classList.add('hidden');
    if (preview) preview.textContent = '';
    if (save) save.disabled = false;
    return;
  }
  var startValue = start ? start.value : '';
  var endValue = end ? end.value : '';
  var startMinutes = todoTimeMinutes(startValue);
  var endMinutes = todoTimeMinutes(endValue);
  var valid = Boolean(startValue && endValue && Number.isFinite(startMinutes) && Number.isFinite(endMinutes) && startMinutes <= endMinutes);
  if (preview) {
    var autoNote = todoReminderAutofilled && !todoReminderManual ? '（已从标题识别）' : '';
    if (!startValue || !endValue) preview.textContent = '标题里写明确时间（如“下午三点”或“9点”）会自动填入；当天白天写“两点”会按下午两点；有“提醒”时优先它旁边的时间，也可以手动选';
    else if (startValue === endValue) preview.textContent = startValue + ' · 准点提醒' + autoNote;
    else preview.textContent = startValue + '–' + endValue + ' · 按时段提醒' + autoNote;
  }
  if (error) {
    if (!startValue || !endValue) {
      error.textContent = editingTodoNeedsReminderTime
        ? '这条旧待办还没设过提醒时间，请补上后再保存。'
        : '请选择提醒时间，选同一时间表示准点提醒。';
    }
    else if (startMinutes > endMinutes) error.textContent = '开始时间不能晚于结束时间。';
    error.classList.toggle('hidden', valid);
  }
  if (save) save.disabled = !valid;
}

function saveEvent() {
  var title = document.getElementById('new-title').value.trim();
  if (!title) { toast('写个名称吧'); return; }
  var typeTab = document.querySelector('#type-tabs .type-tab.active');
  var type = typeTab ? typeTab.getAttribute('data-type') : 'event';
  var dateInput = document.getElementById('new-date');
  var date = (dateInput && dateInput.value) || selectedDate;
  var note = document.getElementById('new-note').value.trim();
  var body = { title: title, type: type, date: date, note: note, repeatYearly: type === 'anniversary' };
  if (type === 'todo') {
    var startInput = document.getElementById('new-reminder-start');
    var endInput = document.getElementById('new-reminder-end');
    var reminderStart = startInput ? startInput.value : '';
    var reminderEnd = endInput ? endInput.value : '';
    if (!reminderStart || !reminderEnd || todoTimeMinutes(reminderStart) > todoTimeMinutes(reminderEnd)) {
      syncTodoReminderUI(type);
      return;
    }
    body.reminderStart = reminderStart;
    body.reminderEnd = reminderEnd;
  }
  var route = editingEventId ? 'api/events/' + editingEventId : 'api/events';
  api(route, {
    method: editingEventId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(function (res) {
    if (res.ok) {
      toast(editingEventId ? '改好了' : '记下了「' + title + '」');
      editingEventId = '';
      loadMonth(); selectDay(date); loadToday();
    } else toast(res.error || '没存上');
  });
}

function startEditEvent(id) {
  var e = dayEventCache[id];
  if (!e) return;
  editingEventId = id;
  editingTodoNeedsReminderTime = e.type === 'todo' && (!e.reminderStart || !e.reminderEnd);
  var existingReminderStart = String(e.reminderStart || '');
  var existingReminderEnd = String(e.reminderEnd || '');
  var parsedTitleReminder = null;
  if (e.type === 'todo' && typeof parseTodoReminderText === 'function') {
    try { parsedTitleReminder = parseTodoReminderText(e.title || '', { now: new Date(), targetDate: e.date || selectedDate || '' }); } catch (_) { parsedTitleReminder = null; }
  }
  var reminderMatchesTitle = Boolean(
    existingReminderStart && existingReminderEnd && parsedTitleReminder &&
    parsedTitleReminder.reminderStart === existingReminderStart && parsedTitleReminder.reminderEnd === existingReminderEnd
  );
  todoReminderManual = Boolean(existingReminderStart || existingReminderEnd) && !reminderMatchesTitle;
  todoReminderAutofilled = reminderMatchesTitle;
  document.getElementById('new-title').value = e.title || '';
  var dateInput = document.getElementById('new-date');
  if (dateInput) {
    dateInput.value = e.date || selectedDate;
    dateInput.classList.remove('hidden');
  }
  var dateNote = document.getElementById('new-date-note');
  if (dateNote) dateNote.classList.add('hidden');
  var todoTab = document.querySelector('#type-tabs .type-tab[data-type="todo"]');
  if (todoTab && todoTab.disabled) {
    todoTab.disabled = false;
    todoTab.textContent = '待办';
    todoTab.removeAttribute('title');
  }
  document.getElementById('new-note').value = e.note || '';
  var reminderStartInput = document.getElementById('new-reminder-start');
  var reminderEndInput = document.getElementById('new-reminder-end');
  if (reminderStartInput) reminderStartInput.value = e.reminderStart || '';
  if (reminderEndInput) reminderEndInput.value = e.reminderEnd || '';
  document.querySelectorAll('#type-tabs .type-tab').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-type') === (e.type || 'event'));
  });
  updateTypeGuide(e.type || 'event');
  document.getElementById('event-save-btn').textContent = '保存修改';
  document.getElementById('event-cancel-btn').classList.remove('hidden');
  document.getElementById('new-title').focus();
}

function cancelEditEvent() {
  editingEventId = '';
  selectDay(selectedDate);
}

// ── 生理期快捷动作 ──
function markPeriod(date) {
  api('api/periods', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: date }),
  }).then(function (res) {
    if (res.ok) {
      var msg = res.created ? '记下生理期啦' : (res.extended ? '今天也记上啦，连着昨天' : (res.confirmed ? '确认这天啦' : '这天已经记过了'));
      toast(msg);
      loadMonth(); selectDay(selectedDate); loadToday();
    } else toast(res.error || '没记成');
  });
}

function unmarkPeriod(date) {
  askConfirm('从这天起结束这段生理期记录吗？', function () {
    api('api/periods?date=' + date, { method: 'DELETE' }).then(function (res) {
      if (res.ok) { toast('已从这天结束'); loadMonth(); selectDay(selectedDate); loadToday(); }
      else toast(res.error || '没改动');
    });
  });
}

// 「今天结束了」：确认这段生理期到此为止（截断到今天，或确认昨天为止），不删已记的天。
function endPeriod(date) {
  askConfirm('这段生理期到今天结束了吗？已记的日期都会保留。', function () {
    api('api/periods/end', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: date }),
    }).then(function (res) {
      if (res.ok) {
        toast(res.changed ? '记好啦，这段生理期到此为止' : '这段生理期已经结束了');
        loadMonth(); selectDay(selectedDate); loadToday();
      } else toast(res.error || '没改动');
    });
  });
}

function togglePeriodPicker() {
  var el = document.getElementById('period-picker');
  if (!el) return;
  el.classList.toggle('hidden');
}

function markPeriodFromPicker() {
  var v = document.getElementById('period-start').value;
  if (!v) { toast('选个日期吧'); return; }
  api('api/periods', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: v }),
  }).then(function (res) {
    if (res.ok) { toast('记下生理期啦'); loadMonth(); selectDay(selectedDate); loadToday(); }
    else toast(res.error || '没记成');
  });
}

function toggleTodo(id) {
  api('api/events/' + id + '/toggle', { method: 'POST' }).then(function (res) {
    if (res.ok) { toast(res.event.done ? '完成啦' : '取消完成'); loadMonth(); selectDay(selectedDate); loadToday(); }
    else toast(res.error || '没改动');
  });
}

function delEvent(id) {
  askConfirm('要删掉这条吗？删掉后无法恢复。', function () {
    api('api/events/' + id, { method: 'DELETE' }).then(function (res) {
      if (res.ok) { toast('删掉了'); loadMonth(); selectDay(selectedDate); loadToday(); }
      else toast(res.error || '没删掉');
    });
  });
}

function summaryDomKey(date, agentId) {
  return encodeURIComponent(String(date || '') + '|' + String(agentId || 'legacy'));
}

function jsArg(value) {
  var slash = String.fromCharCode(92);
  return "'" + String(value == null ? '' : value)
    .split(slash).join(slash + slash)
    .split("'").join(slash + "'")
    .split(String.fromCharCode(13)).join(slash + 'r')
    .split(String.fromCharCode(10)).join(slash + 'n') + "'";
}

function jsArgs(date, agentId) {
  return jsArg(date) + ',' + jsArg(agentId);
}

function loadSummaries(skipJobs) {
  if (!skipJobs) loadSummaryJobs();
  api('api/summaries').then(function (res) {
    var list = document.getElementById('summaries-list');
    if (!res.ok) return;
    var arr = res.summaries || [];
    if (!arr.length) {
      list.innerHTML = '<div class="archive-empty">时光册还空着。<br>先回到日历，把已经结束的日子做成一页吧。</div>';
      return;
    }
    var month = '';
    var day = '';
    var html = '';
    arr.forEach(function (s) {
      var key = summaryDomKey(s.date, s.agentId);
      var m = s.date.slice(0, 7);
      if (m !== month) { month = m; html += '<div class="month-title">' + esc(m.replace('-', ' 年 ') + ' 月') + '</div>'; }
      // 按天分组：同一天的条目收进同一个小节，日期标题只出现一次
      if (s.date !== day) {
        day = s.date;
        html += '<div class="day-title"><span class="day-date">' + esc(s.date.slice(5)) + '</span><span class="day-label">这一天</span></div>';
      }
      html += '<div class="archive-item" id="archive-' + key + '" data-summary-date="' + esc(s.date) + '">' +
        '<span class="a-agent' + (s.unclassified ? ' legacy' : '') + '">' + esc(s.agentName || (s.unclassified ? '未分类的一页' : s.agentId)) + '</span>' +
        '<div class="a-text" id="archive-text-' + key + '">' + esc(s.text) + '</div>' +
        '<div class="archive-actions">' +
        '<button onclick="editSummary(' + jsArgs(s.date, s.agentId) + ')">编辑</button>' +
        '<button onclick="openSummaryChat(' + jsArgs(s.date, s.agentId) + ',' + jsArg(s.agentName || (s.agentId ? s.agentId : '未分类的一页')) + ')">和小花聊聊</button>' +
        '<button class="danger" onclick="deleteSummary(' + jsArgs(s.date, s.agentId) + ',' + jsArg(s.agentName || '这位伙伴') + ')">删除</button>' +
        '</div></div>';
    });
    list.innerHTML = html;
  }).catch(function () {
    var list = document.getElementById('summaries-list');
    if (list) list.innerHTML = '<div class="archive-empty">时光册加载失败，稍后再试。</div>';
  });
}

function summaryJobStatusText(status) {
  return ({ queued: '排队中', running: '正在做成册', completed: '这本册子做好啦', completed_with_errors: '有几页没做好', failed: '这次没做成' })[status] || '正在做';
}

// 汇总失败页明细：哪些日期没做好、原因是什么。
function summaryJobFailedItems(job) {
  var list = Array.isArray(job.outcomes) ? job.outcomes : [];
  return list.filter(function (item) { return item && item.status === 'failed'; });
}

function renderSummaryJobs(jobs) {
  var boxes = [document.getElementById('summary-jobs'), document.getElementById('summary-jobs-calendar')].filter(function (box) { return !!box; });
  if (!boxes.length) return;
  var list = Array.isArray(jobs) ? jobs : [];
  // 已经确认收下的册子不再显示进度卡。
  var visible = list.filter(function (item) { return !(item.status === 'completed' && item.dismissedAt); });
  var job = visible.find(function (item) { return item.status === 'queued' || item.status === 'running'; }) || visible[0];
  if (!job) {
    boxes.forEach(function (box) { box.classList.add('hidden'); box.innerHTML = ''; });
    return;
  }
  var progress = job.progress || {};
  var done = Number(progress.done || 0);
  var total = Number(progress.total || (job.dates || []).length || 0);
  var percent = total ? Math.max(0, Math.min(100, Math.round(done * 100 / total))) : 0;
  var detail;
  if (job.status === 'completed' || job.status === 'completed_with_errors') {
    detail = total > 1 ? '共 ' + total + ' 天，已做好 ' + done + ' 页' : (done ? '这一页已经做好' : '这一页没做好');
  } else {
    detail = total > 1 ? '共 ' + total + ' 天，已做好 ' + done + ' 页' : (done ? '这一页已经做好' : '正在准备');
  }
  if (job.currentDate) detail += ' · 当前 ' + job.currentDate;
  var error = job.error ? '<div class="summary-job-error">' + esc(job.error) + '</div>' : '';
  var retryHtml = '';
  if (job.status === 'completed_with_errors') {
    var failedItems = summaryJobFailedItems(job);
    var failedLines = failedItems.map(function (item) {
      var reason = item.error ? '：' + item.error : '';
      return '<div class="summary-job-failed-item">' + esc(item.date) + reason + '</div>';
    }).join('');
    retryHtml = '<div class="summary-job-failed">' + failedLines + '</div>' +
      '<button type="button" class="btn primary summary-job-retry-btn" onclick="retrySummaryJobFailed(' + jsArg(job.id) + ')">重新生成失败部分</button>';
  } else if (job.status === 'completed') {
    retryHtml = '<button type="button" class="btn summary-job-dismiss-btn" onclick="dismissSummaryJob(' + jsArg(job.id) + ')">知道了</button>';
  }
  var html = '<div class="summary-job-head"><span>做成册进度</span><span class="summary-job-status">' + esc(summaryJobStatusText(job.status)) + '</span></div>' +
    '<div class="summary-job-track"><div class="summary-job-progress" style="width:' + percent + '%"></div></div>' +
    '<div class="summary-job-detail">' + esc(detail) + '</div>' + error + retryHtml;
  boxes.forEach(function (box) {
    box.innerHTML = html;
    box.classList.remove('hidden');
  });
}

// 重新生成失败部分：只重做上一次任务里没做好的页，成功页不动。
function retrySummaryJobFailed(jobId) {
  api('api/summaries/jobs/' + encodeURIComponent(jobId) + '/retry-failed', { method: 'POST' }).then(function (res) {
    if (!res.ok) {
      if (res.job) { loadSummaryJobs(); toast(res.error || '重新生成失败'); }
      else toast(res.error || '重新生成失败');
      return;
    }
    toast('失败的部分重新放进后台了，马上重做');
    summaryJobWasActive = true;
    loadSummaryJobs();
  }).catch(function () {
    toast('重新生成失败，稍后再试');
  });
}

// 知道了：确认收下这本册子，进度卡退场，刷新后不再显示。
function dismissSummaryJob(jobId) {
  api('api/summaries/jobs/' + encodeURIComponent(jobId) + '/dismiss', { method: 'POST' }).then(function (res) {
    if (!res.ok) { toast(res.error || '确认失败'); return; }
    loadSummaryJobs();
  }).catch(function () {
    toast('确认失败，稍后再试');
  });
}

function loadSummaryJobs() {
  api('api/summaries/jobs').then(function (res) {
    if (!res.ok) return;
    var active = !!res.active;
    var justFinished = summaryJobWasActive && !active;
    summaryJobWasActive = active;
    renderSummaryJobs(res.jobs || []);
    if (summaryJobsTimer) { clearTimeout(summaryJobsTimer); summaryJobsTimer = null; }
    if (justFinished) {
      loadSummaries(true);
      loadMonth();
      if (selectedDate) selectDay(selectedDate);
    }
    if (active) summaryJobsTimer = setTimeout(function () { summaryJobsTimer = null; loadSummaryJobs(); }, 1200);
  }).catch(function () {
    if (summaryJobWasActive && !summaryJobsTimer) summaryJobsTimer = setTimeout(function () { summaryJobsTimer = null; loadSummaryJobs(); }, 2000);
  });
}

function toggleSummaryBatchMode(force) {
  var next = typeof force === 'boolean' ? force : !summarySelectMode;
  summarySelectMode = next;
  var panel = document.getElementById('summary-batch-panel');
  var toggle = document.getElementById('summary-batch-toggle');
  var detail = document.getElementById('detail');
  if (panel) panel.classList.toggle('hidden', !next);
  if (toggle) toggle.textContent = next ? '退出多选' : '选几天做成册';
  if (detail) detail.classList.toggle('hidden', next || !selectedDate);
  if (!next) {
    summaryBatchDates = [];
    var msg = document.getElementById('summary-batch-msg');
    if (msg) msg.textContent = '';
  }
  syncSelectedCellState();
  renderSummaryBatchDates();
  loadMonth();
}

function renderSummaryBatchDates() {
  var box = document.getElementById('summary-batch-dates');
  var count = document.getElementById('summary-batch-count');
  var run = document.getElementById('summary-batch-run-btn');
  if (count) count.textContent = '已选 ' + summaryBatchDates.length + ' 天';
  if (run) run.disabled = !summaryBatchDates.length;
  if (!box) return;
  if (!summaryBatchDates.length) {
    box.className = 'summary-batch-dates empty';
    box.textContent = '还没选日期';
    return;
  }
  box.className = 'summary-batch-dates';
  box.innerHTML = summaryBatchDates.map(function (date) {
    return '<span class="summary-batch-chip">' + esc(date) + '<button type="button" title="移除" onclick="removeSummaryBatchDate(' + jsArg(date) + ')">×</button></span>';
  }).join('');
}

function toggleSummaryBatchDate(date) {
  if (!summarySelectMode) return;
  var index = summaryBatchDates.indexOf(date);
  if (index >= 0) summaryBatchDates.splice(index, 1);
  else if (summaryBatchDates.length >= 31) {
    var msg = document.getElementById('summary-batch-msg');
    if (msg) msg.textContent = '一次最多选 31 天';
    return;
  } else summaryBatchDates.push(date);
  summaryBatchDates.sort();
  var msg = document.getElementById('summary-batch-msg');
  if (msg) msg.textContent = '';
  syncSelectedCellState();
  renderSummaryBatchDates();
  loadMonth();
}

function removeSummaryBatchDate(date) {
  summaryBatchDates = summaryBatchDates.filter(function (item) { return item !== date; });
  syncSelectedCellState();
  renderSummaryBatchDates();
  loadMonth();
}

function clearSummaryBatchDates() {
  summaryBatchDates = [];
  syncSelectedCellState();
  renderSummaryBatchDates();
  var msg = document.getElementById('summary-batch-msg');
  if (msg) msg.textContent = '';
  if (summarySelectMode) loadMonth();
}

function queueSummaryDates(dates, messageEl, clearBatch) {
  var values = Array.from(new Set((dates || []).filter(Boolean))).sort();
  if (!values.length) { if (messageEl) messageEl.textContent = '先选一天'; else toast('先选一天'); return; }
  if (messageEl) messageEl.textContent = '已放到后台，切走页面也会继续…';
  api('api/summaries/jobs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dates: values, force: true }),
  }).then(function (res) {
    if (!res.ok) { if (messageEl) messageEl.textContent = res.error || '后台任务没建成'; else toast(res.error || '后台任务没建成'); return; }
    var successText = values.length > 1 ? '这几页已放到后台做成册' : '这一页已放到后台做好';
    if (clearBatch) toggleSummaryBatchMode(false);
    if (messageEl && !clearBatch) messageEl.textContent = successText;
    if (!messageEl || clearBatch) toast(successText);
    if (res.job) renderSummaryJobs([res.job]);
    loadSummaryJobs();
  }).catch(function () {
    if (messageEl) messageEl.textContent = '后台任务没建成，稍后再试';
    else toast('后台任务没建成，稍后再试');
  });
}

function runSummaryBatch() {
  queueSummaryDates(summaryBatchDates, document.getElementById('summary-batch-msg'), true);
}

function editSummary(date, agentId) {
  var key = summaryDomKey(date, agentId);
  var textEl = document.getElementById('archive-text-' + key);
  if (!textEl) return;
  var current = textEl.textContent;
  // 编辑态：把原来的操作按钮（修改/编辑/和小花聊聊/删除）隐藏，只留编辑框 + 保存/取消
  var ops = textEl.nextElementSibling;
  if (ops && ops.classList && ops.classList.contains('archive-actions')) ops.style.display = 'none';
  textEl.innerHTML = '<textarea class="archive-editor" id="archive-editor-' + key + '">' + esc(current) + '</textarea>' +
    '<div class="archive-actions"><button onclick="saveSummaryEdit(' + jsArgs(date, agentId) + ')">保存修改</button>' +
    '<button onclick="cancelSummaryEdit()">取消</button></div>';
}

function saveSummaryEdit(date, agentId) {
  var editor = document.getElementById('archive-editor-' + summaryDomKey(date, agentId));
  var text = editor ? editor.value.trim() : '';
  if (!text) { toast('这一页的内容不能为空'); return; }
  applySummaryText(date, agentId, text);
}

function cancelSummaryEdit() {
  // 详情区块（这一页）有选中日期 → 重新渲染这一天；否则在时光册里 → 重新加载列表
  if (selectedDate) selectDay(selectedDate);
  else loadSummaries();
}

var summaryChatDate = '';
var summaryChatAgentId = '';
var summaryChatAgentName = '';
var summaryChatOriginal = '';
var summaryChatSessionId = '';
var summaryChatSuggestion = '';
var summaryChatRun = 0;
var summaryChatReturnFocus = null;

function appendSummaryChatBubble(role, text) {
  var messages = document.getElementById('summary-chat-messages');
  if (!messages) return null;
  var bubble = document.createElement('div');
  bubble.className = 'summary-chat-bubble ' + role;
  bubble.textContent = text;
  messages.appendChild(bubble);
  messages.scrollTop = messages.scrollHeight;
  return bubble;
}

function openSummaryChat(date, agentId, agentName) {
  var key = summaryDomKey(date, agentId);
  var textEl = document.getElementById('archive-text-' + key);
  if (!textEl) return;
  summaryChatReturnFocus = document.activeElement;
  summaryChatRun += 1;
  summaryChatDate = date;
  summaryChatAgentId = agentId || '';
  summaryChatAgentName = agentName || '未分类的一页';
  summaryChatOriginal = textEl.textContent;
  summaryChatSessionId = '';
  summaryChatSuggestion = '';
  document.getElementById('summary-chat-subtitle').textContent = date + ' · ' + summaryChatAgentName;
  document.getElementById('summary-chat-original').textContent = summaryChatOriginal;
  document.getElementById('summary-chat-messages').innerHTML = '';
  document.getElementById('summary-chat-input').value = '';
  document.getElementById('summary-chat-before').textContent = '';
  document.getElementById('summary-chat-after').textContent = '';
  document.getElementById('summary-chat-suggestion').hidden = true;
  var send = document.getElementById('summary-chat-send');
  send.disabled = false;
  send.textContent = '发送';
  var confirm = document.getElementById('summary-chat-confirm');
  confirm.disabled = false;
  confirm.textContent = '确认修改';
  document.getElementById('summary-chat-modal').hidden = false;
  appendSummaryChatBubble('assistant', '你想把这一页哪里改一改？直接和我说就好。我们聊清楚后，我再整理成修改建议给你确认。');
  setTimeout(function () { document.getElementById('summary-chat-input').focus(); }, 80);
}

function sendSummaryChat() {
  var input = document.getElementById('summary-chat-input');
  var message = input ? input.value.trim() : '';
  if (!message) return;
  var run = summaryChatRun;
  summaryChatSuggestion = '';
  document.getElementById('summary-chat-suggestion').hidden = true;
  appendSummaryChatBubble('user', message);
  input.value = '';
  var send = document.getElementById('summary-chat-send');
  send.disabled = true;
  send.textContent = '想一想…';
  var thinking = appendSummaryChatBubble('thinking', '小花正在认真看这一页…');
  api('api/summaries/' + summaryChatDate + '/revise', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: message, agentId: summaryChatAgentId, session_id: summaryChatSessionId }),
  }).then(function (res) {
    if (run !== summaryChatRun) return;
    if (thinking) thinking.remove();
    if (!res.ok) { appendSummaryChatBubble('error', res.error || '这轮没聊成，稍后再试'); return; }
    summaryChatSessionId = res.session_id || summaryChatSessionId;
    appendSummaryChatBubble('assistant', res.reply || '我在听。');
    if (res.suggestion) renderSummaryChatSuggestion(res.suggestion, res.original || summaryChatOriginal);
  }).catch(function () {
    if (run !== summaryChatRun) return;
    if (thinking) thinking.remove();
    appendSummaryChatBubble('error', '刚才没连上，再发一次就好。');
  }).finally(function () {
    if (run !== summaryChatRun) return;
    send.disabled = false;
    send.textContent = '发送';
    input.focus();
  });
}

function renderSummaryChatSuggestion(suggestion, original) {
  summaryChatSuggestion = suggestion || '';
  document.getElementById('summary-chat-before').textContent = original || summaryChatOriginal;
  document.getElementById('summary-chat-after').textContent = summaryChatSuggestion;
  document.getElementById('summary-chat-suggestion').hidden = false;
}

function continueSummaryChat() {
  summaryChatSuggestion = '';
  document.getElementById('summary-chat-suggestion').hidden = true;
  document.getElementById('summary-chat-input').focus();
  document.getElementById('summary-chat-messages').scrollTop = document.getElementById('summary-chat-messages').scrollHeight;
}

function confirmSummaryChat() {
  if (!summaryChatSessionId || !summaryChatSuggestion) return;
  var run = summaryChatRun;
  var button = document.getElementById('summary-chat-confirm');
  button.disabled = true;
  button.textContent = '保存中…';
  api('api/summaries/' + summaryChatDate + '/revise/confirm', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: summaryChatSessionId, agentId: summaryChatAgentId }),
  }).then(function (res) {
    if (run !== summaryChatRun) return;
    if (!res.ok) { appendSummaryChatBubble('error', res.error || '修改没有保存'); return; }
    toast('这一页改好了');
    closeSummaryChat(false);
    loadSummaries();
    if (selectedDate) selectDay(selectedDate);
  }).catch(function () {
    if (run === summaryChatRun) appendSummaryChatBubble('error', '保存时断开了，再点一次确认就好。');
  }).finally(function () {
    if (run !== summaryChatRun) return;
    button.disabled = false;
    button.textContent = '确认修改';
  });
}

function closeSummaryChat(notifyServer) {
  var date = summaryChatDate;
  var agentId = summaryChatAgentId;
  var sessionId = summaryChatSessionId;
  var returnFocus = summaryChatReturnFocus;
  summaryChatRun += 1;
  document.getElementById('summary-chat-modal').hidden = true;
  summaryChatDate = '';
  summaryChatAgentId = '';
  summaryChatAgentName = '';
  summaryChatOriginal = '';
  summaryChatSessionId = '';
  summaryChatSuggestion = '';
  summaryChatReturnFocus = null;
  if (returnFocus && returnFocus.isConnected && typeof returnFocus.focus === 'function') returnFocus.focus();
  if (notifyServer !== false && date && sessionId) {
    api('api/summaries/' + date + '/revise/close', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: sessionId, agentId: agentId }),
    }).catch(function () {});
  }
}

document.getElementById('summary-chat-input').addEventListener('keydown', function (event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    if (!document.getElementById('summary-chat-send').disabled) sendSummaryChat();
  }
});

document.getElementById('summary-chat-modal').addEventListener('keydown', function (event) {
  if (event.key !== 'Tab' || this.hidden) return;
  var nodes = Array.from(this.querySelectorAll('button:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'));
  if (!nodes.length) return;
  var first = nodes[0];
  var last = nodes[nodes.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

function applySummaryText(date, agentId, text) {
  var key = summaryDomKey(date, agentId);
  api('api/summaries/' + date, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: text, agentId: agentId || '' }),
  }).then(function (res) {
    if (res.ok) {
      toast('这一页改好了');
      loadSummaries();
      // 详情区块（这一页）也在展示时同步刷新，让改动立刻可见
      if (selectedDate) selectDay(selectedDate);
    }
    else toast(res.error || '没存上');
  });
}

function deleteSummary(date, agentId, agentName) {
  askConfirm('要删除 ' + date + ' 的「' + (agentName || '这一页') + '」吗？', function () {
    var query = '?agentId=' + encodeURIComponent(agentId || '');
    api('api/summaries/' + date + query, { method: 'DELETE' }).then(function (res) {
      if (res.ok) { toast('这一页删掉了'); loadSummaries(); }
      else toast(res.error || '没删掉');
    });
  });
}

/* ── 设置弹窗 ── */
function openSettingsModal() {
  document.getElementById('set-modal').hidden = false;
  loadSettings();
}
function closeSettingsModal() {
  document.getElementById('set-modal').hidden = true;
}
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') {
    var confirmModal = document.getElementById('confirm-modal');
    if (confirmModal && !confirmModal.hidden) { closeConfirm(); return; }
    var summaryChatModal = document.getElementById('summary-chat-modal');
    if (summaryChatModal && !summaryChatModal.hidden) { closeSummaryChat(); return; }
    var modal = document.getElementById('set-modal');
    if (modal && !modal.hidden) closeSettingsModal();
  }
});

var MODE_LABELS = {
  economical: '适时',
  balanced: '相伴',
  always: '常在',
};
var MODE_TIPS = {
  economical: '新对话、跨天或拾光记内容变化时带一次，平时不重复打扰。',
  balanced: '两次说话之间空档达到下方时长，回来时带一次。',
  always: '你每次开口时都带上今日情境，陪伴感最完整。',
};

function segVal(segId) {
  var b = document.querySelector('#' + segId + ' .seg-btn.active');
  if (!b) return '';
  return b.getAttribute('data-val') || b.getAttribute('data-mode');
}

function setSeg(segId, val) {
  document.querySelectorAll('#' + segId + ' .seg-btn').forEach(function (b) {
    var v = b.getAttribute('data-val') || b.getAttribute('data-mode');
    b.classList.toggle('active', String(v) === String(val));
  });
}

function updateQuickInjectionToggle() {
  var btn = document.getElementById('context-toggle-btn');
  if (!btn) return;
  var enabled = appSettings.injectionEnabled !== false;
  btn.textContent = enabled ? '情境注入·开' : '情境注入·关';
  btn.classList.toggle('off', !enabled);
  btn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
}

function syncInjectionUi(enabled) {
  var active = enabled !== false;
  var options = document.getElementById('injection-options');
  var disabledTip = document.getElementById('injection-disabled-tip');
  if (options) options.classList.toggle('hidden', !active);
  if (disabledTip) disabledTip.classList.toggle('hidden', active);
}

function toggleInjectionQuick() {
  var next = appSettings.injectionEnabled === false;
  var btn = document.getElementById('context-toggle-btn');
  if (btn) btn.disabled = true;
  api('api/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ injectionEnabled: next }),
  }).then(function (res) {
    if (!res.ok) { toast(res.error || '情境开关没改成'); return; }
    appSettings = Object.assign(appSettings, res.settings || { injectionEnabled: next });
    setSeg('injection-enabled-seg', appSettings.injectionEnabled !== false);
    syncInjectionUi(appSettings.injectionEnabled !== false);
    updateQuickInjectionToggle();
    toast(appSettings.injectionEnabled === false ? '已关掉助手情境' : '助手会收到今日情境了');
  }).catch(function () {
    toast('情境开关没改成，检查一下连接');
  }).then(function () {
    if (btn) btn.disabled = false;
  });
}

function syncWeatherSettingsUi(enabled) {
  var active = enabled !== false;
  ['weather-province', 'weather-city', 'weather-district'].forEach(function (id) {
    setWeatherSelectDisabled(id, !active);
  });
  var clear = document.querySelector('.weather-clear-btn');
  if (clear) clear.disabled = !active;
  var test = document.getElementById('weather-test-btn');
  if (test) test.disabled = !active;
  if (!active) {
    var msg = document.getElementById('weather-test-msg');
    if (msg) msg.textContent = '';
  }
}

function setWeatherSelectDisabled(id, disabled) {
  var sel = document.getElementById(id);
  if (!sel) return;
  sel.disabled = !!disabled;
  var wrap = sel.closest ? sel.closest('.dd') : null;
  if (wrap) {
    wrap.classList.toggle('disabled', !!disabled);
    var trigger = wrap.querySelector('.dd-trigger');
    if (trigger) trigger.disabled = !!disabled;
  }
}

function setWeatherSelectOptions(id, placeholder, options, disabled) {
  var sel = document.getElementById(id);
  if (!sel) return;
  var html = '<option value="">' + esc(placeholder) + '</option>';
  (options || []).forEach(function (option) {
    html += '<option value="' + esc(option.value) + '">' + esc(option.label) + '</option>';
  });
  sel.innerHTML = html;
  setWeatherSelectDisabled(id, disabled);
  refreshOneSelect(id);
}

function uniqueWeatherOptions(items, key) {
  var seen = {};
  var result = [];
  (items || []).forEach(function (item) {
    var value = String(item[key] || '');
    if (!value || seen[value]) return;
    seen[value] = true;
    result.push({ value: value, label: value });
  });
  return result;
}

function weatherRegionByCode(code) {
  var wanted = String(code || '');
  if (!wanted) return null;
  for (var i = 0; i < weatherRegions.length; i++) {
    if (String(weatherRegions[i].code) === wanted) return weatherRegions[i];
  }
  return null;
}

function weatherRegionLabel(region) {
  if (!region) return '';
  return [region.province, region.city, region.district].filter(Boolean).join(' ');
}

function setWeatherLegacyNote(text) {
  var note = document.getElementById('weather-legacy-note');
  if (!note) return;
  note.textContent = text || '';
  note.classList.toggle('hidden', !text);
}

function populateWeatherProvinces(selectedProvince) {
  var provinceSelect = document.getElementById('weather-province');
  var options = uniqueWeatherOptions(weatherRegions, 'province');
  setWeatherSelectOptions('weather-province', '选择省份', options, false);
  if (selectedProvince && options.some(function (item) { return item.value === selectedProvince; })) {
    provinceSelect.value = selectedProvince;
  } else {
    provinceSelect.value = '';
  }
  refreshOneSelect('weather-province');
  populateWeatherCities(provinceSelect.value, '', '');
}

function populateWeatherCities(province, selectedCity, selectedCode) {
  var citySelect = document.getElementById('weather-city');
  var regions = weatherRegions.filter(function (region) { return region.province === province; });
  var options = uniqueWeatherOptions(regions, 'city');
  setWeatherSelectOptions('weather-city', province ? '选择城市' : '先选省份', options, !province);
  if (selectedCity && options.some(function (item) { return item.value === selectedCity; })) {
    citySelect.value = selectedCity;
  } else {
    citySelect.value = '';
  }
  refreshOneSelect('weather-city');
  populateWeatherDistricts(province, citySelect.value, selectedCode || '');
}

function populateWeatherDistricts(province, city, selectedCode) {
  var districtSelect = document.getElementById('weather-district');
  var regions = weatherRegions.filter(function (region) {
    return region.province === province && region.city === city;
  });
  var options = regions.map(function (region) {
    return { value: String(region.code), label: region.district };
  });
  setWeatherSelectOptions('weather-district', city ? '选择区县' : '先选城市', options, !city);
  if (selectedCode && options.some(function (item) { return item.value === String(selectedCode); })) {
    districtSelect.value = String(selectedCode);
  } else {
    districtSelect.value = '';
  }
  refreshOneSelect('weather-district');
}

function selectedWeatherRegion() {
  var district = document.getElementById('weather-district');
  return district ? weatherRegionByCode(district.value) : null;
}

function renderWeatherRegion(area, rawLocation) {
  weatherSettingsState = { location: String(rawLocation || '').trim(), area: area || null };
  weatherSelectionTouched = false;
  if (!weatherRegions.length) {
    setWeatherLegacyNote(rawLocation ? '区县列表还没加载好，原地点会保留；重新打开设置再选。' : '区县列表加载中…');
    return;
  }
  var target = area && weatherRegionByCode(area.code);
  if (target) {
    populateWeatherProvinces(target.province);
    populateWeatherCities(target.province, target.city, target.code);
    setWeatherLegacyNote('');
    return;
  }
  populateWeatherProvinces('');
  if (rawLocation) {
    setWeatherLegacyNote('原来保存的地点是「' + rawLocation + '」，请重新选到区县；在你保存前它会继续保留。');
  } else {
    setWeatherLegacyNote('');
  }
}

function loadWeatherRegions() {
  if (weatherRegions.length) return Promise.resolve(weatherRegions);
  if (weatherRegionsPromise) return weatherRegionsPromise;
  weatherRegionsPromise = api('api/weather/regions').then(function (res) {
    if (!res.ok || !Array.isArray(res.regions)) throw new Error(res.error || '区县列表加载失败');
    weatherRegions = res.regions;
    return weatherRegions;
  }).catch(function (error) {
    weatherRegionsPromise = null;
    setWeatherLegacyNote(error.message || '区县列表加载失败，稍后再试');
    return [];
  });
  return weatherRegionsPromise;
}

function renderSummaryAgents(agents, selectedIds) {
  var picker = document.getElementById('summary-agent-picker');
  summaryAgents = Array.isArray(agents) ? agents.filter(function (agent) { return agent && agent.agentId; }) : [];
  summaryAgentSelectionLoaded = true;
  if (!picker) return;
  if (!summaryAgents.length) {
    picker.innerHTML = '<span class="set-tip">还没有可做册的伙伴记录。</span>';
    return;
  }
  var selected = Array.isArray(selectedIds)
    ? new Set(selectedIds.map(function (id) { return String(id); }))
    : new Set(summaryAgents.map(function (agent) { return String(agent.agentId); }));
  var options = summaryAgents.map(function (agent) {
    var id = String(agent.agentId);
    var name = String(agent.agentName || id);
    return '<label class="summary-agent-option"><input type="checkbox" class="summary-agent-check" data-agent-id="' + esc(id) + '"' + (selected.has(id) ? ' checked' : '') + '><span title="' + esc(name) + '">' + esc(name) + '</span></label>';
  }).join('');
  picker.innerHTML = '<div class="summary-agent-options">' + options + '</div>' +
    '<div class="summary-agent-actions"><button class="link-btn" type="button" onclick="selectAllSummaryAgents()">全选</button>' +
    '<button class="link-btn" type="button" onclick="clearSummaryAgents()">全不选</button></div>';
}

function selectAllSummaryAgents() {
  document.querySelectorAll('.summary-agent-check').forEach(function (check) { check.checked = true; });
}

function clearSummaryAgents() {
  document.querySelectorAll('.summary-agent-check').forEach(function (check) { check.checked = false; });
}

function getSummaryAgentIdsFromUI() {
  if (!summaryAgentSelectionLoaded || !summaryAgents.length) return undefined;
  var selected = Array.from(document.querySelectorAll('.summary-agent-check:checked')).map(function (check) {
    return check.getAttribute('data-agent-id') || '';
  }).filter(Boolean);
  return selected.length === summaryAgents.length ? null : selected;
}

function loadSettings() {
  Promise.all([api('api/settings'), loadWeatherRegions()]).then(function (parts) {
    var res = parts[0];
    if (!res.ok) return;
    var s = res.settings;
    appSettings = Object.assign(appSettings, s);
    setSeg('injection-enabled-seg', s.injectionEnabled !== false);
    syncInjectionUi(s.injectionEnabled !== false);
    updateQuickInjectionToggle();
    setSeg('mode-seg', s.injectMode);
    setSeg('interval-seg', s.injectIntervalHours);
    setSeg('autosum-seg', s.autoSummary);
    setSeg('summary-shared-seg', s.summaryShared === true);
    var boundary = document.getElementById('boundary-select');
    boundary.value = String(s.dayBoundaryHour == null ? 4 : s.dayBoundaryHour);
    refreshOneSelect('boundary-select');
    document.getElementById('mode-tip').textContent = MODE_TIPS[s.injectMode] || '';
    document.getElementById('mode-tip-row').classList.toggle('hidden', false);
    document.getElementById('interval-row').classList.toggle('hidden', s.injectMode !== 'balanced');
    // 注入间隔提示：解释「间隔 + 数据变化即时刷新」机制，避免用户以为改完要等半天
    var itip = document.getElementById('interval-tip');
    var irow = document.getElementById('interval-extra-row');
    if (itip && irow) {
      itip.textContent = '相伴指「两次说话之间的空档」；达到这里的时长，回来才刷新一次。中途新增日子、确认生理期、生成总结，下一条消息就会带上，不用等。';
      irow.classList.toggle('hidden', s.injectMode !== 'balanced');
    }
    setSeg('period-seg', s.showPeriod !== false);
    setSeg('weather-seg', s.weatherEnabled !== false);
    renderSummaryAgents(s.summaryAgents || [], s.summaryAgentIds);
    renderWeatherRegion(s.weatherArea || null, s.weatherLocation || '');
    syncWeatherSettingsUi(s.weatherEnabled !== false);
    weatherSettingsState.location = s.weatherLocation || '';
    loadModelConfig();
  });
}

function collectWeatherSettings() {
  if (!weatherSelectionTouched) {
    return {
      weatherLocation: weatherSettingsState.location || '',
      weatherArea: weatherSettingsState.area || null,
    };
  }
  var province = document.getElementById('weather-province').value;
  var city = document.getElementById('weather-city').value;
  var region = selectedWeatherRegion();
  if (!province && !city && !region) return { weatherLocation: '', weatherArea: null };
  if (!region) return { error: '还差最后一步，选到区县再保存嘛' };
  return {
    weatherLocation: weatherRegionLabel(region),
    weatherArea: {
      code: region.code,
      province: region.province,
      city: region.city,
      district: region.district,
      latitude: region.latitude,
      longitude: region.longitude,
    },
  };
}

function clearWeatherRegion() {
  weatherSelectionTouched = true;
  weatherSettingsState = { location: '', area: null };
  populateWeatherProvinces('');
  setWeatherLegacyNote('');
  document.getElementById('weather-test-msg').textContent = '';
}

function saveAllSettings() {
  var weatherPatch = collectWeatherSettings();
  if (weatherPatch.error) { toast(weatherPatch.error); return; }
  var body = Object.assign({
    injectionEnabled: segVal('injection-enabled-seg') !== 'false',
    injectMode: segVal('mode-seg'),
    injectIntervalHours: +segVal('interval-seg'),
    autoSummary: segVal('autosum-seg') === 'true',
    dayBoundaryHour: +document.getElementById('boundary-select').value,
    summaryShared: segVal('summary-shared-seg') === 'true',
    showPeriod: segVal('period-seg') === 'true',
    weatherEnabled: segVal('weather-seg') !== 'false',
  }, weatherPatch);
  var summaryAgentIds = getSummaryAgentIdsFromUI();
  if (summaryAgentIds !== undefined) body.summaryAgentIds = summaryAgentIds;
  api('api/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(function (res) {
    if (res.ok) {
      appSettings = Object.assign(appSettings, res.settings || body);
      weatherSettingsState = {
        location: (res.settings && res.settings.weatherLocation) || body.weatherLocation || '',
        area: (res.settings && res.settings.weatherArea) || body.weatherArea || null,
      };
      weatherSelectionTouched = false;
      setWeatherLegacyNote('');
      setSeg('injection-enabled-seg', appSettings.injectionEnabled !== false);
      setSeg('weather-seg', appSettings.weatherEnabled !== false);
      syncInjectionUi(appSettings.injectionEnabled !== false);
      updateQuickInjectionToggle();
      syncWeatherSettingsUi(appSettings.weatherEnabled !== false);
      loadMonth(); loadToday();
      if (selectedDate) selectDay(selectedDate);
      toast('设置都保存好了');
    } else toast(res.error || '没存上');
  });
}

function previewInjection() {
  var box = document.getElementById('inject-preview');
  box.classList.remove('hidden');
  box.textContent = '正在整理预览…';
  api('api/injection-preview').then(function (res) {
    box.textContent = res.ok ? res.text : (res.error || '预览失败');
  });
}

// ── 天气测试 ──
function testWeather() {
  var msg = document.getElementById('weather-test-msg');
  if (segVal('weather-seg') === 'false') {
    msg.textContent = '今日天气已关闭，打开后才能查询嘛';
    return;
  }
  var region = selectedWeatherRegion();
  if (!region) {
    msg.textContent = weatherRegions.length ? '先选到区县再测试嘛' : '区县列表还没加载好，稍等一下';
    return;
  }
  msg.textContent = '查天气中…';
  api('api/weather/test?code=' + encodeURIComponent(region.code)).then(function (res) {
    if (res.ok && res.weather) {
      msg.textContent = '✓ ' + res.weather.place + '：' + res.weather.line;
    } else {
      msg.textContent = '⚠ ' + (res.error || '没查到，检查网络');
    }
  }).catch(function () {
    msg.textContent = '⚠ 查询失败，检查网络';
  });
}

/* ── 设置 · 三档模型配置 ── */
var mcState = { source: 'agent', hanaModels: [], config: null };
var mcPendingEcho = null;

function mcSetSource(src) {
  mcState.source = src;
  document.querySelectorAll('.mc-source-btn').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-source') === src);
  });
  document.getElementById('mc-form-agent').style.display = src === 'agent' ? '' : 'none';
  document.getElementById('mc-form-hana').style.display = src === 'hana' ? '' : 'none';
  document.getElementById('mc-form-custom').style.display = src === 'custom' ? '' : 'none';
  document.getElementById('mc-test-result').textContent = '';
}

function mcFillProviders() {
  var sel = document.getElementById('mc-provider');
  var seen = {};
  var list = [];
  mcState.hanaModels.forEach(function (m) {
    var pid = m.providerId || m.provider;
    if (pid && !seen[pid]) { seen[pid] = 1; list.push(pid); }
  });
  sel.innerHTML = '<option value="">请选择</option>' + list.map(function (p) {
    return '<option value="' + esc(p) + '">' + esc(p) + '</option>';
  }).join('');
  refreshMcSelects();
}

function mcFillModels(providerId, selected) {
  var sel = document.getElementById('mc-model');
  var prov = null;
  mcState.hanaModels.forEach(function (m) {
    if ((m.providerId || m.provider) === providerId) prov = m;
  });
  var list = (prov && Array.isArray(prov.models)) ? prov.models : [];
  sel.innerHTML = '<option value="">请选择</option>' + list.map(function (m) {
    var mid = m.modelId || m.model || m.id;
    return '<option value="' + esc(mid) + '">' + esc(m.label || m.name || mid) + '</option>';
  }).join('');
  if (selected) sel.value = selected;
  refreshMcSelects();
}

function refreshMcSelects() {
  refreshOneSelect('mc-provider');
  refreshOneSelect('mc-model');
}

function refreshOneSelect(id) {
  if (typeof beautifySelect !== 'function') return;
  var sel = document.getElementById(id);
  if (!sel) return;
  if (sel.dataset.ddReady) {
    var wrap = sel.closest('.dd');
    if (wrap && wrap._ddRefresh) wrap._ddRefresh();
  } else {
    beautifySelect(sel);
  }
}

function mcRenderConfig(cfg) {
  mcState.config = cfg;
  mcSetSource(cfg.source || 'agent');
  var cur = document.getElementById('mc-current');
  var label = '跟随助手';
  if (cfg.source === 'hana') {
    label = 'Hana · ' + (cfg.hanaModel && cfg.hanaModel.providerId ? cfg.hanaModel.providerId + ' / ' + cfg.hanaModel.modelId : '未选');
  } else if (cfg.source === 'custom') {
    label = '自定义 · ' + (cfg.customModel && cfg.customModel.model ? cfg.customModel.model : '未填模型');
  }
  cur.textContent = '当前使用：' + label;
  if (cfg.hanaModel && cfg.hanaModel.providerId) {
    mcPendingEcho = { providerId: cfg.hanaModel.providerId, modelId: cfg.hanaModel.modelId };
    document.getElementById('mc-provider').value = cfg.hanaModel.providerId;
    mcFillModels(cfg.hanaModel.providerId, cfg.hanaModel.modelId);
  }
  if (cfg.customModel) {
    document.getElementById('mc-custom-url').value = cfg.customModel.baseUrl || '';
    document.getElementById('mc-custom-key').value = '';
    document.getElementById('mc-custom-model').value = cfg.customModel.model || '';
    document.getElementById('mc-custom-api').value = cfg.customModel.api || 'openai-completions';
    refreshOneSelect('mc-custom-api');
    var hint = document.getElementById('mc-key-hint');
    if (cfg.customModel.apiKeyMask) {
      var mode = cfg.customModel.storageMode || 'none';
      var extra = mode === 'plain' ? '（当前明文，Windows 下会自动转系统加密）' : mode === 'dpapi' ? '（系统加密保护）' : '';
      hint.textContent = '已存 Key：' + cfg.customModel.apiKeyMask + extra + '，留空不修改';
    } else {
      hint.textContent = '还没配置 Key';
    }
    document.getElementById('mc-clear-key-btn').classList.toggle('hidden', !cfg.customModel.apiKeyMask);
  }
}

function loadModelConfig() {
  loadMcConfig();
  loadMcModels();
}

function loadMcConfig() {
  api('api/model-config').then(function (res) {
    if (res.ok) mcRenderConfig(res.config);
    else document.getElementById('mc-current').textContent = '当前使用：读取失败';
  }).catch(function () {
    document.getElementById('mc-current').textContent = '当前使用：读取失败';
  });
}

function loadMcModels() {
  api('api/model-config/hana-models').then(function (res) {
    if (res.ok && Array.isArray(res.models)) {
      mcState.hanaModels = res.models;
      mcFillProviders();
      if (mcPendingEcho) {
        document.getElementById('mc-provider').value = mcPendingEcho.providerId;
        mcFillModels(mcPendingEcho.providerId, mcPendingEcho.modelId);
        mcPendingEcho = null;
        refreshMcSelects();
      }
    } else {
      document.getElementById('mc-provider').innerHTML = '<option value="">拉取失败，试试跟随助手</option>';
      refreshMcSelects();
    }
  }).catch(function () {
    document.getElementById('mc-provider').innerHTML = '<option value="">拉取失败，试试跟随助手</option>';
    refreshMcSelects();
  });
}

function mcCollect() {
  var patch = { source: mcState.source };
  if (mcState.source === 'hana') {
    patch.hanaModel = {
      providerId: document.getElementById('mc-provider').value,
      modelId: document.getElementById('mc-model').value,
    };
  } else if (mcState.source === 'custom') {
    patch.customModel = {
      baseUrl: document.getElementById('mc-custom-url').value.trim(),
      apiKey: document.getElementById('mc-custom-key').value,
      model: document.getElementById('mc-custom-model').value.trim(),
      api: document.getElementById('mc-custom-api').value,
    };
  }
  return patch;
}

function mcSave() {
  var btn = document.getElementById('mc-save-btn');
  btn.disabled = true;
  api('api/model-config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(mcCollect()),
  }).then(function (res) {
    if (res.ok) { mcRenderConfig(res.config); toast('模型已保存'); }
    else toast(res.error || '保存失败');
  }).catch(function (e) {
    toast('保存失败：' + e.message);
  }).then(function () {
    btn.disabled = false;
  });
}

function mcTest() {
  var patch = mcCollect();
  if (mcState.source === 'hana') {
    if (!patch.hanaModel.providerId || !patch.hanaModel.modelId) {
      document.getElementById('mc-test-result').textContent = '⚠ 请选择供应商和模型。';
      return;
    }
  }
  var btn = document.getElementById('mc-test-btn');
  var old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '测试中…';
  var resultEl = document.getElementById('mc-test-result');
  resultEl.textContent = '';
  api('api/model-config/test', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: mcState.source, patch: patch }),
  }).then(function (res) {
    if (res.ok) resultEl.textContent = res.note || '连通了';
    else resultEl.textContent = '⚠ ' + (res.error || '连通失败');
  }).catch(function (e) {
    resultEl.textContent = '⚠ ' + e.message;
  }).then(function () {
    btn.disabled = false;
    btn.textContent = old;
  });
}

function mcClearKey() {
  var patch = mcCollect();
  if (!patch.customModel) patch.customModel = {};
  patch.customModel.clearApiKey = true;
  api('api/model-config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }).then(function (res) {
    if (res.ok) { mcRenderConfig(res.config); toast('Key 已清除'); }
    else toast(res.error || '清除失败');
  }).catch(function (e) { toast('清除失败：' + e.message); });
}

/* ── 档位切换联动 ── */
document.addEventListener('click', function (e) {
  var segBtn = e.target.closest ? e.target.closest('.seg-btn') : null;
  if (segBtn) {
    var seg = segBtn.closest('.seg');
    if (seg) {
      seg.querySelectorAll('.seg-btn').forEach(function (b) { b.classList.remove('active'); });
      segBtn.classList.add('active');
      if (seg.id === 'mode-seg') {
        var mode = segBtn.getAttribute('data-mode');
        document.getElementById('mode-tip').textContent = MODE_TIPS[mode] || '';
        document.getElementById('interval-row').classList.toggle('hidden', mode !== 'balanced');
        var irow = document.getElementById('interval-extra-row');
        if (irow) irow.classList.toggle('hidden', mode !== 'balanced');
      }
      if (seg.id === 'injection-enabled-seg') {
        syncInjectionUi(segBtn.getAttribute('data-val') === 'true');
      }
      if (seg.id === 'weather-seg') {
        syncWeatherSettingsUi(segBtn.getAttribute('data-val') === 'true');
      }

    }
    return;
  }
  // 类型快捷标签切换
  var typeTab = e.target.closest ? e.target.closest('.type-tab') : null;
  if (typeTab) {
    var tabs = typeTab.closest('#type-tabs');
    if (!tabs) return;
    tabs.querySelectorAll('.type-tab').forEach(function (b) { b.classList.remove('active'); });
    typeTab.classList.add('active');
    updateTypeGuide(typeTab.getAttribute('data-type'));
    return;
  }
});

document.addEventListener('input', function (e) {
  if (!e.target) return;
  if (e.target.id === 'new-title') {
    autofillTodoReminderFromTitle();
    return;
  }
  if (e.target.id === 'new-reminder-start' || e.target.id === 'new-reminder-end') {
    if (!todoReminderAutofilling) {
      todoReminderManual = true;
      todoReminderAutofilled = false;
    }
    syncTodoReminderUI('todo');
  }
});
document.addEventListener('change', function (e) {
  if (e.target && (e.target.id === 'new-reminder-start' || e.target.id === 'new-reminder-end')) {
    if (!todoReminderAutofilling) {
      todoReminderManual = true;
      todoReminderAutofilled = false;
    }
    syncTodoReminderUI('todo');
  }
});

document.getElementById('mc-provider').addEventListener('change', function () {
  mcFillModels(this.value, '');
});

function initWeatherRegionSelects() {
  var province = document.getElementById('weather-province');
  var city = document.getElementById('weather-city');
  var district = document.getElementById('weather-district');
  if (!province || province.dataset.weatherReady) return;
  province.dataset.weatherReady = '1';
  province.addEventListener('change', function () {
    weatherSelectionTouched = true;
    setWeatherLegacyNote('');
    document.getElementById('weather-test-msg').textContent = '';
    populateWeatherCities(this.value, '', '');
  });
  city.addEventListener('change', function () {
    weatherSelectionTouched = true;
    setWeatherLegacyNote('');
    document.getElementById('weather-test-msg').textContent = '';
    populateWeatherDistricts(province.value, this.value, '');
  });
  district.addEventListener('change', function () {
    weatherSelectionTouched = true;
    setWeatherLegacyNote('');
    document.getElementById('weather-test-msg').textContent = '';
  });
  setWeatherSelectDisabled('weather-city', true);
  setWeatherSelectDisabled('weather-district', true);
}

function initBeautifySelects() {
  if (typeof beautifySelect !== 'function') return;
  document.querySelectorAll('select').forEach(function (sel) {
    if (!sel.dataset.ddReady) beautifySelect(sel);
  });
}
initBeautifySelects();
initWeatherRegionSelects();

// 检查更新 / 反馈（积木 ui，走拾光记页面自己的 token 探测）
if (typeof bindUpdateChecker === 'function') {
  bindUpdateChecker({ apiBase: 'api/check-update', releaseUrl: 'https://github.com/moononnn/hanako-shiguangji/releases', onToast: toast });
}
if (typeof bindFeedback === 'function') {
  bindFeedback({ apiBase: 'api/feedback', openerId: 'fb-open-btn', onToast: toast });
}

// 启动：先同步全局设置（含生理期开关），再渲染今日卡与日历
function loadAppSettings() {
  api('api/settings').then(function (res) {
    if (res.ok) appSettings = Object.assign(appSettings, res.settings);
    syncInjectionUi(appSettings.injectionEnabled !== false);
    syncWeatherSettingsUi(appSettings.weatherEnabled !== false);
    loadToday();
    startTodayRefresher();
    loadMonth();
    loadSummaryJobs();
  }).catch(function () {
    loadToday();
    startTodayRefresher();
    loadMonth();
    loadSummaryJobs();
  });
}
loadAppSettings();
</script>
</body>
</html>`;
}
