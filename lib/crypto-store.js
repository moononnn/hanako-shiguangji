// 拾光记 · 轻量自包含加密
// 目标：防「被乱扫到明文」——别的 agent 软件/扫描器/AI 翻数据目录时看到的是乱码，不是明文。
// 级别：防扫描，不防「专门盯着本插件把密钥+密文一起拷走」的专业破解（那需要口令加密，分享版不做）。
// 设计：随机密钥自包含，零用户操作。密钥文件与加密数据分开放，命名不起眼。
// 实现：Node 内置 crypto，AES-256-GCM。零依赖。

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ALGO = "aes-256-gcm";
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;

// 密钥文件名：不起眼，不叫 key.json 这种一眼暴露的
const KEY_FILE = ".sgj.key";
const KEY_PREFIX = "sgj1:";

function randHex(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}

/**
 * 创建或读取密钥。
 * @param {string} keyDir 数据目录（与密文分开放）
 * @returns {Buffer} 32 字节密钥
 */
export function loadOrCreateKey(keyDir) {
  const keyPath = path.join(keyDir, KEY_FILE);
  try {
    const raw = fs.readFileSync(keyPath, "utf-8").trim();
    if (raw.startsWith(KEY_PREFIX)) {
      const hex = raw.slice(KEY_PREFIX.length);
      const buf = Buffer.from(hex, "hex");
      if (buf.length === KEY_LEN) return buf;
    }
  } catch {
    // 文件不存在或损坏，重建
  }
  const key = crypto.randomBytes(KEY_LEN);
  fs.mkdirSync(keyDir, { recursive: true });
  fs.writeFileSync(keyPath, KEY_PREFIX + key.toString("hex"), { mode: 0o600 });
  return key;
}

/**
 * 加密 JSON 值 → 单行密文（base64: iv:tag:ciphertext）
 */
export function encryptJson(key, value) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const plain = Buffer.from(JSON.stringify(value), "utf-8");
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

/**
 * 解密单行密文 → JSON 值。失败返回 null（不抛错，读侧容错）。
 */
export function decryptJson(key, payload) {
  try {
    if (!payload || typeof payload !== "string") return null;
    const parts = payload.split(":");
    if (parts.length !== 3) return null;
    const [ivB64, tagB64, ctB64] = parts;
    const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(ctB64, "base64")),
      decipher.final(),
    ]);
    return JSON.parse(plain.toString("utf-8"));
  } catch {
    return null; // 密钥错/密文损坏/JSON 坏，统一读不到
  }
}

// 文件写入辅助：先临时文件再 rename，避免写一半损坏。
// rename 前对临时文件 fsync，把页缓存落盘，断电/崩溃时不会丢最后一次写入。
function writeFileAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, data);
  try {
    const fd = fs.openSync(tmp, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // fsync 失败（个别文件系统不支持）不阻断写入，rename 兜底保原子性。
  }
  fs.renameSync(tmp, filePath);
}

/**
 * 加密文件存储：整文件加密的 JSON 对象。
 * 读写走内存对象，save 时整体加密写盘。适合低频小数据（用户自定义日子/待办）。
 */
export class EncryptedStore {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir 数据目录（密钥也在这）
   * @param {string} opts.fileName 密文文件名
   * @param {object} opts.defaults 默认值（深合并用浅合并即可，数据层自己管理结构）
   */
  constructor({ dataDir, fileName, defaults = {} }) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, fileName);
    this.key = loadOrCreateKey(dataDir);
    this.defaults = defaults;
    this.data = null; // 懒加载缓存
    this._writeQueue = Promise.resolve();
  }

  // 读取（带缓存；损坏回退默认值）
  read() {
    if (this.data) return this.data;
    let parsed = null;
    try {
      if (fs.existsSync(this.filePath)) {
        const cipher = fs.readFileSync(this.filePath, "utf-8");
        parsed = decryptJson(this.key, cipher);
      }
    } catch {
      parsed = null;
    }
    this.data = { ...this.defaults, ...(parsed || {}) };
    return this.data;
  }

  // 整体保存（串行队列防并发写坏）
  save() {
    const snapshot = this.read();
    this._writeQueue = this._writeQueue.then(() => {
      const cipher = encryptJson(this.key, snapshot);
      writeFileAtomic(this.filePath, cipher);
    });
    return this._writeQueue;
  }

  // 更新：mutator 就地改 data，然后保存
  async update(mutator) {
    const data = this.read();
    mutator(data);
    await this.save();
    return data;
  }
}
