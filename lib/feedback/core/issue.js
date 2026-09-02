// feedback · core/issue.js — <issue> 块解析 / 文案渲染 / 预填 URL 拼装

const ISSUE_TAG_RE = /<issue>([\s\S]*?)<\/issue>/gi;

// 字段白名单 + 类型收紧（防脏数据）
export function sanitizeIssue(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const title = String(raw.title || "").trim().slice(0, 80);
  const description = String(raw.description || "").trim().slice(0, 2000);
  const steps = Array.isArray(raw.steps)
    ? raw.steps.map((s) => String(s || "").trim()).filter(Boolean).slice(0, 10)
    : [];
  const expected = String(raw.expected || "").trim().slice(0, 500);
  const actual = String(raw.actual || "").trim().slice(0, 500);
  if (!title && !description && steps.length === 0 && !expected && !actual) return null;
  return { title, description, steps, expected, actual };
}

// 从模型回复里提取 <issue> 块（取最后一个，避免模型啰嗦时多个标签）
export function parseIssue(text) {
  if (!text) return null;
  let match = null;
  let m;
  ISSUE_TAG_RE.lastIndex = 0;
  while ((m = ISSUE_TAG_RE.exec(text)) !== null) match = m;
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1].trim());
    return sanitizeIssue(parsed);
  } catch {
    return null; // JSON 解析失败当没有 issue，模型下轮会重试
  }
}

// 去掉回复里的 <issue> 标签（前端展示干净）
export function stripIssueTag(text) {
  if (!text) return "";
  return String(text).replace(ISSUE_TAG_RE, "").trim();
}

// 渲染成 GitHub 友好的 Markdown 文案（复制用 + 预填 body 用同一份）
export function renderIssueText(issue, envText) {
  if (!issue) return "";
  const parts = [];
  if (issue.description) parts.push(`## 描述\n${issue.description}`);
  if (issue.steps && issue.steps.length > 0) {
    parts.push(`## 复现步骤\n${issue.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`);
  }
  if (issue.expected) parts.push(`## 期望行为\n${issue.expected}`);
  if (issue.actual) parts.push(`## 实际表现\n${issue.actual}`);
  if (envText) parts.push(`## 环境信息\n${envText}`);
  return parts.join("\n\n");
}

// 拼 GitHub issues/new 预填 URL（用户打开只需检查 + 点提交）
export function buildPrefillUrl({ repo, issue, envText }) {
  if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) return "";
  const base = `https://github.com/${repo}/issues/new`;
  const title = issue?.title || "反馈";
  const body = renderIssueText(issue, envText);
  const params = new URLSearchParams({ title, body });
  return `${base}?${params.toString()}`;
}
