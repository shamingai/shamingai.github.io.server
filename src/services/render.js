import { catalogLabel } from "./catalog.js";

export const DIGEST_TAG = "资讯";
export const DIGEST_CATEGORY = "资讯";

export function digestSlug(date, key = "") {
  return key ? `daily-${date}-${key}` : `daily-${date}`;
}

export function digestTitle(date, { regenerated = false, label = catalogLabel() } = {}) {
  return `${date} ${label}${regenerated ? "（更新）" : ""}`;
}

function quote(value) {
  return String(value ?? "").replace(/\r?\n/g, " ").trim();
}

// 只产出文章正文。资讯不再落成 md 文件，标题、分类、摘要直接进 articles 表。
export function renderDigestBody({ items, note, regenerated = false }) {
  const lines = [];
  if (regenerated) lines.push("> 本篇为对当日资讯的重新生成版本，已替换早先内容。", "");
  if (note) lines.push(`> ${note}`, "");
  lines.push(`共收录 ${items.length} 条，按热度排序。每条附原文链接，点击可前往来源站点阅读全文。`, "");
  items.forEach((item, index) => {
    const rank = index + 1;
    lines.push(`## ${rank}. ${quote(item.title)}`, "");
    lines.push(`- 来源：${item.siteName} 第 ${item.siteRank} 名${item.mentionCount > 1 ? `，共 ${item.mentionCount} 个站点提及` : ""}`);
    if (item.publishedAt) lines.push(`- 时间：${item.publishedAt}`);
    lines.push(`- 链接：[原文](${item.url})`, "");
    lines.push(`**摘要**：${item.summary}`, "");
    lines.push(`**推荐理由**：${item.reason}`, "");
  });
  return lines.join("\n").replace(/\n+$/, "") + "\n";
}

export function digestSummary(items, { label = catalogLabel() } = {}) {
  const top = items[0];
  if (!top) return label;
  return `今日热点：${top.title}。共收录 ${items.length} 条，来自 ${new Set(items.map((item) => item.siteId)).size} 个来源站点。`;
}
