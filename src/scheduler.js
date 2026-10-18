import { GenerateError, generateDigest } from "./services/digest.js";
import { todayInShanghai } from "./services/sync.js";

function shanghaiParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

export function localHourOf(date, timeZone) {
  const parts = shanghaiParts(date, timeZone);
  return { hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second) };
}

export function msUntilNext(hour, minute, now = new Date(), timeZone = "Asia/Shanghai") {
  const current = localHourOf(now, timeZone);
  const currentSeconds = current.hour * 3600 + current.minute * 60 + current.second;
  const targetSeconds = hour * 3600 + minute * 60;
  const delta = targetSeconds - currentSeconds;
  return (delta > 0 ? delta : delta + 86400) * 1000;
}

export function startScheduler({ db, config, log = () => {} }) {
  const { hour, minute, timeZone } = config.schedule;
  let timer = null;
  let stopped = false;

  const scheduleNext = () => {
    if (stopped) return;
    const now = new Date();
    const wait = msUntilNext(hour, minute, now, timeZone);
    timer = setTimeout(async () => {
      const date = todayInShanghai();
      try {
        const result = await generateDigest(db, config, { date, kind: "daily" });
        log(`每日资讯已生成：${result.slug}（${result.item_count} 条）`);
      } catch (error) {
        if (error instanceof GenerateError && error.code === "duplicate_date") {
          log(`每日资讯跳过：${date} 已存在`);
        } else {
          log(`每日资讯生成失败：${error.code ?? error.message} ${error.message}`);
        }
      } finally {
        scheduleNext();
      }
    }, wait);
    timer.unref?.();
    const next = new Date(now.getTime() + wait);
    log(`下次生成时间：${hour}:${String(minute).padStart(2, "0")} ${timeZone}（本地 ${next.toLocaleString("zh-CN", { timeZone })}）`);
  };

  scheduleNext();
  return {
    nextWaitMs: () => msUntilNext(hour, minute, new Date(), timeZone),
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    }
  };
}
