import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMessages, limitText, parseJsonContent, validateEdit } from "../../src/llm/client.js";

test("parseJsonContent accepts fenced and prefixed JSON", () => {
  assert.deepEqual(parseJsonContent('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonContent('好的：{"a":2}'), { a: 2 });
  assert.throws(() => parseJsonContent("没有 JSON"), /不是 JSON/);
});

test("validateEdit enforces required fields and limits", () => {
  assert.deepEqual(validateEdit({ title: "标题", summary: "摘要", reason: "理由" }), {
    title: "标题",
    summary: "摘要",
    reason: "理由"
  });
  assert.throws(() => validateEdit({ title: "", summary: "a", reason: "b" }), /标题为空/);
  assert.throws(() => validateEdit({ title: "t", summary: "字".repeat(201), reason: "b" }), /摘要超过/);
  assert.throws(() => validateEdit({ title: "t", summary: "s", reason: "字".repeat(101) }), /推荐理由超过/);
});

test("validateEdit collapses whitespace and trims long titles", () => {
  const result = validateEdit({ title: "  长".repeat(40), summary: "a\n b", reason: "c  d" });
  assert.equal(result.summary, "a b");
  assert.equal(result.reason, "c d");
  assert.ok([...result.title].length <= 60);
});

test("buildMessages lists every source with rank", () => {
  const [system, user] = buildMessages({
    url: "https://example.com/a",
    excerpt: "片段",
    sources: [
      { siteName: "微博热搜", siteRank: 1, title: "甲", excerpt: "" },
      { siteName: "知乎热榜", siteRank: 4, title: "乙", excerpt: "说明" }
    ]
  });
  assert.equal(system.role, "system");
  assert.match(system.content, /只输出 JSON/);
  assert.match(user.content, /微博热搜 第 1 名：甲/);
  assert.match(user.content, /知乎热榜 第 4 名：乙（说明）/);
});

test("limitText counts characters rather than code units", () => {
  assert.equal(limitText("😀😀😀", 2), "😀…");
});
