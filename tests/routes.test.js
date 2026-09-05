import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parseTodoReminderText } from "../lib/todo-time.js";

// 用隔离的 USERPROFILE 启动真实路由，避免测试触碰用户的拾光记数据。
test("路由：日期详情接口能正常读取当天数据", () => {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "sgj-route-test-"));
  const routeUrl = pathToFileURL(path.resolve("routes/ui.js")).href;
  const childCode = `
    import registerRoutes from ${JSON.stringify(routeUrl)};

    const routes = [];
    const app = {
      get(path, handler) { routes.push({ method: "GET", path, handler }); },
      post(path, handler) { routes.push({ method: "POST", path, handler }); },
      put(path, handler) { routes.push({ method: "PUT", path, handler }); },
      delete(path, handler) { routes.push({ method: "DELETE", path, handler }); },
    };
    const ctx = { log: { info() {}, warn() {}, error() {} } };
    registerRoutes(app, ctx);
    const route = routes.find((item) => item.method === "GET" && item.path === "/api/events/:date");
    if (!route) throw new Error("日期详情路由未注册");
    const result = await route.handler({
      req: { param(name) { return name === "date" ? "2026-08-30" : ""; } },
      json(value) { return value; },
    });
    if (!result?.ok || !result.day) throw new Error("日期详情接口没有返回 day");
    const past = await routes.find((item) => item.method === "GET" && item.path === "/api/events/:date").handler({
      req: { param() { return "2000-01-01"; } },
      json(value) { return value; },
    });
    const future = await routes.find((item) => item.method === "GET" && item.path === "/api/events/:date").handler({
      req: { param() { return "2999-01-01"; } },
      json(value) { return value; },
    });
    if (past.day.canAddTodo !== false || past.day.isPastLifeDay !== true) throw new Error("过去日期没有关闭待办入口");
    if (future.day.canAddTodo !== true || future.day.isPastLifeDay !== false) throw new Error("未来日期错误关闭待办入口");
    const monthRoute = routes.find((item) => item.method === "GET" && item.path === "/api/month/:year/:month");
    if (!monthRoute) throw new Error("月视图路由未注册");
    const month = await monthRoute.handler({
      req: { param(name) { return name === "year" ? "2026" : "8"; } },
      json(value) { return value; },
    });
    if (!month?.ok || !month.days.length || month.days.some((day) => typeof day.canBatchSummary !== "boolean")) {
      throw new Error("月视图没有返回做册日期资格");
    }
    const currentWeatherRoute = routes.find((item) => item.method === "GET" && item.path === "/api/weather/current");
    if (!currentWeatherRoute) throw new Error("今日天气路由未注册");
    const currentWeather = await currentWeatherRoute.handler({ json(value) { return value; } });
    if (!currentWeather?.ok || currentWeather.weather !== null) throw new Error("未配置地点时今日天气应安全返回空值");
    const regionsRoute = routes.find((item) => item.method === "GET" && item.path === "/api/weather/regions");
    if (!regionsRoute) throw new Error("行政区路由未注册");
    const regions = await regionsRoute.handler({ json(value) { return value; } });
    if (!regions?.ok || regions.regions.length < 2800) throw new Error("行政区数据不完整");
    if (!regions.regions.some((item) => item.code === "510107" && item.district === "武侯区")) {
      throw new Error("武侯区行政区数据缺失");
    }
    console.log(JSON.stringify({ ok: result.ok, hasDay: !!result.day, pastTodo: past.day.canAddTodo, futureTodo: future.day.canAddTodo, canBatch: typeof month.days[0].canBatchSummary === "boolean", regionCount: regions.regions.length }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], {
    encoding: "utf8",
    env: { ...process.env, USERPROFILE: isolatedHome, HOME: isolatedHome, HANA_HOME: path.join(isolatedHome, ".hanako") },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"ok":true/);
  assert.match(result.stdout, /"hasDay":true/);
  assert.match(result.stdout, /"canBatch":true/);
  assert.match(result.stdout, /"regionCount":2\d{3}/);
});

test("路由：注入预览不提前播报未来待办，旧 MM-DD 也不误判", () => {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "sgj-route-todo-filter-test-"));
  const routeUrl = pathToFileURL(path.resolve("routes/ui.js")).href;
  const dataUrl = pathToFileURL(path.resolve("lib/data.js")).href;
  const sharedUrl = pathToFileURL(path.resolve("lib/shared-data.js")).href;
  const childCode = `
    import path from "node:path";
    import { UserData } from ${JSON.stringify(dataUrl)};
    import { __setSharedUserDataForTest } from ${JSON.stringify(sharedUrl)};
    import registerRoutes from ${JSON.stringify(routeUrl)};
    const data = new UserData(path.join(process.env.HANA_HOME, "plugin-data", "shiguangji"));
    __setSharedUserDataForTest(data);
    const now = new Date();
    const dateKey = (date) => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
    const today = dateKey(now);
    const futureDate = new Date(now);
    futureDate.setDate(futureDate.getDate() + 2);
    const futureKey = dateKey(futureDate);
    const futureMmdd = futureKey.slice(5);
    await data.addEvent({ title: "预览今天待办", type: "todo", date: today, reminderStart: "09:00", reminderEnd: "09:00" });
    await data.events.update((state) => {
      state.events.legacyFuture = { id: "legacyFuture", title: "预览未来旧格式待办", type: "todo", date: futureMmdd, repeatYearly: false };
      state.events.fullFuture = { id: "fullFuture", title: "预览未来完整格式待办", type: "todo", date: futureKey, repeatYearly: false };
    });
    const routes = [];
    const app = {
      get(path, handler) { routes.push({ method: "GET", path, handler }); },
      post(path, handler) { routes.push({ method: "POST", path, handler }); },
      put(path, handler) { routes.push({ method: "PUT", path, handler }); },
      delete(path, handler) { routes.push({ method: "DELETE", path, handler }); },
    };
    registerRoutes(app, { log: { info() {}, warn() {}, error() {} } });
    const preview = routes.find((item) => item.method === "GET" && item.path === "/api/injection-preview");
    if (!preview) throw new Error("注入预览路由未注册");
    const result = await preview.handler({ json(value) { return value; } });
    if (!result.ok || !result.text.includes("预览今天待办") || result.text.includes("预览未来旧格式待办") || result.text.includes("预览未来完整格式待办")) {
      throw new Error("注入预览错误包含未来待办：" + JSON.stringify(result));
    }
    console.log(JSON.stringify({ ok: result.ok, hasToday: result.text.includes("预览今天待办"), hasFuture: result.text.includes("预览未来旧格式待办") || result.text.includes("预览未来完整格式待办") }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], {
    encoding: "utf8",
    env: { ...process.env, USERPROFILE: isolatedHome, HOME: isolatedHome, HANA_HOME: path.join(isolatedHome, ".hanako") },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"ok":true/);
  assert.match(result.stdout, /"hasToday":true/);
  assert.match(result.stdout, /"hasFuture":false/);
});

test("路由：日期详情和注入预览都不回显过期天气缓存", () => {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "sgj-route-stale-weather-test-"));
  const routeUrl = pathToFileURL(path.resolve("routes/ui.js")).href;
  const dataUrl = pathToFileURL(path.resolve("lib/data.js")).href;
  const sharedUrl = pathToFileURL(path.resolve("lib/shared-data.js")).href;
  const childCode = `
    import path from "node:path";
    import { UserData } from ${JSON.stringify(dataUrl)};
    import { __setSharedUserDataForTest } from ${JSON.stringify(sharedUrl)};
    import registerRoutes from ${JSON.stringify(routeUrl)};
    const data = new UserData(path.join(process.env.HANA_HOME, "plugin-data", "shiguangji"));
    __setSharedUserDataForTest(data);
    const now = new Date();
    const dateKey = (date) => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
    const today = dateKey(now);
    const location = "河北省 邢台市 襄都区";
    await data.updateSettings({ weatherLocation: location, weatherArea: { code: "130502" }, weatherEnabled: true, weatherIntervalHours: 3 });
    await data.addEvent({ title: "过期天气路由锚点", type: "event", date: today });
    await data.setWeatherCache({
      location,
      fetchedAt: Date.now() - 4 * 3600 * 1000,
      result: { place: location, line: "晴空万里，阳光正好，30°C", temp: 30, code: 0, isDay: true },
    });
    const routes = [];
    const app = {
      get(path, handler) { routes.push({ method: "GET", path, handler }); },
      post(path, handler) { routes.push({ method: "POST", path, handler }); },
      put(path, handler) { routes.push({ method: "PUT", path, handler }); },
      delete(path, handler) { routes.push({ method: "DELETE", path, handler }); },
    };
    registerRoutes(app, { log: { info() {}, warn() {}, error() {} } });
    const events = routes.find((item) => item.method === "GET" && item.path === "/api/events/:date");
    const preview = routes.find((item) => item.method === "GET" && item.path === "/api/injection-preview");
    if (!events || !preview) throw new Error("天气消费路由未注册");
    const day = await events.handler({ req: { param() { return today; } }, json(value) { return value; } });
    const previewResult = await preview.handler({ json(value) { return value; } });
    if (day.day.weather !== null) throw new Error("日期详情仍回显过期天气：" + JSON.stringify(day.day.weather));
    if (previewResult.text.includes("窗外") || previewResult.text.includes("阳光正好")) {
      throw new Error("注入预览仍回显过期天气：" + previewResult.text);
    }
    console.log(JSON.stringify({ ok: true, dayWeather: day.day.weather, previewHasWeather: previewResult.text.includes("窗外") }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], {
    encoding: "utf8",
    env: { ...process.env, USERPROFILE: isolatedHome, HOME: isolatedHome, HANA_HOME: path.join(isolatedHome, ".hanako") },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"ok":true/);
  assert.match(result.stdout, /"dayWeather":null/);
  assert.match(result.stdout, /"previewHasWeather":false/);
});

test("路由：30 分钟注入间隔可保存并跨实例回读", () => {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "sgj-settings-route-test-"));
  const routeUrl = pathToFileURL(path.resolve("routes/ui.js")).href;
  const dataUrl = pathToFileURL(path.resolve("lib/data.js")).href;
  const childCode = `
    import path from "node:path";
    import { UserData } from ${JSON.stringify(dataUrl)};
    import registerRoutes from ${JSON.stringify(routeUrl)};
    const routes = [];
    const app = {
      get(path, handler) { routes.push({ method: "GET", path, handler }); },
      post(path, handler) { routes.push({ method: "POST", path, handler }); },
      put(path, handler) { routes.push({ method: "PUT", path, handler }); },
      delete(path, handler) { routes.push({ method: "DELETE", path, handler }); },
    };
    registerRoutes(app, { log: { info() {}, warn() {}, error() {} } });
    const get = routes.find((item) => item.method === "GET" && item.path === "/api/settings");
    const post = routes.find((item) => item.method === "POST" && item.path === "/api/settings");
    if (!get || !post) throw new Error("设置路由未注册");
    const callPost = (body) => post.handler({
      req: { async json() { return body; } },
      json(value) { return value; },
    });
    const saved = await callPost({ injectMode: "balanced", injectIntervalHours: 0.5 });
    if (!saved.ok || saved.settings.injectIntervalHours !== 0.5) {
      throw new Error("30分钟档没有保存：" + JSON.stringify(saved));
    }
    const routeRead = await get.handler({ json(value) { return value; } });
    const freshData = new UserData(path.join(process.env.HANA_HOME, "plugin-data", "shiguangji"));
    const reopened = freshData.getSettings();
    if (routeRead.settings.injectIntervalHours !== 0.5 || reopened.injectIntervalHours !== 0.5) {
      throw new Error("30分钟档重新打开后没有回读：" + JSON.stringify({ routeRead, reopened }));
    }
    const removedLegacy = await callPost({ injectIntervalHours: 2 });
    if (removedLegacy.ok || !String(removedLegacy.error || "").includes("间隔")) {
      throw new Error("已移除的2小时档不应被接受：" + JSON.stringify(removedLegacy));
    }
    console.log(JSON.stringify({ saved: saved.settings.injectIntervalHours, reopened: reopened.injectIntervalHours }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], {
    encoding: "utf8",
    env: { ...process.env, USERPROFILE: isolatedHome, HOME: isolatedHome, HANA_HOME: path.join(isolatedHome, ".hanako") },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"saved":0\.5/);
  assert.match(result.stdout, /"reopened":0\.5/);
});

test("路由：情境注入与天气开关独立保存，关闭天气不查询且不回显缓存", () => {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "sgj-context-weather-route-test-"));
  const routeUrl = pathToFileURL(path.resolve("routes/ui.js")).href;
  const dataUrl = pathToFileURL(path.resolve("lib/data.js")).href;
  const sharedUrl = pathToFileURL(path.resolve("lib/shared-data.js")).href;
  const childCode = `
    import path from "node:path";
    import { UserData } from ${JSON.stringify(dataUrl)};
    import { __setSharedUserDataForTest } from ${JSON.stringify(sharedUrl)};
    import registerRoutes from ${JSON.stringify(routeUrl)};
    const routes = [];
    const app = {
      get(path, handler) { routes.push({ method: "GET", path, handler }); },
      post(path, handler) { routes.push({ method: "POST", path, handler }); },
      put(path, handler) { routes.push({ method: "PUT", path, handler }); },
      delete(path, handler) { routes.push({ method: "DELETE", path, handler }); },
    };
    const data = new UserData(path.join(process.env.HANA_HOME, "plugin-data", "shiguangji"));
    __setSharedUserDataForTest(data);
    let fetches = 0;
    let weatherResponse = async () => { throw new Error("关闭天气时不应查询"); };
    const network = {
      async fetch(url, init) {
        fetches++;
        return weatherResponse(url, init);
      },
    };
    registerRoutes(app, { network, log: { info() {}, warn() {}, error() {} } });
    const getSettings = routes.find((item) => item.method === "GET" && item.path === "/api/settings");
    const postSettings = routes.find((item) => item.method === "POST" && item.path === "/api/settings");
    const currentWeather = routes.find((item) => item.method === "GET" && item.path === "/api/weather/current");
    const weatherTest = routes.find((item) => item.method === "GET" && item.path === "/api/weather/test");
    const events = routes.find((item) => item.method === "GET" && item.path === "/api/events/:date");
    const preview = routes.find((item) => item.method === "GET" && item.path === "/api/injection-preview");
    if (!getSettings || !postSettings || !currentWeather || !weatherTest || !events || !preview) throw new Error("开关相关路由缺失");
    const callSettings = (body) => postSettings.handler({
      req: { async json() { return body; } },
      json(value) { return value; },
    });
    const region = { code: "510107" };
    const saved = await callSettings({ injectionEnabled: false, weatherEnabled: false, weatherArea: region });
    if (!saved.ok || saved.settings.injectionEnabled !== false || saved.settings.weatherEnabled !== false) {
      throw new Error("两个开关没有独立保存：" + JSON.stringify(saved));
    }
    const loaded = await getSettings.handler({ json(value) { return value; } });
    if (loaded.settings.injectionEnabled !== false || loaded.settings.weatherEnabled !== false) {
      throw new Error("两个开关没有正确回读：" + JSON.stringify(loaded));
    }
    await data.setWeatherCache({
      location: "四川省 成都市 武侯区",
      fetchedAt: Date.now(),
      result: { place: "四川省 成都市 武侯区", line: "晴空万里，28°C", temp: 28, code: 0, isDay: true },
    });
    const disabledWeather = await currentWeather.handler({ json(value) { return value; } });
    if (!disabledWeather.ok || disabledWeather.weather !== null || fetches !== 0) {
      throw new Error("关闭天气后仍查询或回显天气：" + JSON.stringify({ disabledWeather, fetches }));
    }
    const disabledWeatherTest = await weatherTest.handler({
      req: { url: "http://localhost/api/weather/test?code=510107" },
      json(value) { return value; },
    });
    if (!disabledWeatherTest.ok || disabledWeatherTest.weather !== null || !disabledWeatherTest.disabled || fetches !== 0) {
      throw new Error("关闭天气后测试接口仍查询：" + JSON.stringify({ disabledWeatherTest, fetches }));
    }
    const disabledFetches = fetches;
    const today = new Date();
    const todayKey = [today.getFullYear(), String(today.getMonth() + 1).padStart(2, "0"), String(today.getDate()).padStart(2, "0")].join("-");
    const day = await events.handler({ req: { param() { return todayKey; } }, json(value) { return value; } });
    if (day.day.weather !== null) throw new Error("关闭天气后日期详情仍回显缓存");
    const disabledPreview = await preview.handler({ json(value) { return value; } });
    if (!disabledPreview.ok || !String(disabledPreview.text).includes("已关闭")) {
      throw new Error("关闭注入后的预览没有诚实提示：" + JSON.stringify(disabledPreview));
    }
    const restored = await callSettings({ injectionEnabled: true, weatherEnabled: true });
    if (!restored.ok || restored.settings.injectionEnabled !== true || restored.settings.weatherEnabled !== true) {
      throw new Error("重新打开开关失败：" + JSON.stringify(restored));
    }
    // 重新开启会主动绕过旧缓存，这里用确定的天气响应验证确实查了最新结果。
    weatherResponse = async () => ({
      ok: true,
      async json() {
        return { current: { temperature_2m: 28, weather_code: 0, is_day: 1, time: new Date().toISOString() } };
      },
    });
    const enabledWeather = await currentWeather.handler({ json(value) { return value; } });
    if (!enabledWeather.ok || !enabledWeather.weather || enabledWeather.weather.temp !== 28 || fetches !== 1) {
      throw new Error("天气重新打开后没有立即查最新结果：" + JSON.stringify({ enabledWeather, fetches }));
    }
    console.log(JSON.stringify({
      injectionEnabled: restored.settings.injectionEnabled,
      weatherEnabled: restored.settings.weatherEnabled,
      disabledFetches,
      restoredFetches: fetches,
      restoredTemp: enabledWeather.weather.temp,
    }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], {
    encoding: "utf8",
    env: { ...process.env, USERPROFILE: isolatedHome, HOME: isolatedHome, HANA_HOME: path.join(isolatedHome, ".hanako") },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"injectionEnabled":true/);
  assert.match(result.stdout, /"weatherEnabled":true/);
  assert.match(result.stdout, /"disabledFetches":0/);
  assert.match(result.stdout, /"restoredFetches":1/);
  assert.match(result.stdout, /"restoredTemp":28/);
});

test("路由：每日总结按伙伴保存、读取与单独删除", () => {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "sgj-summary-route-test-"));
  const routeUrl = pathToFileURL(path.resolve("routes/ui.js")).href;
  const childCode = `
    import registerRoutes from ${JSON.stringify(routeUrl)};
    const routes = [];
    const app = {
      get(path, handler) { routes.push({ method: "GET", path, handler }); },
      post(path, handler) { routes.push({ method: "POST", path, handler }); },
      put(path, handler) { routes.push({ method: "PUT", path, handler }); },
      delete(path, handler) { routes.push({ method: "DELETE", path, handler }); },
    };
    registerRoutes(app, { log: { info() {}, warn() {}, error() {} } });
    const put = routes.find((item) => item.method === "PUT" && item.path === "/api/summaries/:date");
    const list = routes.find((item) => item.method === "GET" && item.path === "/api/summaries");
    const del = routes.find((item) => item.method === "DELETE" && item.path === "/api/summaries/:date");
    const settingsPost = routes.find((item) => item.method === "POST" && item.path === "/api/settings");
    const settingsGet = routes.find((item) => item.method === "GET" && item.path === "/api/settings");
    const putOne = async (agentId, text) => put.handler({
      req: { param(name) { return name === "date" ? "2026-08-29" : ""; }, async json() { return { agentId, text }; } },
      json(value) { return value; },
    });
    if (!(await putOne("hanako", "小花的档案")).ok) throw new Error("保存小花档案失败");
    if (!(await putOne("partner-two", "另一位伙伴的档案")).ok) throw new Error("保存另一份档案失败");
    const all = await list.handler({ json(value) { return value; } });
    if (all.summaries.length !== 2) throw new Error("按伙伴档案数量不对");
    if (!all.summaries.some((item) => item.agentId === "hanako")) throw new Error("hanako 档案缺失");
    const setting = await settingsPost.handler({ req: { async json() { return { summaryShared: true }; } }, json(value) { return value; } });
    if (!setting.ok || setting.settings.summaryShared !== true) throw new Error("共享开关保存失败");
    const settingRead = await settingsGet.handler({ json(value) { return value; } });
    if (settingRead.settings.summaryShared !== true) throw new Error("共享开关回读失败");
    const removed = await del.handler({
      req: { param(name) { return name === "date" ? "2026-08-29" : ""; }, url: "http://localhost/api/summaries/2026-08-29?agentId=hanako" },
      json(value) { return value; },
    });
    if (!removed.ok) throw new Error("单独删除失败");
    const after = await list.handler({ json(value) { return value; } });
    if (after.summaries.length !== 1 || after.summaries[0].agentId !== "partner-two") throw new Error("单独删除误伤其他伙伴");
    console.log(JSON.stringify({ count: all.summaries.length, remaining: after.summaries[0].agentId, shared: settingRead.settings.summaryShared }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], {
    encoding: "utf8",
    env: { ...process.env, USERPROFILE: isolatedHome, HOME: isolatedHome, HANA_HOME: path.join(isolatedHome, ".hanako") },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"count":2/);
  assert.match(result.stdout, /"remaining":"partner-two"/);
  assert.match(result.stdout, /"shared":true/);
});

test("路由：整理一天时按伙伴调用模型并分别归档", () => {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "sgj-summary-run-route-test-"));
  const routeUrl = pathToFileURL(path.resolve("routes/ui.js")).href;
  const childCode = `
    import fs from "node:fs";
    import path from "node:path";
    import os from "node:os";
    import { collectDayMessages } from ${JSON.stringify(pathToFileURL(path.resolve("lib/day-summary.js")).href)};
    import registerRoutes from ${JSON.stringify(routeUrl)};
    const root = path.join(os.homedir(), ".hanako", "agents");
    fs.mkdirSync(path.join(os.homedir(), ".hanako"), { recursive: true });
    fs.writeFileSync(path.join(os.homedir(), ".hanako", "users.json"), JSON.stringify({ displayName: "小测试" }));
    for (const [id, name, text] of [["hanako", "小花", "一起整理日历"], ["partner-two", "另一位伙伴", "聊了天气"]]) {
      const dir = path.join(root, id, "sessions");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(root, id, "config.yaml"), "agent:\\n  name: " + name + "\\n");
      fs.writeFileSync(path.join(dir, "one.jsonl"), JSON.stringify({ type: "message", timestamp: "2026-08-29T10:00:00", message: { role: "user", content: text } }) + "\\n");
    }
    const collected = collectDayMessages({ agentsDir: root, targetDate: "2026-08-29", boundaryHour: 4 });
    if (collected.messages.length !== 2) throw new Error("预采集失败：" + JSON.stringify({ root, dirs: fs.readdirSync(root), messages: collected.messages }));
    const routes = [];
    const app = {
      get(path, handler) { routes.push({ method: "GET", path, handler }); },
      post(path, handler) { routes.push({ method: "POST", path, handler }); },
      put(path, handler) { routes.push({ method: "PUT", path, handler }); },
      delete(path, handler) { routes.push({ method: "DELETE", path, handler }); },
    };
    const calls = [];
    const ctx = {
      bus: { async request(topic, input) { calls.push({ topic, input }); return { text: "摘要：" + input.agentId }; } },
      log: { info() {}, warn() {}, error() {} },
    };
    registerRoutes(app, ctx);
    const run = routes.find((item) => item.method === "POST" && item.path === "/api/summaries/run");
    const list = routes.find((item) => item.method === "GET" && item.path === "/api/summaries");
    const result = await run.handler({ req: { async json() { return { date: "2026-08-29" }; } }, json(value) { return value; } });
    if (!result.ok || !Array.isArray(result.summaries) || result.summaries.length !== 2) throw new Error("分类总结结果数量不对：" + JSON.stringify(result));
    if (calls.length !== 2 || calls.some((call) => call.topic !== "utility:call-text" || !call.input.agentId)) throw new Error("没有按伙伴分别调用模型");
    if (calls.some((call) => call.input.callPurpose !== "summary" || call.input.reasoningLevel !== "off")) throw new Error("总结调用没有显式使用短任务策略");
    if (calls.some((call) => !String(call.input.messages?.[0]?.content || "").includes("小测试"))) throw new Error("总结提示没有使用动态称呼");
    if (calls.some((call) => String(call.input.messages?.[0]?.content || "").includes("与用户"))) throw new Error("总结提示仍写死了用户称呼");
    const saved = await list.handler({ json(value) { return value; } });
    if (saved.summaries.length !== 2) throw new Error("分类档案没有分别保存");
    if (!saved.summaries.some((item) => item.agentId === "hanako" && item.agentName === "小花")) throw new Error("小花档案缺失");
    if (!saved.summaries.some((item) => item.agentId === "partner-two" && item.agentName === "另一位伙伴")) throw new Error("另一份档案缺失");
    console.log(JSON.stringify({ calls: calls.length, agents: saved.summaries.map((item) => item.agentId).sort() }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], {
    encoding: "utf8",
    env: { ...process.env, USERPROFILE: isolatedHome, HOME: isolatedHome, HANA_HOME: path.join(isolatedHome, ".hanako") },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"calls":2/);
  assert.match(result.stdout, /partner-two/);
});

test("路由：后台总结任务异步完成、持久化并清洗用户称呼", () => {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "sgj-summary-job-route-test-"));
  const routeUrl = pathToFileURL(path.resolve("routes/ui.js")).href;
  const dataUrl = pathToFileURL(path.resolve("lib/data.js")).href;
  const childCode = `
    import fs from "node:fs";
    import path from "node:path";
    import os from "node:os";
    import { UserData } from ${JSON.stringify(dataUrl)};
    import registerRoutes from ${JSON.stringify(routeUrl)};
    const root = path.join(os.homedir(), ".hanako", "agents");
    fs.mkdirSync(path.join(os.homedir(), ".hanako"), { recursive: true });
    fs.writeFileSync(path.join(os.homedir(), ".hanako", "users.json"), JSON.stringify({ displayName: "小测试" }));
    const dir = path.join(root, "hanako", "sessions");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(root, "hanako", "config.yaml"), "agent:\\n  name: 小花\\n");
    fs.writeFileSync(path.join(dir, "one.jsonl"), JSON.stringify({ type: "message", timestamp: "2026-08-29T10:00:00", message: { role: "user", content: "一起整理昨天" } }) + "\\n");
    fs.writeFileSync(path.join(dir, "two.jsonl"), JSON.stringify({ type: "message", timestamp: "2026-08-28T10:00:00", message: { role: "user", content: "前天也整理了一次" } }) + "\\n");
    const routes = [];
    const app = {
      get(path, handler) { routes.push({ method: "GET", path, handler }); },
      post(path, handler) { routes.push({ method: "POST", path, handler }); },
      put(path, handler) { routes.push({ method: "PUT", path, handler }); },
      delete(path, handler) { routes.push({ method: "DELETE", path, handler }); },
    };
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    registerRoutes(app, {
      bus: { async request() { await sleep(70); return { text: "用户和小测试一起整理了日历" }; } },
      log: { info() {}, warn() {}, error() {} },
    });
    const post = routes.find((item) => item.method === "POST" && item.path === "/api/summaries/jobs");
    const get = routes.find((item) => item.method === "GET" && item.path === "/api/summaries/jobs/:id");
    if (!post || !get) throw new Error("后台总结路由未注册");
    const invalid = await post.handler({ req: { async json() { return { dates: ["2026-02-31"] }; } }, json(value) { return value; } });
    if (invalid.ok || !invalid.error.includes("日期无效")) throw new Error("无效日期没有被拦截");
    const future = await post.handler({ req: { async json() { return { dates: ["2999-01-01"] }; } }, json(value) { return value; } });
    if (future.ok || !future.error.includes("还没有结束")) throw new Error("未来日期没有被拦截");
    const many = Array.from({ length: 32 }, (_, i) => "2020-01-" + String(i + 1).padStart(2, "0"));
    const tooMany = await post.handler({ req: { async json() { return { dates: many }; } }, json(value) { return value; } });
    if (tooMany.ok || !tooMany.error.includes("最多做")) throw new Error("批量日期上限没有被拦截");
    const queued = await post.handler({ req: { async json() { return { dates: ["2026-08-28", "2026-08-29"] }; } }, json(value) { return value; } });
    if (!queued.ok || !queued.job || queued.job.progress.done !== 0) throw new Error("后台任务没有先返回排队状态：" + JSON.stringify(queued));
    const duplicate = await post.handler({ req: { async json() { return { dates: ["2026-08-27"] }; } }, json(value) { return value; } });
    if (duplicate.ok || !duplicate.job) throw new Error("运行中的后台任务没有阻止重复提交");
    await sleep(420);
    const finished = await get.handler({ req: { param(name) { return name === "id" ? queued.job.id : ""; } }, json(value) { return value; } });
    if (!finished.ok || finished.job.status !== "completed" || finished.job.progress.done !== 2) throw new Error("后台任务没有完成：" + JSON.stringify(finished));
    const data = new UserData(path.join(os.homedir(), ".hanako", "plugin-data", "shiguangji"));
    const saved = data.getAgentSummary("2026-08-29", "hanako");
    const savedOld = data.getAgentSummary("2026-08-28", "hanako");
    if (!saved || !savedOld || saved.text.includes("用户") || savedOld.text.includes("用户") || !saved.text.includes("小测试")) throw new Error("总结没有清洗动态称呼或没有逐日归档：" + JSON.stringify({ saved, savedOld }));
    console.log(JSON.stringify({ status: finished.job.status, done: finished.job.progress.done, saved: saved.text, savedOld: savedOld.text }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], {
    encoding: "utf8",
    env: { ...process.env, USERPROFILE: isolatedHome, HOME: isolatedHome, HANA_HOME: path.join(isolatedHome, ".hanako") },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"status":"completed"/);
  assert.match(result.stdout, /小测试/);
});

test("路由：同一天的总结请求串行化，避免档案并发覆盖", () => {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "sgj-summary-lock-route-test-"));
  const routeUrl = pathToFileURL(path.resolve("routes/ui.js")).href;
  const childCode = `
    import fs from "node:fs";
    import path from "node:path";
    import os from "node:os";
    import registerRoutes from ${JSON.stringify(routeUrl)};
    const home = path.join(os.homedir(), ".hanako");
    const root = path.join(home, "agents", "hanako", "sessions");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(home, "agents", "hanako", "config.yaml"), "agent:\\n  name: 小花\\n");
    fs.writeFileSync(path.join(root, "one.jsonl"), JSON.stringify({ type: "message", timestamp: "2026-08-29T10:00:00", message: { role: "user", content: "同一天的总结" } }) + "\\n");
    const routes = [];
    const app = {
      get(path, handler) { routes.push({ method: "GET", path, handler }); },
      post(path, handler) { routes.push({ method: "POST", path, handler }); },
      put(path, handler) { routes.push({ method: "PUT", path, handler }); },
      delete(path, handler) { routes.push({ method: "DELETE", path, handler }); },
    };
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    let inFlight = 0;
    let maxInFlight = 0;
    registerRoutes(app, {
      bus: { async request() { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await sleep(70); inFlight--; return { text: "同一天总结" }; } },
      log: { info() {}, warn() {}, error() {} },
    });
    const run = routes.find((item) => item.method === "POST" && item.path === "/api/summaries/run");
    const request = { req: { async json() { return { date: "2026-08-29" }; } }, json(value) { return value; } };
    const [first, second] = await Promise.all([run.handler(request), run.handler(request)]);
    if (!first.ok || !second.ok || maxInFlight !== 1) throw new Error("同一天总结出现并发模型调用：" + JSON.stringify({ first, second, maxInFlight }));
    console.log(JSON.stringify({ maxInFlight }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], {
    encoding: "utf8",
    env: { ...process.env, USERPROFILE: isolatedHome, HOME: isolatedHome, HANA_HOME: path.join(isolatedHome, ".hanako") },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"maxInFlight":1/);
});

test("路由：Hana 重启后恢复未结束的总结任务", () => {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "sgj-summary-job-resume-test-"));
  const routeUrl = pathToFileURL(path.resolve("routes/ui.js")).href;
  const dataUrl = pathToFileURL(path.resolve("lib/data.js")).href;
  const childCode = `
    import fs from "node:fs";
    import path from "node:path";
    import os from "node:os";
    import { UserData } from ${JSON.stringify(dataUrl)};
    import registerRoutes from ${JSON.stringify(routeUrl)};
    const home = path.join(os.homedir(), ".hanako");
    const dataDir = path.join(home, "plugin-data", "shiguangji");
    const root = path.join(home, "agents", "hanako", "sessions");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(home, "users.json"), JSON.stringify({ displayName: "小测试" }));
    fs.writeFileSync(path.join(home, "agents", "hanako", "config.yaml"), "agent:\\n  name: 小花\\n");
    fs.writeFileSync(path.join(root, "one.jsonl"), JSON.stringify({ type: "message", timestamp: "2026-08-29T10:00:00", message: { role: "user", content: "恢复这项总结" } }) + "\\n");
    const seed = new UserData(dataDir);
    // 模拟任务创建后用户改了总结范围：恢复应沿用任务快照，而不是临时设置。
    await seed.updateSettings({ summaryAgentIds: [] });
    await seed.createSummaryJob({ id: "restore-job", dates: ["2026-08-29"], outcomes: [], status: "running", currentDate: "2026-08-29", summaryAgentIds: ["hanako"] });
    const routes = [];
    const app = {
      get(path, handler) { routes.push({ method: "GET", path, handler }); },
      post(path, handler) { routes.push({ method: "POST", path, handler }); },
      put(path, handler) { routes.push({ method: "PUT", path, handler }); },
      delete(path, handler) { routes.push({ method: "DELETE", path, handler }); },
    };
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    registerRoutes(app, {
      bus: { async request() { return { text: "用户的恢复总结" }; } },
      log: { info() {}, warn() {}, error() {} },
    });
    await sleep(220);
    const get = routes.find((item) => item.method === "GET" && item.path === "/api/summaries/jobs/:id");
    const result = await get.handler({ req: { param(name) { return name === "id" ? "restore-job" : ""; } }, json(value) { return value; } });
    if (!result.ok || result.job.status !== "completed") throw new Error("重启恢复任务没有完成：" + JSON.stringify(result));
    const saved = new UserData(dataDir).getAgentSummary("2026-08-29", "hanako");
    if (!saved || saved.text.includes("用户") || !saved.text.includes("小测试")) throw new Error("恢复任务没有生成清洗后的档案");
    console.log(JSON.stringify({ status: result.job.status, text: saved.text }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], {
    encoding: "utf8",
    env: { ...process.env, USERPROFILE: isolatedHome, HOME: isolatedHome, HANA_HOME: path.join(isolatedHome, ".hanako") },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"status":"completed"/);
  assert.match(result.stdout, /小测试/);
});

test("路由：全局伙伴选择只整理选中的伙伴", () => {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "sgj-summary-selection-route-test-"));
  const routeUrl = pathToFileURL(path.resolve("routes/ui.js")).href;
  const childCode = `
    import fs from "node:fs";
    import path from "node:path";
    import os from "node:os";
    import registerRoutes from ${JSON.stringify(routeUrl)};
    const root = path.join(os.homedir(), ".hanako", "agents");
    for (const [id, name, text] of [["hanako", "小花", "主伙伴的对话"], ["partner-two", "另一位伙伴", "另一位伙伴的对话"]]) {
      const dir = path.join(root, id, "sessions");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(root, id, "config.yaml"), "agent:\\n  name: " + name + "\\n");
      fs.writeFileSync(path.join(dir, "one.jsonl"), JSON.stringify({ type: "message", timestamp: "2026-08-29T10:00:00", message: { role: "user", content: text } }) + "\\n");
    }
    const routes = [];
    const app = {
      get(path, handler) { routes.push({ method: "GET", path, handler }); },
      post(path, handler) { routes.push({ method: "POST", path, handler }); },
      put(path, handler) { routes.push({ method: "PUT", path, handler }); },
      delete(path, handler) { routes.push({ method: "DELETE", path, handler }); },
    };
    const calls = [];
    registerRoutes(app, {
      bus: { async request(topic, input) { calls.push({ topic, input }); return { text: "只给小花的摘要" }; } },
      log: { info() {}, warn() {}, error() {} },
    });
    const settingPost = routes.find((item) => item.method === "POST" && item.path === "/api/settings");
    const setting = await settingPost.handler({ req: { async json() { return { summaryAgentIds: ["hanako"] }; } }, json(value) { return value; } });
    if (!setting.ok || JSON.stringify(setting.settings.summaryAgentIds) !== JSON.stringify(["hanako"])) throw new Error("全局伙伴选择没有保存");
    const run = routes.find((item) => item.method === "POST" && item.path === "/api/summaries/run");
    const result = await run.handler({ req: { async json() { return { date: "2026-08-29" }; } }, json(value) { return value; } });
    if (!result.ok || result.summaries.length !== 1 || result.summaries[0].agentId !== "hanako") throw new Error("总结没有按全局选择过滤：" + JSON.stringify(result));
    if (calls.length !== 1 || calls[0].input.agentId !== "hanako") throw new Error("模型调用包含未选中的伙伴");
    console.log(JSON.stringify({ calls: calls.length, agents: result.summaries.map((item) => item.agentId) }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], {
    encoding: "utf8",
    env: { ...process.env, USERPROFILE: isolatedHome, HOME: isolatedHome, HANA_HOME: path.join(isolatedHome, ".hanako") },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"calls":1/);
  assert.match(result.stdout, /hanako/);
});

test("路由：花酿来访按角色合并、兼容旧选择并清掉旧碎片", () => {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "sgj-hanabrew-summary-route-test-"));
  const routeUrl = pathToFileURL(path.resolve("routes/ui.js")).href;
  const dataUrl = pathToFileURL(path.resolve("lib/data.js")).href;
  const childCode = `
    import fs from "node:fs";
    import path from "node:path";
    import os from "node:os";
    import { UserData } from ${JSON.stringify(dataUrl)};
    import registerRoutes from ${JSON.stringify(routeUrl)};
    const hanaHome = path.join(os.homedir(), ".hanako");
    const root = path.join(hanaHome, "agents");
    fs.mkdirSync(path.join(hanaHome, "plugins", "hanabrew"), { recursive: true });
    fs.writeFileSync(path.join(hanaHome, "plugins", "hanabrew", "manifest.json"), "{}");
    const identity = "# 角色身份\\n\\n你是沈叙，这次从花酿酒馆临时来到 Hana。\\n";
    const opening = "这是一段较长的角色开场情境，用来验证同一位角色从多个临时来访身份合并后，重复开场只保留一份，不再把同一个伙伴拆成许多陌生编号。";
    for (const [id, role, text] of [["hanabrew-visitor-a", "assistant", opening], ["hanabrew-visitor-b", "user", "今晚把方案重新核对了一遍"]]) {
      const dir = path.join(root, id);
      fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
      fs.writeFileSync(path.join(dir, "AGENTS.md"), identity);
      if (id === "hanabrew-visitor-b") fs.writeFileSync(path.join(dir, "config.yaml"), "agent:\\n  name: 沈叙\\n");
      fs.writeFileSync(path.join(dir, "sessions", "one.jsonl"), JSON.stringify({
        type: "message", timestamp: "2026-08-29T10:00:00", message: { role, content: text },
      }) + "\\n");
    }
    const data = new UserData(path.join(hanaHome, "plugin-data", "shiguangji"));
    await data.saveAgentSummary("2026-08-29", "hanabrew-visitor-a", "旧的沈叙碎片 A", { agentName: "hanabrew-visitor-a" });
    await data.saveAgentSummary("2026-08-29", "hanabrew-visitor-b", "旧的沈叙碎片 B", { agentName: "hanabrew-visitor-b" });
    const routes = [];
    const app = {
      get(path, handler) { routes.push({ method: "GET", path, handler }); },
      post(path, handler) { routes.push({ method: "POST", path, handler }); },
      put(path, handler) { routes.push({ method: "PUT", path, handler }); },
      delete(path, handler) { routes.push({ method: "DELETE", path, handler }); },
    };
    const calls = [];
    registerRoutes(app, {
      bus: { async request(topic, input) { calls.push({ topic, input }); return { text: "按逻辑伙伴整理的摘要" }; } },
      log: { info() {}, warn() {}, error() {} },
    });
    const settingsPost = routes.find((item) => item.method === "POST" && item.path === "/api/settings");
    const setting = await settingsPost.handler({ req: { async json() { return { summaryAgentIds: ["hanabrew-visitor-a"] }; } }, json(value) { return value; } });
    if (!setting.ok || setting.settings.summaryAgentIds.length !== 1 || !setting.settings.summaryAgentIds[0].startsWith("hanabrew-character-")) throw new Error("旧 visitor 选择没有迁移到逻辑角色");
    const run = routes.find((item) => item.method === "POST" && item.path === "/api/summaries/run");
    const result = await run.handler({ req: { async json() { return { date: "2026-08-29" }; } }, json(value) { return value; } });
    if (!result.ok || result.summaries.length !== 1 || result.summaries[0].agentName !== "沈叙") throw new Error("花酿来访没有合并成沈叙：" + JSON.stringify(result));
    if (result.summaries[0].messageCount !== 2) throw new Error("重复开场没有去重：" + JSON.stringify(result.summaries[0]));
    if (calls.length !== 1 || calls[0].input.agentId !== "hanabrew-visitor-b") throw new Error("总结模型没有使用真实 visitor Agent：" + JSON.stringify(calls));
    const revise = routes.find((item) => item.method === "POST" && item.path === "/api/summaries/:date/revise");
    const revised = await revise.handler({
      req: { param(name) { return name === "date" ? "2026-08-29" : ""; }, async json() { return { agentId: setting.settings.summaryAgentIds[0], message: "补充当天做过的事" }; } },
      json(value) { return value; },
    });
    if (!revised.ok || !calls[1].input.messages[0].content.includes("今晚把方案")) throw new Error("逻辑伙伴档案修改没有带入原始对话依据");
    const list = routes.find((item) => item.method === "GET" && item.path === "/api/summaries");
    const saved = await list.handler({ json(value) { return value; } });
    if (saved.summaries.some((item) => /^hanabrew-visitor-/i.test(item.agentId))) throw new Error("旧 visitor 碎片仍然残留：" + JSON.stringify(saved));
    if (saved.summaries.filter((item) => item.agentName === "沈叙").length !== 1) throw new Error("沈叙档案没有只保留一份");
    console.log(JSON.stringify({ calls: calls.length, agentName: result.summaries[0].agentName, saved: saved.summaries.length }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], {
    encoding: "utf8",
    env: { ...process.env, USERPROFILE: isolatedHome, HOME: isolatedHome, HANA_HOME: path.join(isolatedHome, ".hanako") },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"calls":2/);
  assert.match(result.stdout, /沈叙/);
});

test("路由：对话式修订多轮协商后才生成建议，确认后才修改", () => {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "sgj-revision-chat-route-test-"));
  const routeUrl = pathToFileURL(path.resolve("routes/ui.js")).href;
  const childCode = `
    import fs from "node:fs";
    import path from "node:path";
    import os from "node:os";
    import registerRoutes from ${JSON.stringify(routeUrl)};
    const hanaHome = path.join(os.homedir(), ".hanako");
    fs.mkdirSync(hanaHome, { recursive: true });
    fs.writeFileSync(path.join(hanaHome, "users.json"), JSON.stringify({ displayName: "小测试" }));
    const RealDate = Date;
    let fakeNow = RealDate.now();
    class FakeDate extends RealDate {
      constructor(...args) { super(...(args.length ? args : [fakeNow])); }
      static now() { return fakeNow; }
    }
    globalThis.Date = FakeDate;
    const routes = [];
    const app = {
      get(path, handler) { routes.push({ method: "GET", path, handler }); },
      post(path, handler) { routes.push({ method: "POST", path, handler }); },
      put(path, handler) { routes.push({ method: "PUT", path, handler }); },
      delete(path, handler) { routes.push({ method: "DELETE", path, handler }); },
    };
    let modelCall = 0;
    registerRoutes(app, {
      bus: { async request(topic, input) {
        modelCall += 1;
        if (modelCall === 1) return { text: "我明白了。你是想保留上午，只把下午那段说准一点，对吗？" };
        return { text: '那就按我们说好的来。<suggestion>{"text":"小测试上午整理了日历，下午带圆宝出去玩。"}</suggestion>' };
      } },
      log: { info() {}, warn() {}, error() {} },
    });
    const put = routes.find((item) => item.method === "PUT" && item.path === "/api/summaries/:date");
    const revise = routes.find((item) => item.method === "POST" && item.path === "/api/summaries/:date/revise");
    const confirm = routes.find((item) => item.method === "POST" && item.path === "/api/summaries/:date/revise/confirm");
    const close = routes.find((item) => item.method === "POST" && item.path === "/api/summaries/:date/revise/close");
    const list = routes.find((item) => item.method === "GET" && item.path === "/api/summaries");
    if (!revise || !confirm || !close) throw new Error("对话式修订路由没有完整注册");
    const ctx = (body) => ({
      req: { param() { return "2026-08-29"; }, async json() { return body; } },
      json(value) { return value; },
    });
    const saved = await put.handler(ctx({ agentId: "hanako", text: "小测试上午整理了日历。" }));
    if (!saved.ok) throw new Error("测试原文保存失败");
    const first = await revise.handler(ctx({ agentId: "hanako", message: "下午其实还带圆宝出去了" }));
    if (!first.ok || !first.session_id || first.suggestion) throw new Error("第一轮不该急着生成建议：" + JSON.stringify(first));
    const before = await list.handler({ json(value) { return value; } });
    if (before.summaries[0].text !== "小测试上午整理了日历。") throw new Error("聊天阶段擅自修改了原文");
    const second = await revise.handler(ctx({ agentId: "hanako", session_id: first.session_id, message: "对，就这样，生成修改建议吧" }));
    if (!second.ok || second.session_id !== first.session_id || !second.suggestion?.includes("圆宝")) throw new Error("第二轮没有生成建议：" + JSON.stringify(second));
    const stillBefore = await list.handler({ json(value) { return value; } });
    if (stillBefore.summaries[0].text.includes("圆宝")) throw new Error("生成建议时已经写入，越过了用户确认");
    const applied = await confirm.handler(ctx({ agentId: "hanako", session_id: first.session_id }));
    if (!applied.ok || !applied.summary.text.includes("圆宝")) throw new Error("确认后没有应用建议：" + JSON.stringify(applied));
    const replay = await confirm.handler(ctx({ agentId: "hanako", session_id: first.session_id }));
    if (replay.ok) throw new Error("已消费的会话还能重复确认");

    const guarded = await revise.handler(ctx({ agentId: "hanako", message: "就按现在这版再给一份建议" }));
    if (!guarded.ok || !guarded.suggestion) throw new Error("版本守卫测试没有生成建议");
    const guardedOriginal = guarded.original;
    fakeNow += 1;
    await put.handler(ctx({ agentId: "hanako", text: "临时改动" }));
    fakeNow += 1;
    await put.handler(ctx({ agentId: "hanako", text: guardedOriginal }));
    const staleConfirm = await confirm.handler(ctx({ agentId: "hanako", session_id: guarded.session_id }));
    if (staleConfirm.ok || !staleConfirm.error.includes("已经变过")) throw new Error("原文改动后改回仍绕过版本守卫：" + JSON.stringify(staleConfirm));

    const expiring = await revise.handler(ctx({ agentId: "hanako", message: "先聊一版，过会儿再继续" }));
    fakeNow += 31 * 60 * 1000;
    const expired = await revise.handler(ctx({ agentId: "hanako", session_id: expiring.session_id, message: "继续刚才的话" }));
    if (expired.ok || !expired.error.includes("已过期")) throw new Error("过期会话被静默续用：" + JSON.stringify(expired));

    const closing = await revise.handler(ctx({ agentId: "hanako", message: "开一段用来测试关闭的对话" }));
    const wrongClose = await close.handler(ctx({ agentId: "partner-two", session_id: closing.session_id }));
    if (wrongClose.ok) throw new Error("其他伙伴错误关闭了当前会话");
    const rightClose = await close.handler(ctx({ agentId: "hanako", session_id: closing.session_id }));
    if (!rightClose.ok) throw new Error("正确会话没有关闭成功");
    console.log(JSON.stringify({ modelCall, firstSuggestion: !!first.suggestion, secondSuggestion: !!second.suggestion, applied: applied.ok, staleRejected: !staleConfirm.ok, expiredRejected: !expired.ok, closeGuarded: !wrongClose.ok && rightClose.ok }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], {
    encoding: "utf8",
    env: { ...process.env, USERPROFILE: isolatedHome, HOME: isolatedHome, HANA_HOME: path.join(isolatedHome, ".hanako") },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"modelCall":5/);
  assert.match(result.stdout, /"firstSuggestion":false/);
  assert.match(result.stdout, /"secondSuggestion":true/);
  assert.match(result.stdout, /"applied":true/);
  assert.match(result.stdout, /"staleRejected":true/);
  assert.match(result.stdout, /"expiredRejected":true/);
  assert.match(result.stdout, /"closeGuarded":true/);
});

test("路由：花酿目录已清理时仍能用旧碎片重整", () => {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "sgj-hanabrew-history-route-test-"));
  const routeUrl = pathToFileURL(path.resolve("routes/ui.js")).href;
  const dataUrl = pathToFileURL(path.resolve("lib/data.js")).href;
  const childCode = `
    import fs from "node:fs";
    import path from "node:path";
    import os from "node:os";
    import { UserData } from ${JSON.stringify(dataUrl)};
    import registerRoutes from ${JSON.stringify(routeUrl)};
    process.env.APPDATA = path.join(os.homedir(), "appdata");
    const hanaHome = path.join(os.homedir(), ".hanako");
    const root = path.join(hanaHome, "agents");
    fs.mkdirSync(path.join(hanaHome, "plugins", "hanabrew"), { recursive: true });
    fs.writeFileSync(path.join(hanaHome, "plugins", "hanabrew", "manifest.json"), "{}");
    fs.mkdirSync(path.join(process.env.APPDATA, "hanabrew"), { recursive: true });
    fs.writeFileSync(path.join(process.env.APPDATA, "hanabrew", "state.json"), JSON.stringify({
      pendingVisitorCleanup: ["hanabrew-visitor-a", "hanabrew-visitor-b"],
      lastVisitorDeparture: { characterName: "沈叙" },
    }));
    const data = new UserData(path.join(hanaHome, "plugin-data", "shiguangji"));
    await data.saveAgentSummary("2026-08-29", "hanabrew-visitor-a", "晚上沈叙送来热可可", { agentName: "hanabrew-visitor-a" });
    await data.saveAgentSummary("2026-08-29", "hanabrew-visitor-b", "沈叙提醒做完最后一页就回家", { agentName: "hanabrew-visitor-b" });
    const routes = [];
    const app = {
      get(path, handler) { routes.push({ method: "GET", path, handler }); },
      post(path, handler) { routes.push({ method: "POST", path, handler }); },
      put(path, handler) { routes.push({ method: "PUT", path, handler }); },
      delete(path, handler) { routes.push({ method: "DELETE", path, handler }); },
    };
    const calls = [];
    registerRoutes(app, {
      bus: { async request(topic, input) { calls.push({ topic, input }); return { text: "从旧碎片整理出的摘要" }; } },
      log: { info() {}, warn() {}, error() {} },
    });
    const run = routes.find((item) => item.method === "POST" && item.path === "/api/summaries/run");
    const result = await run.handler({ req: { async json() { return { date: "2026-08-29" }; } }, json(value) { return value; } });
    if (!result.ok || result.summaries.length !== 1 || result.summaries[0].agentName !== "沈叙") throw new Error("目录清理后没有合并旧碎片：" + JSON.stringify(result));
    const list = routes.find((item) => item.method === "GET" && item.path === "/api/summaries");
    const saved = await list.handler({ json(value) { return value; } });
    if (saved.summaries.some((item) => /^hanabrew-visitor-/i.test(item.agentId))) throw new Error("旧 visitor 档案没有清理");
    if (saved.summaries.filter((item) => item.agentName === "沈叙").length !== 1) throw new Error("旧碎片没有合并成一份沈叙档案");
    console.log(JSON.stringify({ calls: calls.length, agentName: result.summaries[0].agentName, saved: saved.summaries.length }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], {
    encoding: "utf8",
    env: { ...process.env, USERPROFILE: isolatedHome, HOME: isolatedHome, HANA_HOME: path.join(isolatedHome, ".hanako") },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"calls":1/);
  assert.match(result.stdout, /沈叙/);
});

test("路由：旧版未分类档案不会阻塞自动重整", () => {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "sgj-legacy-summary-route-test-"));
  const routeUrl = pathToFileURL(path.resolve("routes/ui.js")).href;
  const dataUrl = pathToFileURL(path.resolve("lib/data.js")).href;
  const daySummaryUrl = pathToFileURL(path.resolve("lib/day-summary.js")).href;
  const childCode = `
    import fs from "node:fs";
    import path from "node:path";
    import os from "node:os";
    import { UserData } from ${JSON.stringify(dataUrl)};
    import { finishedLifeDayKey, lifeDayRange } from ${JSON.stringify(daySummaryUrl)};
    import registerRoutes from ${JSON.stringify(routeUrl)};
    const boundary = 4;
    const target = finishedLifeDayKey(new Date(), boundary);
    const dataDir = path.join(os.homedir(), ".hanako", "plugin-data", "shiguangji");
    const agentRoot = path.join(os.homedir(), ".hanako", "agents", "hanako");
    const range = lifeDayRange(target, boundary);
    fs.mkdirSync(path.join(agentRoot, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(agentRoot, "config.yaml"), "agent:\\n  name: 小花\\n");
    fs.writeFileSync(path.join(agentRoot, "sessions", "one.jsonl"), JSON.stringify({
      type: "message", timestamp: new Date(range.start.getTime() + 3600000).toISOString(),
      message: { role: "user", content: "昨天一起整理了页面" },
    }) + "\\n");
    const data = new UserData(dataDir);
    await data.updateSettings({ autoSummary: true, dayBoundaryHour: boundary });
    await data.saveSummary(target, "旧版混合档案", { source: "manual", boundaryHour: boundary });
    const routes = [];
    const app = {
      get(path, handler) { routes.push({ method: "GET", path, handler }); },
      post(path, handler) { routes.push({ method: "POST", path, handler }); },
      put(path, handler) { routes.push({ method: "PUT", path, handler }); },
      delete(path, handler) { routes.push({ method: "DELETE", path, handler }); },
    };
    const calls = [];
    registerRoutes(app, {
      bus: { async request(topic, input) { calls.push({ topic, input }); return { text: "新分类摘要：" + input.agentId }; } },
      log: { info() {}, warn() {}, error() {} },
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const entries = new UserData(dataDir).listSummaryEntries(target);
    if (!calls.some((call) => call.input?.agentId === "hanako")) throw new Error("旧档案阻塞了自动重整");
    if (!entries.some((entry) => entry.agentId === "hanako" && entry.text.includes("新分类摘要"))) throw new Error("没有生成分类档案：" + JSON.stringify(entries));
    if (!entries.some((entry) => entry.unclassified)) throw new Error("旧版未分类档案没有保留");
    console.log(JSON.stringify({ calls: calls.length, agents: entries.map((entry) => entry.agentId) }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], {
    encoding: "utf8",
    env: { ...process.env, USERPROFILE: isolatedHome, HOME: isolatedHome, HANA_HOME: path.join(isolatedHome, ".hanako") },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"calls":1/);
  assert.match(result.stdout, /hanako/);
});

test("路由：区县设置保存标准地点与坐标，旧地点也能自动匹配", () => {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "sgj-settings-route-test-"));
  const routeUrl = pathToFileURL(path.resolve("routes/ui.js")).href;
  const childCode = `
    import registerRoutes from ${JSON.stringify(routeUrl)};
    const routes = [];
    const app = {
      get(path, handler) { routes.push({ method: "GET", path, handler }); },
      post(path, handler) { routes.push({ method: "POST", path, handler }); },
      put(path, handler) { routes.push({ method: "PUT", path, handler }); },
      delete(path, handler) { routes.push({ method: "DELETE", path, handler }); },
    };
    registerRoutes(app, { log: { info() {}, warn() {}, error() {} } });
    const post = routes.find((item) => item.method === "POST" && item.path === "/api/settings");
    const get = routes.find((item) => item.method === "GET" && item.path === "/api/settings");
    const saved = await post.handler({ req: { async json() { return { weatherArea: { code: "510107" } }; } }, json(value) { return value; } });
    if (!saved?.ok || saved.settings.weatherLocation !== "四川省 成都市 武侯区") throw new Error("区县设置保存失败");
    if (saved.settings.weatherArea?.latitude !== 30.64432) throw new Error("区县坐标没有保存");
    const loaded = await get.handler({ json(value) { return value; } });
    if (loaded.settings.weatherArea?.code !== "510107") throw new Error("区县设置回读失败");
    const legacy = await post.handler({ req: { async json() { return { weatherLocation: "成都 武侯区" }; } }, json(value) { return value; } });
    if (legacy.settings.weatherArea?.code !== "510107") throw new Error("旧地点没有自动匹配区县");
    console.log(JSON.stringify({ location: loaded.settings.weatherLocation, code: loaded.settings.weatherArea.code, legacyCode: legacy.settings.weatherArea.code }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], {
    encoding: "utf8",
    env: { ...process.env, USERPROFILE: isolatedHome, HOME: isolatedHome, HANA_HOME: path.join(isolatedHome, ".hanako") },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /四川省 成都市 武侯区/);
  assert.match(result.stdout, /"code":"510107"/);
});

test("页面 API：已有查询参数时用 & 追加鉴权 token", async () => {
  const { renderPage } = await import("../lib/page-template.js");
  const html = renderPage("test-token");
  const script = html.split("<script>").slice(1)
    .map((part) => part.split("</script>")[0])
    .find((part) => part.includes("function api(path"));
  assert.ok(script, "页面主脚本应包含 api helper");
  assert.match(script, /var tokenSep = path\.indexOf\('\?'\) >= 0 \? '&' : '\?'\;/);
  assert.match(script, /tokenSep \+ 'token='/);
});

test("检查更新：未点击前不显示手动仓库地址框", async () => {
  const { renderPage } = await import("../lib/page-template.js");
  const html = renderPage("test-token");
  assert.match(html, /id="uc-check-btn">检查更新<\/button>/);
  assert.match(html, /id="uc-result"/);
  assert.doesNotMatch(html, /uc-manual|uc-copy|自动检查暂不可用/);
});

test("日历：页面具备选中日期的即时状态", async () => {
  const { renderPage } = await import("../lib/page-template.js");
  const html = renderPage("test-token");
  const script = html.split("<script>").slice(1)
    .map((part) => part.split("</script>")[0])
    .find((part) => part.includes("function renderCalendar"));
  assert.match(html, /\.cal-day\.selected\s*\{/);
  assert.ok(script, "页面主脚本应包含日历渲染逻辑");
  assert.match(script, /data-date=/);
  assert.match(script, /function syncSelectedCellState/);
  assert.match(script, /classList\.toggle\('selected'/);
  assert.match(html, /<div class="detail hidden" id="detail">/);
  assert.match(html, /id="detail-body" class="empty">选一天/);
  const startup = script.slice(script.indexOf("function loadAppSettings"));
  assert.doesNotMatch(startup, /selectDay\(/);
});

test("页面：事件类型 class 走白名单，脏类型回退 event", async () => {
  const { renderPage } = await import("../lib/page-template.js");
  const html = renderPage("test-token");
  const script = html.split("<script>").slice(1)
    .map((part) => part.split("</script>")[0])
    .find((part) => part.includes("function safeType"));
  assert.ok(script, "页面脚本应包含 safeType 白名单函数");
  // 白名单覆盖四种类型；事件行渲染必须走 safeType，不允许再直接拼 e.type。
  assert.match(script, /EVENT_TYPE_WHITELIST\s*=\s*\{ event: true, anniversary: true, todo: true, period: true \}/);
  assert.match(script, /class=\"type t-' \+ safeType\(t\)/);
  assert.match(script, /class=\"bar b-' \+ safeType\(t\)/);
  assert.doesNotMatch(script, /class=\"type t-' \+ t\b/);
});

test("时光册：入口与日历多选控件统一使用做册文案", async () => {
  const { renderPage } = await import("../lib/page-template.js");
  const html = renderPage("test-token");
  const script = html.split("<script>").slice(1)
    .map((part) => part.split("</script>")[0])
    .find((part) => part.includes("function loadSummaries"));
  const archivePanel = html.slice(html.indexOf('<div id="panel-summary"'), html.indexOf('<div class="toast"'));
  assert.match(html, />时光册</);
  assert.match(html, /id="context-toggle-btn"/);
  assert.match(html, /id="injection-enabled-seg"/);
  assert.match(html, /id="injection-disabled-tip"/);
  assert.match(html, /data-mode="economical">适时</);
  assert.match(html, /data-mode="balanced">相伴</);
  assert.match(html, /data-mode="always">常在</);
  assert.match(html, /id="summary-shared-seg"/);
  assert.match(html, /id="summary-agent-picker"/);
  assert.ok(script, "页面主脚本应包含时光册逻辑");
  assert.match(script, /function summaryDomKey/);
  assert.match(script, /agentId: agentId \|\| ''/);
  assert.match(script, /这本册子做好啦/);
  assert.match(script, /function renderSummaryAgents/);
  assert.match(script, /summaryAgentIds/);
  assert.match(html, /id="summary-batch-panel"/);
  assert.match(html, /id="summary-batch-dates"/);
  assert.match(html, /id="summary-batch-run-btn"/);
  assert.match(html, /id="summary-jobs-calendar"/);
  assert.match(html, /@media \(max-width: 560px\)/);
  assert.match(html, /id="today-weather-icon"/);
  assert.match(html, /weather-partly/);
  assert.match(html, /weather-storm/);
  assert.match(script, /function weatherIconKind/);
  assert.match(script, /Number\.isFinite\(code\)/);
  assert.match(script, /function renderTodayWeatherIcon/);
  assert.match(script, /icon\.setAttribute\('class', 'today-weather-icon weather-' \+ kind/);
  assert.match(script, /api\('api\/weather\/current'\)/);
  assert.match(html, /id="weather-seg"/);
  assert.match(script, /weatherEnabled/);
  assert.match(script, /function syncWeatherSettingsUi/);
  assert.match(script, /var MODE_TIPS =/);
  assert.match(script, /function syncInjectionUi/);
  assert.match(script, /appSettings = Object\.assign\(appSettings, s\)/);
  assert.match(script, /body: JSON\.stringify\(\{ injectionEnabled: next \}\)/);
  assert.match(script, /todayRequestSeq/);
  assert.match(script, /startTodayRefresher/);
  assert.doesNotMatch(html, /id="summary-date"/);
  assert.doesNotMatch(html, /id="summary-batch-start"/);
  assert.doesNotMatch(archivePanel, /summary-batch|summary-date|runSummaryBatch/);
  assert.match(script, /function toggleSummaryBatchMode/);
  assert.match(script, /function toggleSummaryBatchDate/);
  assert.match(script, /随记/);
  assert.match(script, /纪念/);
  assert.match(script, /canAddTodo/);
  assert.match(script, /var defaultType = canAddTodo \? 'todo' : 'event';/);
  assert.match(script, /NEW_TITLE_PLACEHOLDER\[defaultType\]/);
  assert.match(script, /TYPE_TIPS\[defaultType\]/);
  assert.match(script, /defaultType === 'todo'/);
  assert.match(script, /syncTodoReminderUI\(defaultType\)/);
  assert.match(script, /这天已翻篇，只能补记/);
  assert.match(script, /待办（已有）/);
  assert.match(script, /new-date-note/);
  assert.match(script, /classList\.add\('hidden'\)/);
  assert.match(script, /canBatchSummary/);
  assert.match(script, /这一天还没结束，暂时不能做成册/);
  assert.match(script, /batch-selected/);
  assert.match(script, /if \(summarySelectMode\) \{/);
  assert.match(script, /loadSummaries\(true\);\s*loadMonth\(\)/);
  assert.match(script, /function runSummaryBatch/);
  assert.match(script, /api\('api\/summaries\/jobs'/);
  assert.match(script, /summaryJobsTimer/);
  // 重新生成失败部分：按钮与失败明细渲染、调用 retry-failed
  assert.match(script, /function summaryJobFailedItems/);
  assert.match(script, /重新生成失败部分/);
  assert.match(script, /retrySummaryJobFailed/);
  assert.match(script, /retry-failed/);
  assert.match(script, /summary-job-failed-item/);
  assert.match(script, /runSummaryFromDay\([^)]*, this\)/);
  assert.match(script, /id="detail-summary-msg"/);
  assert.match(script, /'<\/div><\/div><span class="sum-msg" id="detail-summary-msg"><\/span><\/div>'/);
  assert.match(script, /markSummaryTriggerPending/);
  assert.match(script, /正在放到后台/);
  assert.match(script, /正在把失败的部分放回后台/);
  assert.match(script, /trigger\.disabled = true/);
  // 确认收下：完成的册子显示「知道了」，确认后从列表过滤
  assert.match(script, /function dismissSummaryJob/);
  assert.match(script, /\/dismiss/);
  assert.match(script, /知道了/);
  assert.match(script, /item\.dismissedAt/);
});

test("时光册：和小花聊聊使用多轮对话弹窗、建议预览与确认应用", async () => {
  const { renderPage } = await import("../lib/page-template.js");
  const html = renderPage("test-token");
  const script = html.split("<script>").slice(1)
    .map((part) => part.split("</script>")[0])
    .find((part) => part.includes("function openSummaryChat"));
  assert.ok(script, "页面主脚本应包含对话式修订逻辑");
  assert.match(html, /id="summary-chat-modal"/);
  assert.match(html, /id="summary-chat-messages"/);
  assert.match(html, /id="summary-chat-suggestion"/);
  assert.match(html, /没点确认前不会修改/);
  assert.match(html, /和小花聊聊/);
  assert.match(html, /\.summary-chat-head \{ flex: 0 0 auto;/);
  assert.match(html, /\.summary-chat-context \{\s*flex: 0 0 auto; position: relative; z-index: 2;/);
  assert.match(html, /\.summary-chat-messages \{\s*flex: 1 1 auto; min-height: 0; overflow-y: auto;/);
  assert.match(html, /\.summary-chat-original \{[^}]*max-height: 82px; overflow-y: auto;/);
  assert.doesNotMatch(html, /请小花改/);
  assert.doesNotMatch(html, /revise-input-/);
  assert.match(script, /function sendSummaryChat/);
  assert.match(script, /session_id: summaryChatSessionId/);
  assert.match(script, /\/revise\/confirm/);
  assert.match(script, /function renderSummaryChatSuggestion/);
  assert.match(script, /if \(event\.key === 'Enter' && !event\.shiftKey\)/);
  assert.match(script, /summary-chat-before'\)\.textContent = ''/);
  assert.match(script, /summaryChatReturnFocus = document\.activeElement/);
  assert.match(script, /event\.key !== 'Tab'/);
  assert.match(script, /returnFocus\.isConnected/);
  assert.match(script, /closeSummaryChat\(false\)/);
});

test("天气设置：页面使用省市区县级联选择和区县代码测试", async () => {
  const { renderPage } = await import("../lib/page-template.js");
  const html = renderPage("test-token");
  const script = html.split("<script>").slice(1)
    .map((part) => part.split("</script>")[0])
    .find((part) => part.includes("function loadSettings"));
  assert.match(html, /id="weather-province"/);
  assert.match(html, /id="weather-city"/);
  assert.match(html, /id="weather-district"/);
  assert.doesNotMatch(html, /id="weather-location"/);
  assert.ok(script, "页面主脚本应包含设置逻辑");
  assert.match(script, /api\('api\/weather\/regions'\)/);
  assert.match(script, /weatherArea/);
  assert.match(script, /api\('api\/weather\/test\?code=/);
});

test("路由：retry-failed 只捞失败页创建新任务并绑定原任务", () => {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "sgj-retry-route-test-"));
  const routeUrl = pathToFileURL(path.resolve("routes/ui.js")).href;
  const dataUrl = pathToFileURL(path.resolve("lib/data.js")).href;
  const childCode = `
    import fs from "node:fs";
    import path from "node:path";
    import os from "node:os";
    import { pathToFileURL } from "node:url";
    import { UserData } from ${JSON.stringify(dataUrl)};
    import { __setSharedUserDataForTest } from ${JSON.stringify(pathToFileURL(path.resolve("lib/shared-data.js")).href)};
    import registerRoutes from ${JSON.stringify(routeUrl)};
    const home = path.join(os.homedir(), ".hanako");
    const root = path.join(home, "agents");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(home, "users.json"), JSON.stringify({ displayName: "小测试" }));
    const routes = [];
    const app = {
      get(path, handler) { routes.push({ method: "GET", path, handler }); },
      post(path, handler) { routes.push({ method: "POST", path, handler }); },
      put(path, handler) { routes.push({ method: "PUT", path, handler }); },
      delete(path, handler) { routes.push({ method: "DELETE", path, handler }); },
    };
    const data = new UserData(path.join(home, "plugin-data", "shiguangji"));
    __setSharedUserDataForTest(data);
    registerRoutes(app, { log: { info() {}, warn() {}, error() {} } });
    // 预置一个已结束的失败任务：3 页里 2 页失败、1 页成功。
    await data.createSummaryJob({
      id: "parent-1",
      dates: ["2026-08-27", "2026-08-28", "2026-08-29"],
      outcomes: [
        { date: "2026-08-27", status: "failed", error: "模型超时" },
        { date: "2026-08-28", status: "done", summaryCount: 1 },
        { date: "2026-08-29", status: "failed", error: "没有可见正文" },
      ],
      status: "completed_with_errors",
      currentDate: "",
      error: "2 页没有做好，可以重新发起",
      summaryAgentIds: ["hanako"],
      createdAt: new Date().toISOString(),
    });
    const retry = routes.find((item) => item.method === "POST" && item.path === "/api/summaries/jobs/:id/retry-failed");
    if (!retry) throw new Error("retry-failed 路由未注册");
    const result = await retry.handler({
      req: { param(name) { return name === "id" ? "parent-1" : ""; } },
      json(value) { return value; },
    });
    if (!result.ok || !result.job) throw new Error("retry 没有创建新任务：" + JSON.stringify(result));
    if (result.job.retryOf !== "parent-1") throw new Error("新任务没有绑定原任务");
    const failedDates = [...result.job.dates].sort();
    if (failedDates.length !== 2 || failedDates[0] !== "2026-08-27" || failedDates[1] !== "2026-08-29") {
      throw new Error("新任务应只包含失败页：" + JSON.stringify(failedDates));
    }
    if (result.job.progress.total !== 2) throw new Error("新任务应只有 2 页");
    if (result.job.progress.done !== 0) throw new Error("新任务还没跑，done 应为 0");
    // 原任务 progress 统计：失败页不能算进已做好页数。
    const getParent = routes.find((item) => item.method === "GET" && item.path === "/api/summaries/jobs/:id");
    if (!getParent) throw new Error("任务查询路由未注册");
    const parentView = await getParent.handler({
      req: { param(name) { return name === "id" ? "parent-1" : ""; } },
      json(value) { return value; },
    });
    if (parentView.job.progress.done !== 1) throw new Error("失败页被算进已做好页数：" + JSON.stringify(parentView.job.progress));
    if (parentView.job.progress.total !== 3) throw new Error("总数不对：" + JSON.stringify(parentView.job.progress));
    if (parentView.job.failed !== 2) throw new Error("失败数不对：" + JSON.stringify(parentView.job));
    console.log(JSON.stringify({ dates: failedDates, retryOf: result.job.retryOf, total: result.job.progress.total, parentProgress: parentView.job.progress, parentFailed: parentView.job.failed }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], {
    encoding: "utf8",
    env: { ...process.env, USERPROFILE: isolatedHome, HOME: isolatedHome, HANA_HOME: path.join(isolatedHome, ".hanako") },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"dates":\["2026-08-27","2026-08-29"\]/);
});

test("合并：重试任务把成功页合并回原任务，成功页原样保留", () => {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "sgj-merge-test-"));
  const routeUrl = pathToFileURL(path.resolve("routes/ui.js")).href;
  const dataUrl = pathToFileURL(path.resolve("lib/data.js")).href;
  const childCode = `
    import path from "node:path";
    import os from "node:os";
    import { UserData } from ${JSON.stringify(dataUrl)};
    import { mergeRetryOutcomes } from ${JSON.stringify(routeUrl)};
    const home = path.join(os.homedir(), ".hanako");
    const data = new UserData(path.join(home, "plugin-data", "shiguangji"));
    await data.createSummaryJob({
      id: "parent-2",
      dates: ["2026-08-27", "2026-08-28", "2026-08-29"],
      outcomes: [
        { date: "2026-08-27", status: "failed", error: "模型超时" },
        { date: "2026-08-28", status: "done", summaryCount: 1 },
        { date: "2026-08-29", status: "failed", error: "没有可见正文" },
      ],
      status: "completed_with_errors",
      currentDate: "",
      error: "2 页没有做好，可以重新发起",
      createdAt: new Date().toISOString(),
    });
    // 重试任务：两页都做成功了。
    await data.createSummaryJob({
      id: "retry-2",
      dates: ["2026-08-27", "2026-08-29"],
      outcomes: [
        { date: "2026-08-27", status: "done", summaryCount: 1 },
        { date: "2026-08-29", status: "done", summaryCount: 1 },
      ],
      status: "completed",
      currentDate: "",
      retryOf: "parent-2",
      createdAt: new Date().toISOString(),
    });
    await mergeRetryOutcomes(data, "retry-2");
    const parent = data.getSummaryJob("parent-2");
    if (parent.status !== "completed") throw new Error("合并后原任务应全部完成：" + parent.status);
    // 重试任务合并完应收尾为 merged，不再出现在进度卡列表。
    const retryJob = data.getSummaryJob("retry-2");
    if (retryJob.status !== "merged") throw new Error("重试任务合并后应标记 merged：" + retryJob.status);
    const visibleIds = data.listSummaryJobs(50).map((j) => j.id);
    if (visibleIds.indexOf("retry-2") >= 0) throw new Error("merged 的重试任务不应出现在列表：" + JSON.stringify(visibleIds));
    if (visibleIds.indexOf("parent-2") < 0) throw new Error("主任务应保留在列表：" + JSON.stringify(visibleIds));
    const byDate = {};
    for (const item of parent.outcomes) byDate[item.date] = item.status;
    if (byDate["2026-08-27"] !== "done" || byDate["2026-08-29"] !== "done") throw new Error("失败页没有更新为成功：" + JSON.stringify(byDate));
    if (byDate["2026-08-28"] !== "done" || parent.outcomes.length !== 3) throw new Error("成功页被误改或总数变了：" + JSON.stringify(parent.outcomes));
    if (parent.error) throw new Error("全部成功后错误文案应清空：" + parent.error);
    if (parent.retryCount !== 1) throw new Error("重试次数没记录：" + parent.retryCount);
    console.log(JSON.stringify({ status: parent.status, byDate, count: parent.outcomes.length }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], {
    encoding: "utf8",
    env: { ...process.env, USERPROFILE: isolatedHome, HOME: isolatedHome, HANA_HOME: path.join(isolatedHome, ".hanako") },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"status":"completed"/);
  assert.match(result.stdout, /"2026-08-28":"done"/);
});

test("路由：确认完成只允许全部做好的任务，确认后不再展示", () => {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "sgj-dismiss-test-"));
  const routeUrl = pathToFileURL(path.resolve("routes/ui.js")).href;
  const dataUrl = pathToFileURL(path.resolve("lib/data.js")).href;
  const sdUrl = pathToFileURL(path.resolve("lib/shared-data.js")).href;
  const childCode = `
    import path from "node:path";
    import os from "node:os";
    import fs from "node:fs";
    import { UserData } from ${JSON.stringify(dataUrl)};
    import { __setSharedUserDataForTest } from ${JSON.stringify(sdUrl)};
    import registerRoutes from ${JSON.stringify(routeUrl)};
    const home = path.join(os.homedir(), ".hanako");
    fs.mkdirSync(path.join(home, "agents"), { recursive: true });
    fs.writeFileSync(path.join(home, "users.json"), JSON.stringify({ displayName: "小测试" }));
    const data = new UserData(path.join(home, "plugin-data", "shiguangji"));
    __setSharedUserDataForTest(data);
    const routes = [];
    const app = {
      get(p, h) { routes.push({ method: "GET", path: p, handler: h }); },
      post(p, h) { routes.push({ method: "POST", path: p, handler: h }); },
      put(p, h) { routes.push({ method: "PUT", path: p, handler: h }); },
      delete(p, h) { routes.push({ method: "DELETE", path: p, handler: h }); },
    };
    registerRoutes(app, { log: { info() {}, warn() {}, error() {} } });
    await data.createSummaryJob({
      id: "ok-job",
      dates: ["2026-08-28"],
      outcomes: [{ date: "2026-08-28", status: "done", summaryCount: 1 }],
      status: "completed",
      currentDate: "",
      createdAt: new Date().toISOString(),
    });
    await data.createSummaryJob({
      id: "err-job",
      dates: ["2026-08-27"],
      outcomes: [{ date: "2026-08-27", status: "failed", error: "fetch failed" }],
      status: "completed_with_errors",
      currentDate: "",
      error: "1 页没有做好，可以重新发起",
      createdAt: new Date().toISOString(),
    });
    const dismiss = routes.find((r) => r.method === "POST" && r.path === "/api/summaries/jobs/:id/dismiss");
    if (!dismiss) throw new Error("dismiss 路由未注册");
    // 有失败页的任务不能被确认收下。
    const reject = await dismiss.handler({ req: { param(n) { return n === "id" ? "err-job" : ""; } }, json(v) { return v; } });
    if (reject.ok || !reject.error.includes("重新生成")) throw new Error("失败任务不应被确认：" + JSON.stringify(reject));
    // 全部做好的任务可以确认，并记下确认时间。
    const accept = await dismiss.handler({ req: { param(n) { return n === "id" ? "ok-job" : ""; } }, json(v) { return v; } });
    if (!accept.ok || !accept.job.dismissedAt) throw new Error("完成任务确认失败：" + JSON.stringify(accept));
    // 确认后列表里仍然存在（账本保留），由前端过滤不展示。
    const stored = data.getSummaryJob("ok-job");
    if (!stored.dismissedAt) throw new Error("确认时间没有持久化");
    console.log(JSON.stringify({ rejected: reject.error, dismissedAt: !!stored.dismissedAt, status: stored.status }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], {
    encoding: "utf8",
    env: { ...process.env, USERPROFILE: isolatedHome, HOME: isolatedHome, HANA_HOME: path.join(isolatedHome, ".hanako") },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"rejected":"[^"]*重新生成/);
  assert.match(result.stdout, /"dismissedAt":true/);
});

test("列表：原任务已终态并确认收下时，旧版重试残留不再展示", () => {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "sgj-stale-retry-test-"));
  const dataUrl = pathToFileURL(path.resolve("lib/data.js")).href;
  const childCode = `
    import path from "node:path";
    import os from "node:os";
    import { UserData } from ${JSON.stringify(dataUrl)};
    const data = new UserData(path.join(os.homedir(), "plugin-data", "shiguangji"));
    // 主任务：全部做好且已确认收下。
    await data.createSummaryJob({
      id: "main-1",
      dates: ["2026-08-20"],
      outcomes: [{ date: "2026-08-20", status: "done", summaryCount: 1 }],
      status: "completed",
      currentDate: "",
      dismissedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });
    // 旧版重试残留：completed_with_errors，parent 已确认收下。
    await data.createSummaryJob({
      id: "stale-1",
      dates: ["2026-08-20"],
      outcomes: [{ date: "2026-08-20", status: "failed", error: "fetch failed" }],
      status: "completed_with_errors",
      currentDate: "",
      error: "1 页没有做好，可以重新发起",
      retryOf: "main-1",
      createdAt: new Date().toISOString(),
    });
    const visible = data.listSummaryJobs(50).map((j) => j.id);
    if (visible.indexOf("stale-1") >= 0) throw new Error("旧版重试残留不应展示：" + JSON.stringify(visible));
    console.log(JSON.stringify({ visible }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], {
    encoding: "utf8",
    env: { ...process.env, USERPROFILE: isolatedHome, HOME: isolatedHome, HANA_HOME: path.join(isolatedHome, ".hanako") },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stdout, /stale-1/);
});

test("布局：记一笔移除、设置入顶栏、日历空状态引导", async () => {
  const { renderPage } = await import("../lib/page-template.js");
  const html = renderPage("test-token");
  const script = html.split("<script>").slice(1)
    .map((part) => part.split("</script>")[0])
    .find((part) => part.includes("function loadMonth"));
  // 1. 记一笔按钮移除：今日卡不再有 quickAddToday 入口
  assert.doesNotMatch(html, /quickAddToday/);
  assert.doesNotMatch(html, /onclick="quickAddToday/);
  // 2. 今日卡整体可点击（点了展开今天详情）
  assert.match(html, /id="today-card" role="button"/);
  assert.match(html, /today-card[^>]*onclick="goToday\(\)"/);
  // 3. 设置挪到顶栏，与回到今天并排，主导航只剩日历/时光册
  assert.match(html, /class="header-actions"/);
  assert.match(html, /settings-btn/);
  assert.match(html, /回到今天/);
  const navBlock = html.split('<div class="nav-tabs">')[1].split("</div>")[0];
  assert.match(navBlock, />日历</);
  assert.match(navBlock, />时光册</);
  assert.doesNotMatch(navBlock, /设置/);
  // 4. 日历空状态引导元素与逻辑
  assert.match(html, /id="calendar-guide"/);
  assert.match(html, /点任意日期，记下那天的事/);
  assert.match(html, /id="new-type-tip"/);
  assert.ok(script, "页面主脚本应包含 loadMonth");
  assert.match(script, /function renderEmptyGuide/);
  assert.match(script, /renderEmptyGuide\(res\.hasAnyRecord === false\)/);
  // 时光册按月→按天→按助手三级分组
  assert.match(script, /var day = ''/);
  assert.match(script, /s\.date !== day/);
  assert.match(script, /day-title/);
  assert.match(script, /s\.date\.slice\(5\)/);
  assert.match(html, /\.day-title/);
  assert.match(html, /\.day-date/);
  // 类型切换联动：占位提示与一句话讲解随类型变化，按钮文案直白化
  assert.match(script, /function updateTypeGuide/);
  assert.match(script, /NEW_TITLE_PLACEHOLDER/);
  assert.match(script, /TYPE_TIPS/);
  assert.match(script, /updateTypeGuide\(typeTab\.getAttribute/);
  assert.match(script, /标题里有明确时间会自动填入；当天白天写“两点”会按下午两点；有“提醒”时优先它旁边的时间/);
  assert.match(script, /要做的事，标题里的时间会自动填入/);
  assert.match(script, /每年都到，比如生日、纪念日/);
  // 待办必须选择提醒时间；起止相同显示为准点提醒。
  assert.match(html, /id="todo-reminder"/);
  assert.match(html, /id="new-reminder-start"/);
  assert.match(html, /id="new-reminder-end"/);
  assert.match(html, /id="todo-time-error"/);
  assert.match(html, /标题里写明确时间（如“下午三点”或“9点”）会自动填入/);
  assert.match(script, /function parseTodoReminderText/);
  assert.match(script, /function autofillTodoReminderFromTitle/);
  assert.match(script, /function syncTodoReminderUI/);
  assert.match(script, /function todoTimeMinutes/);
  assert.match(script, /请选择提醒时间/);
  assert.match(script, /这条旧待办还没设过提醒时间/);
  assert.match(script, /reminderMatchesTitle/);
  assert.match(script, /preview\.textContent = ''/);
  assert.match(script, /startValue === endValue/);
  assert.match(script, /Number\.isFinite\(startMinutes\)/);
  assert.match(script, /parseTodoReminderText\(titleInput\.value,/);
  assert.match(script, /e\.target\.id === 'new-title'/);
  assert.match(script, /已从标题识别/);
  assert.match(script, /body\.reminderStart = reminderStart/);
  assert.match(script, /body\.reminderEnd = reminderEnd/);
  assert.match(html, /\.todo-time-input \{ width: 78px; \}/);
  assert.match(html, /\.todo-time-preview \{ flex-basis: 100%;/);
  assert.match(html, /@media \(max-width: 380px\)/);
  assert.match(html, /\.todo-reminder \{ flex-direction: column; align-items: flex-start;/);
});

test("待办：页面端与服务端标题时间识别语义一致", () => {
  const clientSource = fs.readFileSync(path.resolve("lib/todo-time-client.js"), "utf8");
  const parseClient = new Function(`${clientSource}\nreturn parseTodoReminderText;`)();
  const samples = [
    "下午三点带圆宝出去玩",
    "下午三点半带圆宝出去玩",
    "下午三点到五点买纸",
    "15:00-17:00买纸",
    "凌晨一点出门",
    "中午两点吃饭",
    "两点 15分要去买椰子水",
    "下午3:30-5:30开会",
    "上午十点到下午两点开会",
    "晚上十二点回家",
    "十五点",
    "中午要和慧慧逛街，9点提醒我准备化妆",
    "九点提醒我准备化妆",
    "中午12点要和慧慧逛街，9点提醒我准备化妆",
    "上午九点到十点提醒我准备化妆",
    "下午3:30-5:30提醒我开会",
    "下午三点后带圆宝出去玩",
    "带圆宝出去玩",
  ];
  const expected = {
    "上午十点到下午两点开会": { reminderStart: "10:00", reminderEnd: "14:00" },
    "中午要和慧慧逛街，9点提醒我准备化妆": { reminderStart: "09:00", reminderEnd: "09:00" },
    "九点提醒我准备化妆": { reminderStart: "09:00", reminderEnd: "09:00" },
    "中午12点要和慧慧逛街，9点提醒我准备化妆": { reminderStart: "09:00", reminderEnd: "09:00" },
    "上午九点到十点提醒我准备化妆": { reminderStart: "09:00", reminderEnd: "10:00" },
    "下午3:30-5:30提醒我开会": { reminderStart: "15:30", reminderEnd: "17:30" },
  };
  for (const sample of samples) {
    const parsed = parseClient(sample);
    assert.deepEqual(parsed, parseTodoReminderText(sample), sample);
    if (expected[sample]) assert.deepEqual(parsed, expected[sample], sample);
  }
  const daytimeTitle = "两点 15分要去买椰子水";
  const daytimeOptions = { now: new Date(2026, 8, 2, 14, 7, 0), targetDate: "2026-09-02" };
  assert.deepEqual(parseClient(daytimeTitle, daytimeOptions), parseTodoReminderText(daytimeTitle, daytimeOptions));
  assert.deepEqual(parseClient(daytimeTitle, daytimeOptions), { reminderStart: "14:15", reminderEnd: "14:15" });
  const futureOptions = { now: daytimeOptions.now, targetDate: "2026-09-03" };
  assert.deepEqual(parseClient(daytimeTitle, futureOptions), parseTodoReminderText(daytimeTitle, futureOptions));
  assert.deepEqual(parseClient(daytimeTitle, futureOptions), { reminderStart: "02:15", reminderEnd: "02:15" });
});

test("布局：注入间隔档位含 30 分钟，带机制讲解", async () => {
  const { renderPage } = await import("../lib/page-template.js");
  const html = renderPage("test-token");
  const script = html.split("<script>").slice(1)
    .map((part) => part.split("</script>")[0])
    .find((part) => part.includes("function loadMonth"));
  // 档位：30 分钟 / 1 小时 / 4 小时（默认）/ 8 小时
  assert.match(html, /data-val="0\.5"/);
  assert.match(html, />30 分钟</);
  assert.match(html, />1 小时</);
  assert.match(html, />4 小时</);
  assert.match(html, />8 小时</);
  assert.doesNotMatch(html, /data-val="2"/, "2 小时档已被 30 分钟/1 小时取代");
  // 机制讲解：间隔指空档 + 数据变化即时刷新
  assert.match(html, /id="interval-extra-row"/);
  assert.match(html, /id="interval-tip"/);
  assert.match(script, /两次说话之间的空档/);
  assert.match(script, /下一条消息就会带上/);
  // 均衡模式才显示间隔行
  assert.match(script, /interval-row.*classList\.toggle\('hidden', s\.injectMode !== 'balanced'\)/);
  assert.match(script, /interval-extra-row/);
});

test("布局：宽窗口日历适度放大并保留两侧留白", async () => {
  const { renderPage } = await import("../lib/page-template.js");
  const html = renderPage("test-token");
  assert.match(html, /\.calendar \{[\s\S]*max-width: 980px; margin: 0 auto;/);
  assert.match(html, /\.calendar-guide \{[\s\S]*max-width: 980px; margin:/);
  assert.doesNotMatch(html, /max-width: 760px; margin: 0 auto;/);
});

test("布局：待办增多不撑高日历格，完整内容留在详情面板", async () => {
  const { renderPage } = await import("../lib/page-template.js");
  const html = renderPage("test-token");
  const script = html.split("<script>").slice(1)
    .map((part) => part.split("</script>")[0])
    .find((part) => part.includes("function renderCalendar"));
  assert.match(html, /\.cal-day \{[\s\S]*height: 70px;[\s\S]*max-height: 70px;[\s\S]*overflow: hidden;/);
  assert.match(html, /\.cal-day \.tags \{[\s\S]*max-height: 40px;[\s\S]*overflow: hidden;/);
  assert.match(html, /\.cal-day \{ height: 58px; min-height: 0; max-height: 58px;/);
  assert.ok(script, "页面主脚本应包含日历渲染逻辑");
  assert.match(script, /tags\.slice\(0, 3\)/);
  assert.match(script, /class="tag more"/);
});

test("布局：生理期结束入口（今天结束了）不误删已记日期", async () => {
  const { renderPage } = await import("../lib/page-template.js");
  const html = renderPage("test-token");
  const script = html.split("<script>").slice(1)
    .map((part) => part.split("</script>")[0])
    .find((part) => part.includes("function loadMonth"));
  // 「今天结束了」按钮：昨天/最近在周期内时，今天显示结束入口
  assert.match(script, /今天结束了/);
  assert.match(script, /function endPeriod/);
  assert.match(script, /api\/periods\/end/);
  assert.match(script, /这段生理期到今天结束了吗/);
  assert.match(script, /recentPeriod/);
  // 已记日期保留的语义：不删天，只确认结束
  assert.match(script, /已记的日期都会保留/);
  // 结束后反馈：显示「已结束」确认条，不再给操作按钮
  assert.match(script, /生理期已于/);
  assert.match(script, /结束 ✦/);
  assert.match(script, /confirmedThrough/);
  // 这一页详情区块：修改按钮 + 保存后同步刷新详情
  assert.match(script, /修改<\/button>/);
  assert.match(script, /id="archive-text-/);
  assert.match(script, /function cancelSummaryEdit/);
  assert.match(script, /if \(selectedDate\) selectDay\(selectedDate\)/);
  // 编辑态隐藏原操作按钮：点「修改」后不再残留另一个「修改」
  assert.match(script, /ops\.style\.display = 'none'/);
  assert.match(script, /textEl\.nextElementSibling/);
});

test("路由：生理期结束确认接口已注册", () => {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "sgj-route-test-"));
  const routeUrl = pathToFileURL(path.resolve("routes/ui.js")).href;
  const childCode = `
    import registerRoutes from ${JSON.stringify(routeUrl)};
    const routes = [];
    const app = {
      get(path, handler) { routes.push({ method: "GET", path, handler }); },
      post(path, handler) { routes.push({ method: "POST", path, handler }); },
      put(path, handler) { routes.push({ method: "PUT", path, handler }); },
      delete(path, handler) { routes.push({ method: "DELETE", path, handler }); },
    };
    const ctx = { log: { info() {}, warn() {}, error() {} } };
    registerRoutes(app, ctx);
    const route = routes.find((item) => item.method === "POST" && item.path === "/api/periods/end");
    if (!route) throw new Error("生理期结束确认路由未注册");
    const result = await route.handler({
      req: { json: async () => ({ date: "2026-08-31" }) },
      json(value) { return value; },
    });
    if (!result?.ok) throw new Error("生理期结束确认应返回 ok");
    if (typeof result.changed !== "boolean") throw new Error("生理期结束确认应返回 changed 字段");
    process.exit(0);
  `;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], {
    cwd: path.resolve("."),
    env: { ...process.env, USERPROFILE: isolatedHome, HOME: isolatedHome },
    encoding: "utf-8",
    timeout: 30000,
  });
  assert.equal(res.status, 0, `子进程退出码非 0：${res.stderr || res.stdout}`);
});

test("路由：检查更新与反馈路由已注册且缺 pluginDir 时优雅降级", () => {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "sgj-route-test-"));
  const routeUrl = pathToFileURL(path.resolve("routes/ui.js")).href;
  const childCode = `
    import registerRoutes from ${JSON.stringify(routeUrl)};
    const routes = [];
    const app = {
      get(path, handler) { routes.push({ method: "GET", path, handler }); },
      post(path, handler) { routes.push({ method: "POST", path, handler }); },
      put(path, handler) { routes.push({ method: "PUT", path, handler }); },
      delete(path, handler) { routes.push({ method: "DELETE", path, handler }); },
    };
    // 无 pluginDir 的 mock ctx：验证 manifest 路径 fallback 不抛错
    const ctx = {
      log: { info() {}, warn() {}, error() {} },
      network: { async fetch() { throw new Error("模拟网络不可达"); } },
    };
    registerRoutes(app, ctx);
    const ucRoute = routes.find((item) => item.method === "GET" && item.path === "/api/check-update");
    if (!ucRoute) throw new Error("检查更新路由未注册");
    const uc = await ucRoute.handler({ json(value) { return value; } });
    if (!uc?.ok) throw new Error("检查更新应返回 ok（网络失败也优雅降级）");
    if (typeof uc.hasUpdate !== "boolean") throw new Error("检查更新应返回 hasUpdate 布尔");
    const fbChat = routes.find((item) => item.method === "POST" && item.path === "/api/feedback/chat");
    const fbClose = routes.find((item) => item.method === "POST" && item.path === "/api/feedback/chat/close");
    if (!fbChat || !fbClose) throw new Error("反馈小助手路由未注册");
    process.exit(0);
  `;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], {
    cwd: path.resolve("."),
    env: { ...process.env, USERPROFILE: isolatedHome, HOME: isolatedHome },
    encoding: "utf-8",
    timeout: 30000,
  });
  assert.equal(res.status, 0, `子进程退出码非 0：${res.stderr || res.stdout}`);
});
