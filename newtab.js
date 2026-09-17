/* ==========================================================
   天气配置放在 config.js 里（不进 git），格式见 config.example.js。
   没有 config.js 或者没填，右上角就不显示天气，其他功能不受影响。
   ========================================================== */
const WEATHER = Object.assign({ host: "", key: "" }, self.WEATHER_CONFIG || {});

// 搜索框上已经没有切换按钮了。以后想加谷歌、百度，
// 在这儿补一条，再把切换器放进设置面板，别塞回搜索框。
const ENGINES = {
  bing:   { label: "必应",   url: "https://www.bing.com/search?q=" },
};

const DEFAULTS = {
  engine: "bing", res: "uhd", dim: 0, blur: 0, showCap: true,
  cityId: "101010100", cityName: "北京",
  // 拼 MSN 链接要用，第一次在设置里选过城市之后才会有
  cityGeo: null,  // { adm1, adm2, lat, lon, country }
  idx: 0,         // 当前看的是第几天前的壁纸，0 是今天

  // 锁定：存的是那张图本身，不是 idx。
  // idx 的含义是「今天往前数第几天」，过一天同一个 idx 就换图了，锁不住。
  locked: false,
  lockedShot: null,   // { raw, copyright, startdate }
  lockedDay: "",      // 哪天锁的，解锁时判断要不要回到最新

  lastDay: ""         // 上次打开新标签页的日期，用来判断是不是新的一天
};

const $ = id => document.getElementById(id);
const bg = $("bg"), scrim = $("scrim"), panel = $("panel"), caption = $("caption");

let cfg = { ...DEFAULTS };
let current = null;   // 当前壁纸元数据
const MAX_IDX = 7;    // 必应接口最多回溯到 7 天前

// 天气缓存有效期。和风免费额度是每月 5 万次，
// 每开一次新标签页就打一次接口的话很容易顶上去。
const WEATHER_TTL = 15 * 60 * 1000;

/* ---------- 壁纸 ----------
   拉取和缓存在 shared.js 里，这里只管显示。 */

// 三个按钮的可用状态集中在这儿算，锁定时一律置灰。
function updateNav() {
  $("prevBtn").disabled  = cfg.locked || cfg.idx >= MAX_IDX;
  $("nextBtn").disabled  = cfg.locked || cfg.idx <= 0;
  $("todayBtn").disabled = cfg.locked || cfg.idx <= 0;
}

let paintSeq = 0;      // 每次 paint 加一，旧的加载回来了就扔掉
let bgBlobUrl = null;

// 解码完再换上去，4K 图不会出现半截卡住的一帧。
// ok() 在解码之后再问一遍，期间用户翻页了或者高清已经上了就作罢。
async function showBlob(blob, ok) {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
  if (!ok()) { URL.revokeObjectURL(url); return false; }
  bg.style.backgroundImage = `url("${url}")`;
  bg.classList.add("ready");
  const old = bgBlobUrl;
  bgBlobUrl = url;
  if (old) setTimeout(() => URL.revokeObjectURL(old), 1000);
  return true;
}

// cachedOnly：只用本地已有的图，没有就算了，不为它下载。
// 跨天时临时摆一下昨天那张用的，犯不上为一张马上要换掉的图耗流量。
async function paint(data, cachedOnly = false) {
  if (!data) return;
  current = data;
  const seq = ++paintSeq;
  const alive = () => seq === paintSeq;

  // copyright 形如「意大利托斯卡纳 (© Getty Images)」，只留前半段更干净
  $("capText").textContent = data.copyright.replace(/\s*\(©.*\)\s*$/, "");
  caption.hidden = !cfg.showCap;
  updateNav();

  const hi = withRes(data.raw, cfg.res, data.host);
  const lo = cfg.res === "uhd" ? withRes(data.raw, "1920x1080", data.host) : null;
  const cache = await openImgCache();

  // 1. 目标清晰度本地已经有了：直接用，基本是瞬开
  if (cache && await cache.match(hi)) {
    try {
      if (await showBlob(await getImage(hi, cache), alive)) return;
    } catch (e) { /* 缓存坏了，往下走重新下 */ }
  }
  if (!alive()) return;

  if (cachedOnly) {
    if (lo && cache && await cache.match(lo)) {
      try { await showBlob(await getImage(lo, cache), alive); } catch (e) {}
    }
    return;
  }

  // 2. 没有的话 1080P（几百 KB）和 4K 同时拉，1080P 先垫上，4K 到了再换。
  //    4K 偶尔比 JSON 晚几分钟才生成好，失败了就停在 1080P。
  let hiShown = false;
  const loP = lo ? getImage(lo, cache) : null;
  if (loP) {
    loP.then(b => showBlob(b, () => alive() && !hiShown)).catch(() => {});
  }

  try {
    const b = await getImage(hi, cache);
    hiShown = true;
    if (await showBlob(b, alive)) return;
  } catch (e) {
    hiShown = false;
  }
  if (!alive()) return;

  if (loP) {
    try {
      await showBlob(await loP, alive);
      return;
    } catch (e) { /* 落到下面报错 */ }
  }
  if (alive()) showError("壁纸下载失败，检查一下网络。");
}

function showError(msg) {
  bg.style.backgroundImage = "none";
  bg.classList.add("ready");
  $("capText").textContent = msg;
  caption.hidden = false;
}

let showSeq = 0;

// 等一段时间，或者等网络恢复，哪个先到算哪个
const waitNet = ms => new Promise(r => {
  const done = () => { clearTimeout(t); removeEventListener("online", done); r(); };
  const t = setTimeout(done, ms);
  addEventListener("online", done);
});

const RETRY_WAIT = [2000, 5000, 15000];   // 刚开机网络没就绪，给它几次机会

// 先画缓存、后台再核对（stale-while-revalidate）。
async function show(i) {
  cfg.idx = Math.min(MAX_IDX, Math.max(0, i));
  persist();
  const seq = ++showSeq;
  const idx = cfg.idx;
  const alive = () => seq === showSeq;

  const c = await readDay(idx);
  const sameDay = !!(c && c.day === todayStr());
  // 旧图当天有缓存就不用再问；今天那张过了 TTL 要后台再核对一次
  const fresh = sameDay && (idx > 0 || Date.now() - (c.at || 0) < TODAY_TTL);

  if (sameDay) paint(c.data);
  if (fresh) return;

  // 跨天第一次打开：今天的记录还没有。
  // 等一小会儿，新图还没出来就先摆上次那张（只用缓存），别让页面干黑着。
  let staleTimer = null;
  if (!sameDay && c && c.data) {
    staleTimer = setTimeout(() => {
      if (alive() && !current) paint(c.data, true);
    }, 1200);
  }

  for (let attempt = 0; ; attempt++) {
    try {
      // 后台 1 分钟内刚拉过就直接用它的结果
      const data = await pullDay(idx, 60 * 1000);
      clearTimeout(staleTimer);
      if (!alive() || cfg.locked) return;               // 已经翻走或锁上了
      if (!sameDay || data.raw !== c.data.raw) paint(data);  // 图真变了才重画
      return;
    } catch (e) {
      if (!alive() || sameDay) return;                  // 已经画了缓存，不打扰
      if (attempt === 0) {
        clearTimeout(staleTimer);
        // 跨天的旧值日期可能对不上，但总比白屏强
        if (c && c.data) { if (!current) paint(c.data); }
        else showError(`拿不到必应壁纸：${e.message}`);
      }
      if (attempt >= RETRY_WAIT.length) return;
      await waitNet(RETRY_WAIT[attempt]);
      if (!alive() || cfg.locked) return;
    }
  }
}

/* ---------- 锁定 ---------- */

async function setLock(on) {
  // 还没成功加载出图就没得锁
  if (on && !current) { $("lockChk").checked = false; return; }

  cfg.locked = on;
  if (on) {
    cfg.lockedShot = { ...current };
    cfg.lockedDay = todayStr();
  } else {
    cfg.lockedShot = null;
  }
  await persist();
  updateNav();

  // 解锁：还是锁定当天就留在原来那天，跨天了就回最新
  if (!on) show(cfg.lockedDay === todayStr() ? cfg.idx : 0);
}

/* ---------- 天气 ---------- */

// 和风的 icon 是三位数字代码，这里只做粗分类，够看了。
function weatherEmoji(code) {
  const n = parseInt(code, 10);
  if (n === 100 || n === 150) return "☀️";
  if (n <= 103 || n === 153) return "⛅";
  if (n === 104) return "☁️";
  if (n >= 300 && n <= 399) return "🌧️";
  if (n >= 400 && n <= 499) return "🌨️";
  if (n >= 500 && n <= 515) return "🌫️";
  return "🌥️";
}

async function loadWeather(force) {
  const el = $("weather");
  if (!WEATHER.host || !WEATHER.key) { el.hidden = true; return; }

  const ck = `weather_${cfg.cityId}`;
  const cached = (await load(ck))[ck];

  // 先把上次的值填上，页面不会空着闪一下
  if (cached && cached.now) paintWeather(cached.now);

  // 还在有效期内就到此为止，不碰接口。
  // 换城市时传 force，那种情况必须立刻拿新的。
  if (!force && cached && Date.now() - (cached.at || 0) < WEATHER_TTL) return;

  // 过期了才真去拉一遍，拿到再覆盖
  try {
    const url = `https://${WEATHER.host}/v7/weather/now?location=${cfg.cityId}&key=${WEATHER.key}`;
    const res = await fetch(url);
    const json = await res.json();
    if (json.code !== "200") throw new Error(`和风返回 code=${json.code}`);
    await save({ [ck]: { at: Date.now(), now: json.now } });
    paintWeather(json.now);
  } catch (e) {
    // 天气挂了不该影响壁纸；有旧值就留着旧值，没有就藏起来
    console.warn("天气获取失败：", e.message);
    if (!cached) el.hidden = true;
  }
}

// MSN 天气的 loc 参数是一段 base64 过的 JSON，字段和风都给了。
// btoa 不吃非 ASCII，得先转成 UTF-8 字节再编。
function msnWeatherUrl() {
  const g = cfg.cityGeo;
  if (!g || !g.lat || !g.lon) {
    // 没存过坐标（比如还没在设置里选过城市），退回搜索页
    return "https://www.msn.cn/zh-cn/weather/forecast/" +
           `?q=${encodeURIComponent(cfg.cityName)}`;
  }
  const payload = {
    l: cfg.cityName, r: g.adm1, r2: g.adm2,
    c: g.country, i: "CN", g: "zh-cn",
    x: String(g.lon), y: String(g.lat)
  };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const b64 = btoa(String.fromCharCode(...bytes));
  const path = encodeURIComponent(`in-${g.adm1},${g.adm2}`);
  return `https://www.msn.cn/zh-cn/weather/forecast/${path}` +
         `?loc=${encodeURIComponent(b64)}&weadegreetype=C`;
}

function paintWeather(now) {
  const el = $("weather");
  el.textContent = `${cfg.cityName}  ${weatherEmoji(now.icon)} ${now.temp}℃`;

  // 接口一次返回一堆字段，悬停正好是摊开它们的地方。
  // 字段有可能缺，一个个判断，别拼出「湿度 undefined%」。
  let head = `${cfg.cityName}　${now.text}　${now.temp}℃`;
  if (now.feelsLike && now.feelsLike !== now.temp) head += `（体感 ${now.feelsLike}℃）`;

  const detail = [];
  if (now.humidity) detail.push(`湿度 ${now.humidity}%`);
  if (now.windDir) detail.push(`${now.windDir} ${now.windScale || "?"} 级`);
  if (now.vis) detail.push(`能见度 ${now.vis} 公里`);

  // obsTime 形如 2026-09-02T14:20+08:00，只要中间那段时分
  const t = (now.obsTime || "").slice(11, 16);

  $("wxTipMain").textContent = head;
  $("wxTipSub").textContent = detail.join("　");
  $("wxTipFoot").textContent = `${t ? t + " 观测　" : ""}点击查看 MSN 天气详情`;
  $("wxTip").dataset.ready = "1";

  // 读屏和键盘用户看不到浮层，给个等价的文本
  el.setAttribute("aria-label", `${head}。${detail.join("，")}`);
  el.hidden = false;
}

// 原生 title 要悬停一秒才出来，样式也改不了，所以自己做一个。
// 用 hidden 控制存在、用 class 控制淡入，中间隔一帧才能触发过渡。
let tipTimer;

function showTip() {
  const tip = $("wxTip");
  if (!tip.dataset.ready || !panel.hidden) return;
  clearTimeout(tipTimer);
  tip.hidden = false;
  requestAnimationFrame(() => tip.classList.add("show"));
}

function hideTip() {
  const tip = $("wxTip");
  tip.classList.remove("show");
  clearTimeout(tipTimer);
  tipTimer = setTimeout(() => { tip.hidden = true; }, 200);
}

// 城市搜索。专属 host 上的路径是 /geo/v2/...，
// 老账号可能还在用公共的 geoapi.qweather.com，所以两个都试一遍。
async function lookupCity(kw) {
  const paths = [
    `https://${WEATHER.host}/geo/v2/city/lookup`,
    `https://geoapi.qweather.com/v2/city/lookup`
  ];
  for (const p of paths) {
    try {
      const res = await fetch(`${p}?location=${encodeURIComponent(kw)}&number=8&key=${WEATHER.key}`);
      const json = await res.json();
      if (json.code === "200" && json.location && json.location.length) return json.location;
    } catch (e) { /* 换下一个 */ }
  }
  return [];
}

function renderCityResults(list) {
  const box = $("cityResults");
  box.innerHTML = "";
  if (!list.length) {
    box.innerHTML = `<div class="empty">没找到，换个关键词试试</div>`;
    return;
  }
  for (const c of list) {
    const b = document.createElement("button");
    b.type = "button";
    // adm2 是地级市，adm1 是省，拼起来才分得清同名的地方
    b.innerHTML = `<strong>${c.name}</strong><span>${c.adm2} · ${c.adm1}</span>`;
    b.addEventListener("click", async () => {
      cfg.cityId = c.id;
      cfg.cityName = c.name;
      cfg.cityGeo = {
        adm1: c.adm1, adm2: c.adm2,
        lat: c.lat, lon: c.lon,
        country: c.country || "中华人民共和国"
      };
      await persist();
      box.innerHTML = "";
      $("cityInput").value = "";
      $("cityNow").textContent = `${c.name}（${c.adm2}）`;
      loadWeather(true);
    });
    box.appendChild(b);
  }
}

/* ---------- 外观 ---------- */

function applyLook() {
  scrim.style.background = `rgba(0,0,0,${cfg.dim / 100})`;
  bg.style.filter = cfg.blur ? `blur(${cfg.blur}px)` : "none";
  bg.style.transform = cfg.blur ? "scale(1.04)" : "none";  // 遮住模糊后的白边
  $("dimVal").textContent = cfg.dim + "%";
  $("blurVal").textContent = cfg.blur + "px";
  caption.hidden = !cfg.showCap;
}

const persist = () => save({ cfg });

/* ---------- 搜索 ---------- */

$("searchForm").addEventListener("submit", e => {
  e.preventDefault();
  const q = $("q").value.trim();
  if (q) location.href = ENGINES[cfg.engine].url + encodeURIComponent(q);
});

/* ---------- 设置面板 ---------- */

$("gearBtn").addEventListener("click", () => {
  panel.hidden = !panel.hidden;
  if (!panel.hidden) hideTip();   // 面板和浮层位置重叠，开一个就收另一个
});
$("closeBtn").addEventListener("click", () => { panel.hidden = true; $("q").focus(); });

document.addEventListener("keydown", e => {
  if (e.key === "Escape" && !panel.hidden) { panel.hidden = true; $("q").focus(); }
});

$("resSel").addEventListener("change", e => { cfg.res = e.target.value; persist(); paint(current); });
$("dimRange").addEventListener("input", e => { cfg.dim = +e.target.value; applyLook(); persist(); });
$("blurRange").addEventListener("input", e => { cfg.blur = +e.target.value; applyLook(); persist(); });
$("capChk").addEventListener("change", e => { cfg.showCap = e.target.checked; applyLook(); persist(); });
$("lockChk").addEventListener("change", e => setLock(e.target.checked));

// idx 越大 = 越早。往前是 +1，往后是 -1。
$("prevBtn").addEventListener("click", () => show(cfg.idx + 1));
$("nextBtn").addEventListener("click", () => show(cfg.idx - 1));
$("todayBtn").addEventListener("click", () => show(0));

$("weather").addEventListener("mouseenter", showTip);
$("weather").addEventListener("mouseleave", hideTip);

// 天气是个附带的小组件，别把整个新标签页顶掉。
// 加 noopener，免得目标页拿到 window.opener。
$("weather").addEventListener("click", () => {
  hideTip();
  window.open(msnWeatherUrl(), "_blank", "noopener");
});

let cityTimer;
$("cityInput").addEventListener("input", e => {
  const kw = e.target.value.trim();
  clearTimeout(cityTimer);
  if (kw.length < 2) { $("cityResults").innerHTML = ""; return; }
  // 防抖，别每敲一个字就打一次接口
  cityTimer = setTimeout(async () => renderCityResults(await lookupCity(kw)), 350);
});

$("dlBtn").addEventListener("click", () => {
  if (current) window.open(withRes(current.raw, cfg.res, current.host), "_blank");
});

/* ---------- 启动 ---------- */

(async () => {
  const stored = (await load("cfg")).cfg;
  cfg = { ...DEFAULTS, ...(stored || {}) };

  // 存的引擎万一被删掉了，退回默认，别在提交搜索时炸
  if (!ENGINES[cfg.engine]) cfg.engine = DEFAULTS.engine;

  $("resSel").value = cfg.res;
  $("dimRange").value = cfg.dim;
  $("blurRange").value = cfg.blur;
  $("capChk").checked = cfg.showCap;
  $("lockChk").checked = cfg.locked;

  $("cityNow").textContent = cfg.cityName;
  if (!WEATHER.host || !WEATHER.key) {
    $("cityInput").disabled = true;
    $("cityInput").placeholder = "先在 config.js 里填 host 和 key";
  }

  applyLook();

  const day = todayStr();
  if (cfg.locked && cfg.lockedShot) {
    // 锁着就直接画存下来的那张，不碰必应接口，也不管今天是哪天
    paint(cfg.lockedShot);
  } else {
    // 新的一天打开，不管昨天翻到了哪张，都回到最新
    if (cfg.lastDay !== day) cfg.idx = 0;
    show(cfg.idx);
  }
  cfg.lastDay = day;
  persist();

  loadWeather();
  $("q").focus();
})();
