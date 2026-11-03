import * as cheerio from "cheerio";
import { toCandidates } from "./shared.js";

// AI 安全品类。安全站点一天出几十条，大部分和模型无关，这里只留标题里沾 AI 的。
// agent / model 这类泛词要带修饰才认，单独出现多半是"海关探员""数据模型"这种无关用法。
const AI_TOPIC =
  /(\bAI\b|\bA\.I\.|LLM|大模型|人工智能|生成式|\bGPT|OpenAI|Anthropic|\bClaude\b|Gemini|DeepSeek|通义|豆包|Kimi|DeepMind|\b(?:AI|LLM|autonomous|coding|intelligent)\W{0,3}agents?\b|\bagents?\s+(?:using|with|that)\b|智能体|prompt injection|提示注入|jailbreak|越狱|deepfake|深度伪造|machine learning|(?:frontier|language|AI|LLM)\W{0,3}models?\b|Copilot|vibe[- ]cod)/i;

const HN_SECURITY_FILTERS = "numericFilters=created_at_i>1791379000,points>4";

function decodeEntities(value) {
  return String(value ?? "")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function xmlOf(text) {
  return cheerio.load(text ?? "", { xmlMode: true }, false);
}

function aiMentions(value) {
  return new Set(String(value ?? "").match(new RegExp(AI_TOPIC.source, "gi")) ?? []).size;
}

// 标题沾 AI 的直接留；标题不沾的，要求正文里出现两种以上不同的 AI 词，挡掉顺带提一句大模型的纯安全新闻。
function isAiStory(hit) {
  const title = String(hit.title ?? "");
  if (AI_TOPIC.test(title)) return true;
  const body = decodeEntities(String(hit.story_text ?? "").replace(/<[^>]+>/g, " "));
  return aiMentions(body) >= 2;
}

// Hacker News 没有安全榜，用 Algolia 搜 security 类帖子，再按 AI 相关性筛一遍，按热度排。
function hnSecurityAi({ json, site }) {
  const items = (json?.hits ?? [])
    .filter((hit) => isAiStory(hit))
    .sort((left, right) => (right.points ?? 0) - (left.points ?? 0))
    .map((hit) => ({
      title: hit.title ?? "",
      url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
      excerpt: hit.story_text ? decodeEntities(String(hit.story_text).replace(/<[^>]+>/g, " ")).trim().slice(0, 400) : `${hit.points ?? 0} 分`,
      publishedAt: hit.created_at ? String(hit.created_at).slice(0, 10) : null,
      siteRank: null
    }));
  return toCandidates(items, site);
}

// 标准 WordPress/Hugo RSS：channel > item。综合安全站传 aiOnly，标题不沾 AI 的丢掉。
function securityRss({ text, site }, { aiOnly = false } = {}) {
  const $ = xmlOf(text);
  const channel = $("channel").first();
  const items = [];
  channel.find("item").each((_index, element) => {
    const item = $(element);
    const title = decodeEntities(item.find("title").first().text()).trim();
    if (!title) return;
    if (aiOnly && !AI_TOPIC.test(title)) return;
    const excerpt = decodeEntities(
      item
        .find("description")
        .first()
        .text()
        .replace(/<[^>]+>/g, " ")
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 400);
    const published = new Date(item.find("pubDate").first().text());
    items.push({
      title,
      url: item.find("link").first().text().trim(),
      excerpt,
      publishedAt: Number.isNaN(published.getTime()) ? null : published.toISOString().slice(0, 10)
    });
  });
  return toCandidates(items, site);
}

export const adapters = {
  "hn-security-ai": async (ctx) => hnSecurityAi(ctx),
  "security-rss": async (ctx) => securityRss(ctx, { aiOnly: true }),
  // Embrace The Red 主讲 AI 攻击面，但也发纯系统漏洞，同样按标题过一遍。
  "embracethered-rss": async (ctx) => securityRss(ctx, { aiOnly: true })
};

export { AI_TOPIC, HN_SECURITY_FILTERS };
