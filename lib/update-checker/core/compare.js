// update-checker · core/compare.js — 语义化版本对比
// 规则：数字段逐位比（缺段补 0）；正式版 > 预发布；alpha < beta < rc < 其他预发布；
//       +build 构建元数据忽略；同等级预发布的数字后缀按数值比（beta.10 > beta.2）；
//       解析不了的当 0.0.0，不抛错

function parseVersion(v) {
  const s = String(v || "").trim().replace(/^v/i, "");
  // 拆成：数字段 + 预发布段（- 后、+ 前）+ 构建元数据（+ 后，忽略）
  const match = s.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([^+]+))?(?:\+.*)?$/);
  if (!match) return { nums: [0, 0, 0], pre: "" };
  return {
    nums: [match[1] || 0, match[2] || 0, match[3] || 0].map(Number),
    pre: match[4] || "",
  };
}

function prereleaseRank(pre) {
  if (!pre) return 1; // 正式版最大
  // 开发中版本（dev/snapshot/nightly 等）比 alpha 还早
  if (/^(dev|snapshot|nightly|master|trunk)/i.test(pre)) return 0.05;
  if (/^alpha/i.test(pre)) return 0.1;
  if (/^beta/i.test(pre)) return 0.2;
  if (/^rc/i.test(pre)) return 0.3;
  return 0.4; // 其他未知预发布保守排最后
}

// 同等级预发布比较：段拆开，数字段按数值比，数字 < 字母，其余词典序
// 先归一化黏连式写法（beta10 → beta.10），避免词典序把 beta10 判得比 beta2 旧
function comparePre(a, b) {
  if (a === b) return 0;
  const norm = (s) => s.replace(/^([a-z]+)(\d+)$/i, "$1.$2");
  const sa = norm(a).split(".");
  const sb = norm(b).split(".");
  const len = Math.max(sa.length, sb.length);
  for (let i = 0; i < len; i++) {
    const x = sa[i] ?? "";
    const y = sb[i] ?? "";
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) > Number(y) ? 1 : -1;
    if (xn) return -1; // 数字标识符 < 字母标识符（semver 规则）
    if (yn) return 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

// 返回 1 = a 比 b 新，-1 = a 比 b 旧，0 = 相等
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] > pb.nums[i] ? 1 : -1;
  }
  const ra = prereleaseRank(pa.pre);
  const rb = prereleaseRank(pb.pre);
  if (ra !== rb) return ra > rb ? 1 : -1;
  if (ra === 1) return 0; // 都是正式版且数字段相同
  return comparePre(pa.pre, pb.pre);
}
