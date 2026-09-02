// feedback · core/session.js — 多轮会话管理（内存 + TTL 清理）
// 会话上限防内存膨胀；过期会话惰性清理；close 显式释放

import crypto from "node:crypto";

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 100;

export class ChatSession {
  constructor({ ttlMs = DEFAULT_TTL_MS, maxSessions = DEFAULT_MAX_SESSIONS } = {}) {
    this.ttlMs = ttlMs;
    this.maxSessions = maxSessions;
    this.map = new Map();
  }

  _genId() {
    return crypto.randomBytes(8).toString("hex");
  }

  // 取会话（不存在/过期返回 null；取到会刷新 lastActive）
  get(sid) {
    if (!sid) return null;
    const s = this.map.get(sid);
    if (!s) return null;
    if (Date.now() - s.lastActive > this.ttlMs) {
      this.map.delete(sid);
      return null;
    }
    s.lastActive = Date.now();
    return s;
  }

  create() {
    this._cleanup();
    if (this.map.size >= this.maxSessions) {
      // 淘汰最久未活跃的
      let oldest = null;
      for (const [id, s] of this.map) {
        if (!oldest || s.lastActive < oldest.lastActive) oldest = { id, s };
      }
      if (oldest) this.map.delete(oldest.id);
    }
    const sid = this._genId();
    this.map.set(sid, { history: [], lastActive: Date.now() });
    return sid;
  }

  // 追加消息（会话不存在自动创建）
  push(sid, role, content) {
    let s = this.get(sid);
    if (!s) {
      sid = this.create();
      s = this.map.get(sid);
    }
    s.history.push({ role, content: String(content || "") });
    if (s.history.length > 60) s.history = s.history.slice(-60); // 防无限膨胀
    return sid;
  }

  history(sid) {
    const s = this.get(sid);
    return s ? s.history : [];
  }

  close(sid) {
    this.map.delete(sid);
  }

  _cleanup() {
    const now = Date.now();
    for (const [id, s] of this.map) {
      if (now - s.lastActive > this.ttlMs) this.map.delete(id);
    }
  }
}
