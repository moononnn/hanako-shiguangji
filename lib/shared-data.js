// 拾光记 · 进程内共享数据实例
// routes、before_agent_start 扩展和工具必须共用同一个 UserData，避免设置/天气/总结更新后各自继续读旧缓存。
// 延迟创建是为了让只加载工具模块的测试/宿主探测不提前创建用户数据密钥。

import os from "node:os";
import path from "node:path";
import { UserData } from "./data.js";

const DATA_DIR = path.join(os.homedir(), ".hanako", "plugin-data", "shiguangji");
let sharedUserData = null;

export function getSharedUserData() {
  if (!sharedUserData) sharedUserData = new UserData(DATA_DIR);
  return sharedUserData;
}

// 仅供自动测试替换为临时数据实例；生产代码不调用。
export function __setSharedUserDataForTest(data) {
  sharedUserData = data || null;
}
