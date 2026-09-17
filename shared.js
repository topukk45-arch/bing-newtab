/* ==========================================================
   壁纸拉取和缓存。newtab.html 用 <script> 引入，
   bg.js（后台 service worker）用 importScripts 引入，两边共用一份。
   这里不能碰 DOM，service worker 里没有。
   ========================================================== */

// 用 www.bing.com：在大陆会自己跳到 cn.bing.com，在境外直接可用，
// 图片两个域名都能取。manifest 里两个域名都要授权。
const BING = "https://www.bing.com";

// 必须显式指定市场。不带这个参数时接口按出口 IP 判断地区，
// IP 一旦不在大陆就会返回国际区数据：说明变英文，换图时刻也和中国区对不上。
// 出口 IP 在大陆时这个参数会被强制忽略，所以两边都安全。
const MKT = "zh-CN";

const API = idx =>
  `${BING}/HPImageArchive.aspx?format=js&idx=${idx}&n=1&mkt=${MKT}` +
  `&uhd=1&uhdwidth=3840&uhdheight=2160&nc=${Date.now()}`;

// 今天那张的缓存有效期。按日期缓存的话，早上第一次拉到什么就锁一整天，
// 接口后来更新了也不会再问一次。往前翻的旧图不会变，不用管。
const TODAY_TTL = 30 * 60 * 1000;

// 缓存版本。存进去的时候连 mkt 一起记下来，
// 市场换了或者数据结构改了就整体作废，免得留着上一版错位的旧记录。
const CACHE_VER = 2;

// 图片本体缓存（Cache API）。扩展页和 service worker 同源，共用这一份。
const IMG_CACHE = "wp-img-v1";
const IMG_KEEP = 16;   // 最多留几张（含 1080P 垫底图），超了删最老的

// 本地日期。不能用 toISOString()，那是 UTC，
// 北京时间 0 点到 8 点之间会算成昨天。
function todayStr() {
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const load = keys => new Promise(r => chrome.storage.local.get(keys, r));
const save = obj => new Promise(r => chrome.storage.local.set(obj, r));

// 跨上下文的互斥锁。新标签页和后台可能同时去拉同一个东西，
// 后到的排队等着，等到了直接吃前一个的缓存，不会重复下载。
const withLock = (name, fn) =>
  (typeof navigator !== "undefined" && navigator.locks)
    ? navigator.locks.request(name, fn)
    : fn();

// 把接口返回的 url 换成想要的分辨率。
// 官方给的是 /th?id=OHR.Xxx_ZH-CN1234_UHD.jpg&rf=...&pid=hp
// host 是接口跳转之后的真实域名（大陆是 cn.bing.com），
// 图片直接走它，省掉每张图一次 www→cn 的 302。老缓存里没有就退回 BING。
function withRes(rawUrl, res, host) {
  const base = rawUrl.split("&")[0];              // 只保留 ?id=...，丢掉 rf/pid
  const id = base.replace(/_(UHD|\d+x\d+)\.jpg.*$/, "");
  const suffix = res === "uhd" ? "_UHD.jpg" : `_${res}.jpg`;
  return (host || BING) + id + suffix + "&rf=LaDigue_1920x1080.jpg&pid=hp";
}

async function readDay(i) {
  const key = `wp_${i}`;
  const c = (await load(key))[key];
  // 版本或市场对不上的，一律当没有
  return c && c.ver === CACHE_VER && c.mkt === MKT ? c : null;
}

// reuseMs：今天的记录如果在这么久之内刚被别人拉过，就直接用，不再打接口。
// 主要是给「后台刚拉完、新标签页紧跟着又要拉」这种情况去重。
function pullDay(i, reuseMs = 0) {
  return withLock(`wp_api_${i}`, async () => {
    if (reuseMs) {
      const c = await readDay(i);
      if (c && c.day === todayStr() && Date.now() - (c.at || 0) < reuseMs) return c.data;
    }

    const res = await fetch(API(i));
    if (!res.ok) throw new Error(`必应接口返回 ${res.status}`);
    const json = await res.json();
    const img = json.images && json.images[0];
    if (!img) throw new Error("必应接口没有返回图片");

    const data = {
      raw: img.url,
      copyright: img.copyright || "",
      startdate: img.startdate || "",
      host: new URL(res.url).origin   // 跟随跳转后的真实域名
    };
    await save({
      [`wp_${i}`]: { ver: CACHE_VER, mkt: MKT, day: todayStr(), at: Date.now(), data }
    });
    return data;
  });
}

async function openImgCache() {
  try { return await caches.open(IMG_CACHE); } catch (e) { return null; }
}

async function pruneImgCache(cache) {
  const keys = await cache.keys();          // 按写入顺序
  for (const k of keys.slice(0, Math.max(0, keys.length - IMG_KEEP))) {
    await cache.delete(k);
  }
}

// 先查本地缓存，没有再下载并存起来。
// 存完再放锁，这样排队的那个进来就能直接命中缓存。
function getImage(url, cache) {
  return withLock(`wp_img_${url}`, async () => {
    if (cache) {
      const hit = await cache.match(url);
      if (hit) return hit.blob();
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`图片返回 ${res.status}`);
    const type = res.headers.get("content-type") || "";
    if (!type.startsWith("image/")) throw new Error("返回的不是图片");

    const blob = await res.blob();
    if (cache) {
      try {
        await cache.put(url, new Response(blob, { headers: { "content-type": type } }));
        await pruneImgCache(cache);
      } catch (e) { /* 存不进去也不影响这次显示 */ }
    }
    return blob;
  });
}

// 后台预取今天的壁纸：接口 + 1080P + 设置里选的清晰度，全部落进缓存。
// 返回 true 表示目标清晰度已经就位。
async function prefetchToday() {
  const { cfg } = await load("cfg");
  if (cfg && cfg.locked) return true;      // 锁着的话今天的图用不上
  const res = (cfg && cfg.res) || "uhd";

  const data = await pullDay(0, 10 * 60 * 1000);
  const cache = await openImgCache();
  if (!cache) return false;

  if (res === "uhd") {
    await getImage(withRes(data.raw, "1920x1080", data.host), cache).catch(() => {});
  }
  try {
    await getImage(withRes(data.raw, res, data.host), cache);
    return true;
  } catch (e) {
    return false;   // 4K 可能刚过零点还没生成好，交给重试
  }
}
