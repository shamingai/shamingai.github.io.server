const SUMMARY_LIMIT = 200;
const REASON_LIMIT = 100;

export function limitText(value, limit) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return [...text].length > limit ? [...text].slice(0, limit - 1).join("") + "…" : text;
}

export function buildMessages(candidate) {
  const sources = candidate.sources
    .map((source) => `- ${source.siteName} 第 ${source.siteRank} 名：${source.title}${source.excerpt ? `（${source.excerpt}）` : ""}`)
    .join("\n");
  return [
    {
      role: "system",
      content:
        "你是资讯编辑。根据提供的热榜条目，写一条便于扫读的资讯条目。只输出 JSON，不要输出任何解释或代码块标记。" +
        'JSON 形状：{"title": "中文标题，保留关键名词", "summary": "≤200字的客观摘要", "reason": "≤100字的推荐理由"}。' +
        "摘要与推荐理由只能基于给出的事实，不得编造细节；信息不足时宁可就事论事，也不要补充未知内容。"
    },
    {
      role: "user",
      content: `原文链接：${candidate.url}\n各站条目：\n${sources}\n\n${candidate.excerpt ? `片段：${candidate.excerpt}\n` : ""}请输出 JSON。`
    }
  ];
}

export function parseJsonContent(content) {
  const text = String(content ?? "").trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("响应不是 JSON");
  return JSON.parse(body.slice(start, end + 1));
}

export function validateEdit(value) {
  if (!value || typeof value !== "object") throw new Error("缺少字段");
  const title = String(value.title ?? "").replace(/\s+/g, " ").trim();
  const summary = String(value.summary ?? "").replace(/\s+/g, " ").trim();
  const reason = String(value.reason ?? "").replace(/\s+/g, " ").trim();
  if (!title) throw new Error("标题为空");
  if (!summary) throw new Error("摘要为空");
  if (!reason) throw new Error("推荐理由为空");
  if ([...summary].length > SUMMARY_LIMIT) throw new Error("摘要超过 200 字");
  if ([...reason].length > REASON_LIMIT) throw new Error("推荐理由超过 100 字");
  return { title: limitText(title, 60), summary, reason };
}

export async function editCandidate(client, candidate) {
  const content = await client.chat(buildMessages(candidate));
  return validateEdit(parseJsonContent(content));
}

export function createOpenAiClient({ baseUrl, apiKey, model, timeoutMs = 120000, fetch: fetchImpl = globalThis.fetch }) {
  if (!baseUrl || !model) return null;
  return {
    model,
    async chat(messages) {
      const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
        },
        body: JSON.stringify({ model, messages, temperature: 0.3, response_format: { type: "json_object" } }),
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) throw new Error(`语言模型接口返回 HTTP ${response.status}`);
      const body = await response.json();
      const content = body?.choices?.[0]?.message?.content;
      if (!content) throw new Error("语言模型响应为空");
      return content;
    }
  };
}
