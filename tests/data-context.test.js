import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

test("宿主数据目录：路由和工具优先使用 ctx.dataDir", () => {
  const pluginRoot = path.resolve(".");
  const routeUrl = pathToFileURL(path.join(pluginRoot, "routes/ui.js")).href;
  const addEventUrl = pathToFileURL(path.join(pluginRoot, "tools/add-event.js")).href;
  const todayUrl = pathToFileURL(path.join(pluginRoot, "tools/today.js")).href;
  const sharedUrl = pathToFileURL(path.join(pluginRoot, "lib/shared-data.js")).href;
  const dataUrl = pathToFileURL(path.join(pluginRoot, "lib/data.js")).href;
  const logUrl = pathToFileURL(path.join(pluginRoot, "lib/debug-log.js")).href;
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "sgj-data-context-"));
  const childCode = `
    import fs from "node:fs";
    import path from "node:path";
    const root = process.env.SGJ_CONTEXT_ROOT;
    const customDataDir = path.join(root, "custom-data");
    const otherDataDir = path.join(root, "other-data");
    const { default: registerRoutes } = await import(${JSON.stringify(routeUrl)});
    const { execute: addEvent } = await import(${JSON.stringify(addEventUrl)});
    const { execute: today } = await import(${JSON.stringify(todayUrl)});
    const { getSharedUserData } = await import(${JSON.stringify(sharedUrl)});
    const { UserData, dateKey } = await import(${JSON.stringify(dataUrl)});
    const { logInfo } = await import(${JSON.stringify(logUrl)});
    const routes = [];
    const app = {
      get(route, handler) { routes.push({ method: "GET", route, handler }); },
      post(route, handler) { routes.push({ method: "POST", route, handler }); },
      put(route, handler) { routes.push({ method: "PUT", route, handler }); },
      delete(route, handler) { routes.push({ method: "DELETE", route, handler }); },
    };
    registerRoutes(app, { dataDir: customDataDir, log: { info() {}, warn() {}, error() {} } });
    const settings = routes.find((item) => item.method === "POST" && item.route === "/api/settings");
    if (!settings) throw new Error("设置路由未注册");
    const settingsResult = await settings.handler({
      req: { json: async () => ({ weatherEnabled: false }) },
      json(value) { return value; },
    });
    if (!settingsResult.ok) throw new Error("设置写入失败：" + JSON.stringify(settingsResult));
    if (!fs.existsSync(path.join(customDataDir, "settings.dat"))) throw new Error("设置没有写入 ctx.dataDir");
    if (path.resolve(getSharedUserData().dataDir) !== path.resolve(customDataDir)) {
      throw new Error("共享数据没有绑定 ctx.dataDir");
    }
    const todayKey = dateKey(new Date());
    const first = await addEvent({ date: todayKey, title: "自定义路径测试", type: "event" }, { dataDir: customDataDir });
    if (!first.content?.[0]?.text?.includes("自定义路径测试")) throw new Error("自定义目录添加日子失败");
    const second = await addEvent({ date: todayKey, title: "另一目录测试", type: "event" }, { dataDir: otherDataDir });
    if (!second.content?.[0]?.text?.includes("另一目录测试")) throw new Error("工具 ctx.dataDir 切换失败");
    const otherEvents = new UserData(otherDataDir).eventsOnDate(new Date());
    if (!otherEvents.some((event) => event.title === "另一目录测试")) throw new Error("工具数据没有写入自己的 ctx.dataDir");
    const todayResult = await today({}, { dataDir: otherDataDir });
    if (!todayResult.content?.[0]?.text?.includes("另一目录测试")) throw new Error("查询工具没有读取自己的 ctx.dataDir");
    logInfo("ctx data directory test");
    if (!fs.existsSync(path.join(customDataDir, "debug.log"))) throw new Error("日志没有跟随 ctx.dataDir");
    process.stdout.write(JSON.stringify({ ok: true, customDataDir, otherDataDir }) + "\\n");
    process.exit(0);
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], {
    cwd: pluginRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      USERPROFILE: isolatedHome,
      HOME: isolatedHome,
      HANA_HOME: path.join(isolatedHome, ".hanako"),
      SGJ_CONTEXT_ROOT: isolatedHome,
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"ok":true/);
});
