// model-config · core/crypto.js — Key 存储（三层标准，见 plugin-dev-guide references/13-credential-policy.md）
//
// 三层：
//   L2 系统锁：Windows DPAPI 真加密，前缀 dpapi:，绑定当前用户+机器，文件出逃也解不开（推荐）
//   enc: 旧版 XOR 混淆存量：只读兼容，保存时自动迁移成 dpapi:
//   L3 明文兜底：无前缀，DPAPI 不可用（非 Windows / 系统异常）时；UI 显示「明文保存」提示
//
// 禁止把 XOR/Base64 当「加密」宣传：enc: 只作为历史存量兼容通道，新写入一律走 dpapi:
//
// API：
//   encryptKey(plain) / decryptKey(stored)      — 同步，仅 enc: XOR 通道（兼容旧调用与存量）
//   protectKey(plain)  / unprotectKey(stored)   — 异步，主通道（dpapi: → enc: → 明文）
//   maskKey(stored)                             — 脱敏显示（dpapi: 只显示加密标识，不解密）
//   getStorageMode(stored)                      — "dpapi" | "enc" | "plain" | "none"

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const DEFAULT_SALT = "plugin-kit-model-config-2026";

// ── PowerShell DPAPI（Windows 系统锁，零依赖）──
// 值走环境变量传参，不拼命令行（Key 里可能有 & | $ 等特殊字符）
// windowsHide 防闪黑窗；进程内缓存避免每次请求都 spawn

const PS_PROTECT = `
Add-Type -AssemblyName System.Security
$b = [Text.Encoding]::UTF8.GetBytes($env:DPAPI_PLAIN)
$e = [Security.Cryptography.ProtectedData]::Protect($b, $null, 'CurrentUser')
[Convert]::ToBase64String($e)`;

const PS_UNPROTECT = `
Add-Type -AssemblyName System.Security
$b = [Convert]::FromBase64String($env:DPAPI_STORED)
$d = [Security.Cryptography.ProtectedData]::Unprotect($b, $null, 'CurrentUser')
[Text.Encoding]::UTF8.GetString($d)`;

const _dpapiCache = new Map(); // dpapi body -> 明文

function _dpapiPlatformOk() {
  return process.platform === "win32";
}

async function _dpapiProtect(plain) {
  const { stdout } = await execFileP("powershell",
    ["-NoProfile", "-NonInteractive", "-Command", PS_PROTECT], {
      env: { ...process.env, DPAPI_PLAIN: plain },
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
  const out = stdout.trim();
  if (!out) return "";
  _dpapiCache.set(out, plain);
  return "dpapi:" + out;
}

async function _dpapiUnprotect(body) {
  if (_dpapiCache.has(body)) return _dpapiCache.get(body);
  const { stdout } = await execFileP("powershell",
    ["-NoProfile", "-NonInteractive", "-Command", PS_UNPROTECT], {
      env: { ...process.env, DPAPI_STORED: body },
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
  const out = stdout.trim();
  _dpapiCache.set(body, out);
  return out;
}

export function createCrypto(salt = DEFAULT_SALT, opts = {}) {
  const _SALT = Buffer.from(salt, "utf-8");
  // opts.dpapi === false 时强制禁用系统锁（测试降级路径用）；默认 win32 启用
  const _dpapiEnabled = opts.dpapi !== false && _dpapiPlatformOk();

  // ── enc: XOR 通道（历史存量兼容；禁止用于新写入）──
  function encryptKey(plain) {
    if (!plain) return "";
    const buf = Buffer.from(plain, "utf-8");
    const out = Buffer.alloc(buf.length);
    for (let i = 0; i < buf.length; i++) {
      out[i] = buf[i] ^ _SALT[i % _SALT.length];
    }
    return "enc:" + out.toString("base64");
  }

  function decryptKey(stored) {
    if (!stored) return "";
    if (!stored.startsWith("enc:")) return stored; // 兼容旧版明文存量
    const body = stored.slice(4);
    // 严格 base64 校验：防明文恰好以 enc: 开头被误判为密文（解码出乱码）
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body) || body.length % 4 !== 0) return stored;
    try {
      const buf = Buffer.from(body, "base64");
      const out = Buffer.alloc(buf.length);
      for (let i = 0; i < buf.length; i++) {
        out[i] = buf[i] ^ _SALT[i % _SALT.length];
      }
      return out.toString("utf-8");
    } catch {
      return stored; // 解码失败回退原样，不破坏存量
    }
  }

  // ── 主通道（异步）：dpapi: → enc: → 明文 ──
  async function protectKey(plain) {
    if (!plain) return "";
    if (_dpapiEnabled) {
      try {
        const enc = await _dpapiProtect(plain);
        if (enc) return enc;
      } catch (e) {
        // 系统锁不可用：落到明文兜底（L3），UI 会显示「明文保存」
        void e;
      }
    }
    return plain; // 明文兜底（不产生 enc:，符合「禁止伪加密」）
  }

  async function unprotectKey(stored) {
    if (!stored) return "";
    if (stored.startsWith("dpapi:")) {
      const body = stored.slice(6);
      if (_dpapiEnabled) {
        try {
          return await _dpapiUnprotect(body);
        } catch {
          return ""; // 系统锁解不开：返回空，宁缺毋滥（请求会报配置不完整，不拿密文乱发）
        }
      }
      return ""; // 系统锁不可用也解不开
    }
    return decryptKey(stored); // enc: XOR 或明文原样
  }

  // 脱敏显示：dpapi: 不解密，只显示加密标识
  function maskKey(stored) {
    if (!stored) return "";
    if (stored.startsWith("dpapi:")) return "********"; // 系统加密，不展示明文痕迹
    const plain = decryptKey(stored);
    if (!plain) return "";
    if (plain.length <= 8) return "********";
    return `${plain.slice(0, 4)}…${plain.slice(-4)}`;
  }

  // 存储模式（给 UI 提示「明文保存」用）
  function getStorageMode(stored) {
    if (!stored) return "none";
    if (stored.startsWith("dpapi:")) return "dpapi";
    if (stored.startsWith("enc:")) return "enc";
    return "plain";
  }

  return { encryptKey, decryptKey, maskKey, protectKey, unprotectKey, getStorageMode };
}

const _default = createCrypto();
export const encryptKey = _default.encryptKey;
export const decryptKey = _default.decryptKey;
export const maskKey = _default.maskKey;
export const protectKey = _default.protectKey;
export const unprotectKey = _default.unprotectKey;
export const getStorageMode = _default.getStorageMode;
