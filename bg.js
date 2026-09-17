/* ==========================================================
   后台预取。目的只有一个：跨天第一次开新标签页时，图已经在缓存里了。
   - 浏览器启动时拉一次（onStartup）
   - 每天 00:02 拉一次（浏览器开着过夜的情况）
   - 失败了 10 分钟后重试，最多 6 次
   ========================================================== */
importScripts("shared.js");

const MAX_RETRY = 6;

// 下一个本地 00:02。中国没有夏令时，按 24 小时算就行。
function nextRunAt() {
  const d = new Date();
  d.setHours(0, 2, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

// 每次启动都重新对一下时间点，电脑睡眠过久漂了也能拉回来
function schedule() {
  chrome.alarms.create("daily", { when: nextRunAt(), periodInMinutes: 24 * 60 });
}

async function run(isRetry) {
  let ok = false;
  try {
    ok = await prefetchToday();
  } catch (e) {
    console.warn("预取失败：", e.message);
  }

  const { pfRetry = 0 } = await load("pfRetry");
  if (ok) {
    if (pfRetry) await save({ pfRetry: 0 });
    return;
  }
  const n = isRetry ? pfRetry + 1 : 1;
  if (n > MAX_RETRY) { await save({ pfRetry: 0 }); return; }
  await save({ pfRetry: n });
  chrome.alarms.create("retry", { delayInMinutes: 10 });
}

chrome.runtime.onInstalled.addListener(() => { schedule(); run(false); });
chrome.runtime.onStartup.addListener(() => { schedule(); run(false); });

chrome.alarms.onAlarm.addListener(a => {
  if (a.name === "daily") run(false);
  else if (a.name === "retry") run(true);
});
