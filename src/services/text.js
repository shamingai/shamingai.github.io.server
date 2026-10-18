export function wordCount(body) {
  return String(body ?? "").replace(/\s+/g, "").length;
}

export function readingMinutes(count) {
  return Math.max(1, Math.ceil(count / 400));
}
