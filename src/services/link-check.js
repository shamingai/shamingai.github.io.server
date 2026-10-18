const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export async function checkLink(url, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 8000;
  const attempt = async (method) => {
    const response = await fetchImpl(url, {
      method,
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*;q=0.8" },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (method === "GET" && response.body?.cancel) await response.body.cancel().catch(() => {});
    return response;
  };
  try {
    let response = await attempt("HEAD");
    if (response.status === 405 || response.status === 403 || response.status === 501) {
      response = await attempt("GET");
    }
    if (response.status >= 400) return { ok: false, reason: `HTTP ${response.status}` };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error?.name === "TimeoutError" ? "链接超时" : error?.message || "链接不可访问" };
  }
}

export async function filterReachable(items, options = {}) {
  const accepted = [];
  const rejected = [];
  let cursor = 0;
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const results = new Array(items.length);
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await checkLink(items[index].url, options);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  items.forEach((item, index) => {
    if (results[index].ok) accepted.push(item);
    else rejected.push({ url: item.url, title: item.title, reason: `原文不可访问：${results[index].reason}` });
  });
  return { accepted, rejected };
}
