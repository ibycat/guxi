// 预生成快照：由 GitHub Actions 定时运行，把东财数据抓下来算好，写成静态 JSON。
//
// 为什么不放在 Cloudflare 侧跑：
//   1. Pages Functions 没有 Cron Trigger；要 Cron 就得再建一个 Worker + KV 绑定
//   2. 更关键的是，东财对 Cloudflare 出口 IP 有风控，抓多了直接 502；
//      GitHub Runner 的出口 IP 完全不同，天然避开这个问题
//
// 产物：a.json、hk.json，推到独立的 data 分支，页面用 raw.githubusercontent 直读。
// 不提交到 main：Pages 免费版每月只有 500 次构建，半小时一次会打爆配额。
//
// 抓取策略：push2 对并发极其敏感（4 并发就能让大部分页失败），
// 所以行情用低并发 + 5 个镜像轮换 + 缺页串行补拉，并做完整性校验。

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// 本地调试用：Node 的 fetch 不读系统代理，机器在内网时需要走 curl。
// GitHub Actions 上不设这个变量，直接走 fetch。
const USE_CURL = !!process.env.SNAPSHOT_USE_CURL;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// 镜像池：push2 对同一出口 IP 的限流是按域名各自计的，
// 多挂几个编号镜像能明显降低「整页拿不到」的概率。
// 实测 GitHub Runner 连续请求时，5 个镜像会在几分钟内一起被限，
// 扩到 10 个后单页失败率下降明显。
const PUSH2_HOSTS = [
  "push2.eastmoney.com",
  "1.push2.eastmoney.com",
  "7.push2.eastmoney.com",
  "17.push2.eastmoney.com",
  "23.push2.eastmoney.com",
  "33.push2.eastmoney.com",
  "47.push2.eastmoney.com",
  "63.push2.eastmoney.com",
  "82.push2.eastmoney.com",
  "push2delay.eastmoney.com"
];

// GitHub Runner 在境外，直连东财经常吃 302 / 限流，只能退回腾讯兜底（价格能更，
// 分红数据更新不了）。设了 SNAPSHOT_PROXY 就改走本站 /api/em 的边缘代理：
// 请求由 Cloudflare 边缘发出，出口不是 Runner 的 IP；代理失败再退回直连，本地照常能用。
const PROXY = (process.env.SNAPSHOT_PROXY || "").trim().replace(/[?&]+$/, "");
const PROXY_HOSTS = new Set([
  "push2.eastmoney.com",
  "datacenter-web.eastmoney.com",
  "datacenter.eastmoney.com"
]);
function proxyUrl(u) {
  if (!PROXY) return null;
  let host;
  try { host = new URL(u).host; } catch (e) { return null; }
  if (!PROXY_HOSTS.has(host)) return null; // 编号镜像不在代理白名单里，走直连
  return PROXY + (PROXY.indexOf("?") >= 0 ? "&" : "?") + "u=" + encodeURIComponent(u);
}
// 有代理时只用主域名：编号镜像是为了绕开「同 IP 按域名限流」，代理出口本来就不是 Runner
const ACTIVE_HOSTS = PROXY ? ["push2.eastmoney.com"] : PUSH2_HOSTS;

const PATH_CLIST = "/api/qt/clist/get";
const DATACENTER = "https://datacenter-web.eastmoney.com/api/data/v1/get";
const HK_DIV = "https://datacenter.eastmoney.com/securities/api/data/v1/get";

const HISTORY_YEARS = 6;
const DAY = 86400000;
const NOW = new Date();
const TODAY = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate());

const FS_A = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23";
const FS_A_FIELDS = "f2,f3,f18,f9,f12,f14,f20,f23,f26,f100,f124";
const FS_HK_GGT = "b:DLMK0146";
const FS_HK_FIELDS = "f2,f3,f18,f9,f12,f14,f20,f23,f100,f124";

// 港股派息币种很杂：实测 665 只港股通里，265 只只用人民币派息、28 只只用美元。
// 只算港币会把近一半标的判成「无分红」，所以在原始记录上折算成港币再计算。
// 代码固定汇率，仅用于横向比较，不构成汇率报价。
const CCY_RATE = { "港币": 1, "人民币": 1.08, "美元": 7.78, "新加坡元": 5.8, "澳元": 5.1 };

const CYCLE = new Set([
  // 东财把钢铁拆成了 普钢/特钢/冶钢原料，写「钢铁」永远匹配不到，
  // 钢铁股就既不出「周期高位」标记，也进不了「周期高息」预设
  "煤炭开采", "航运港口", "炼化及贸易", "化学制品", "化学原料",
  "普钢", "特钢", "冶钢原料",
  "工业金属", "小金属", "贵金属", "证券", "房地产开发", "水泥", "玻璃玻纤",
  "农化制品", "油服工程", "燃气", "渔业", "种植业"
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 全局截止时间：行情抓取最坏情况是「每页都重试到最后一个镜像」，
// 加起来能把整轮拖过 25 分钟的 job 超时（实测已出现过 15 分钟的慢轮）。
// 到点后所有请求立刻失败，让上层按「已拿到的部分」继续算，
// 完整度不够时由工作流回填上一份快照。
const DEADLINE = Date.now() + 14 * 60 * 1000;

async function rawGet(url) {
  if (Date.now() > DEADLINE) throw new Error("deadline_exceeded");
  const p = proxyUrl(url);
  if (!p) return rawGetOnce(url);
  try {
    return await rawGetOnce(p);
  } catch (e) {
    // 代理挂了不代表源站也挂，退回直连再试一次
    return rawGetOnce(url);
  }
}

async function rawGetOnce(url) {
  if (USE_CURL) {
    const { stdout } = await execFileP(
      "curl",
      ["-sS", "--retry", "2", "--retry-all-errors", "--max-time", "25",
       "-A", UA, "-H", "referer: https://quote.eastmoney.com/", url],
      { maxBuffer: 128 * 1024 * 1024, encoding: "utf8" }
    );
    return stdout || "";
  }
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "*/*", referer: "https://quote.eastmoney.com/" },
    // 20s 太长：3 次重试 × 5 个镜像，单页最坏能拖到 5 分钟，整轮就会撞上 25 分钟的 job 超时
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error("http_" + res.status);
  return res.text();
}

async function getText(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const text = await rawGet(url);
      const head = text.replace(/^\uFEFF/, "").trim().charAt(0);
      if (head !== "{" && head !== "[") throw new Error("html_response");
      return text;
    } catch (e) {
      last = e;
      if (i + 1 < tries) await sleep(300 + i * 400 + Math.random() * 300);
    }
  }
  throw last;
}

// 镜像轮换：任一域名成功就记住它，下次优先用。
// budgetMs 是单次调用的总预算 —— 没有它的话，10 个镜像 × 2 次重试 × 15 秒超时
// 最坏能挂 5 分钟，而东财对整个出口 IP 封禁时，这 5 分钟一定是白等。
let hostCursor = 0;
let IP_BLOCKED = false;
async function getRotating(buildUrl, triesPerHost = 2, budgetMs = 30000) {
  const start = Date.now();
  let last;
  for (let i = 0; i < ACTIVE_HOSTS.length; i++) {
    if (Date.now() - start > budgetMs) break;
    const idx = (hostCursor + i) % ACTIVE_HOSTS.length;
    try {
      const text = await getText(buildUrl(ACTIVE_HOSTS[idx]), triesPerHost);
      hostCursor = idx;
      return text;
    } catch (e) {
      last = e;
    }
  }
  throw last || new Error("all_mirrors_failed");
}

function diffOf(text) {
  try {
    const d = JSON.parse(text).data.diff;
    if (!d) return [];
    return Array.isArray(d) ? d : Object.values(d);
  } catch (e) {
    return [];
  }
}

// 拉一个 clist 列表：先拿首页确定总页数，再低并发拉其余页，最后串行补缺
async function pullClist(fsCode, fields, po) {
  // 已经确认出口 IP 被整体封禁时，后面所有板块直接跳过，别再一组组试
  if (IP_BLOCKED) throw new Error("ip_blocked");

  const q = (pn) =>
    `${PATH_CLIST}?po=${po}&np=1&fltt=2&invt=2&fid=f12&fs=${fsCode}&fields=${fields}&pz=100&pn=${pn}`;

  let first = null;
  // 首页只试 2 轮、每轮给 40 秒预算：首页都拿不到，说明是这个 IP 被封，
  // 不是个别页抖动，多试只是把整轮耗到 job 超时
  for (let attempt = 0; attempt < 2 && !first; attempt++) {
    if (attempt) await sleep(8000);
    try {
      first = await getRotating((h) => `https://${h}${q(1)}`, 1, 40000);
    } catch (e) {
      console.log(`  首页获取失败（第 ${attempt + 1} 次）：${e && e.message}`);
    }
  }
  if (!first) {
    IP_BLOCKED = true;
    throw new Error("首页拉取失败（出口 IP 疑似被限）");
  }
  const total = JSON.parse(first).data.total || 0;
  const pages = Math.max(1, Math.ceil(total / 100));
  const texts = new Array(pages).fill(null);
  texts[0] = first;

  let idx = 1;
  const CONC = 1; // push2 对并发极其敏感，串行最稳
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= pages) return;
      try {
        texts[i] = await getRotating((h) => `https://${h}${q(i + 1)}`, 2);
        // 页与页之间留点随机间隔，避免稳定打到限流阈值上
        await sleep(250 + Math.random() * 350);
      } catch (e) {
        texts[i] = null;
        // 整页十个镜像都失败，基本是被限流了，先退避再继续，别把后面的页也一起拖死
        await sleep(2500);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, pages - 1) }, () => worker()));

  // 首轮就大面积失败，说明不是个别页抖动，而是出口 IP 被整体拒绝（实测 502）。
  // 这时候再补拉三轮纯属空转 —— 上一轮就这样白等了 10 分钟，
  // 不如立刻失败，让工作流去走「重试一次」和「回填上一份快照」。
  const got0 = texts.filter((t, i) => i > 0 && t).length;
  const need0 = pages - 1;
  if (need0 > 4 && got0 < need0 * 0.4) {
    throw new Error(`行情接口整体拒绝：首轮只拿到 ${got0}/${need0} 页，疑似出口 IP 被限`);
  }

  for (let round = 1; round <= 3; round++) {
    const missing = [];
    for (let i = 1; i < pages; i++) if (!texts[i]) missing.push(i);
    if (!missing.length) break;
    console.log(`  第 ${round} 轮补拉：缺 ${missing.length} 页`);
    for (const i of missing) {
      try {
        await sleep(1200 * round + Math.random() * 800);
        // 每个镜像试 2 次：10 个镜像 × 2 次已经够多了，
        // 只试 1 次会让「单页偶发 502」直接变成永久丢页（实测港股从 668 掉到 600）
        texts[i] = await getRotating((h) => `https://${h}${q(i + 1)}`, 2);
      } catch (e) {
        /* 放弃该页，下一轮再试 */
      }
    }
  }

  const rows = [];
  let okPages = 0;
  for (const t of texts) {
    if (!t) continue;
    okPages++;
    rows.push(...diffOf(t));
  }
  return { total, pages, okPages, rows };
}

/* ------------------------------ A 股 ------------------------------ */

function buildPeriods() {
  const y = TODAY.getFullYear();
  const qs = ["12-31", "09-30", "06-30", "03-31"];
  const from = new Date(TODAY.getTime() - 548 * DAY);
  const ttm = [];
  for (let yy = y; yy >= y - 2; yy--) {
    for (const q of qs) {
      const p = yy + "-" + q;
      const d = new Date(p + "T00:00:00");
      if (d <= TODAY && d >= from) ttm.push(p);
    }
  }
  const hist = [];
  for (let k = 1; k <= HISTORY_YEARS; k++) hist.push(y - k + "-12-31");
  // 财年聚合（上年股息率 / 近3年均值 / 连分年数 / 近6年分红年数）必须拿到该财年的中期分红。
  // 原来只有「近 18 个月的季末 + 近 6 个年报」，2 年前的 06-30、09-30 完全取不到：
  // 焦点科技 2024 中期每 10 股派 5.5 元被漏掉，近 3 年均值从 4.16% 掉到 3.49%；
  // 诺德股份 2023-03-31 那笔也漏了，均值直接归零。
  const mid = [];
  for (let k = 1; k <= HISTORY_YEARS; k++) {
    mid.push(y - k + "-06-30", y - k + "-09-30");
    if (k <= 3) mid.push(y - k + "-03-31"); // 季报分红的窗口只需覆盖近 3 年
  }
  return Array.from(new Set(ttm.concat(hist, mid)));
}

async function fetchBonusPeriod(period) {
  const base =
    `${DATACENTER}?reportName=RPT_SHAREBONUS_DET` +
    `&columns=SECURITY_CODE,PRETAX_BONUS_RMB,EX_DIVIDEND_DATE,EQUITY_RECORD_DATE,REPORT_DATE,ASSIGN_PROGRESS,BASIC_EPS` +
    `&filter=${encodeURIComponent(`(REPORT_DATE='${period}')`)}` +
    `&pageSize=500&source=WEB&client=WEB&sortColumns=SECURITY_CODE&sortTypes=1`;
  const first = await getText(base + "&pageNumber=1");
  let res;
  try {
    res = JSON.parse(first).result;
  } catch (e) {
    return [];
  }
  if (!res || !res.data) return [];
  const out = res.data.slice();
  const pages = res.pages || 1;
  for (let p = 2; p <= pages; p++) {
    try {
      const r2 = JSON.parse(await getText(base + `&pageNumber=${p}`)).result;
      if (r2 && r2.data) out.push(...r2.data);
    } catch (e) {
      /* 丢一页不致命，分红记录冗余度高 */
    }
  }
  return out;
}

const num = (v, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};

async function buildA() {
  console.log("[A] 拉取行情…");
  // 一次查 4 个市场（深主板/创业板/沪主板/科创板）的合并语句在东财侧偏重，
  // 实测最容易吃 502；拆成 4 次单独的板块查询后成功率明显更高。
  const FS_PARTS = ["m:0+t:6", "m:0+t:80", "m:1+t:2", "m:1+t:23"];
  const merged = [];
  let totalSum = 0, pagesSum = 0, okPagesSum = 0;
  // 板块级缺失必须硬失败：以前失败的板块被 continue 掉，连 total 都不计入分母，
  // 于是「已抓/应有」恒为 100%，缺掉整个深主板也能判成功并发布。
  const failedBoards = [];
  for (const fsCode of FS_PARTS) {
    let part = null;
    for (const po of [0, 1]) {   // 升序被拒就换降序，参数组合不同有时能绕开
      try {
        part = await pullClist(fsCode, FS_A_FIELDS, po);
        break;
      } catch (e) {
        console.log(`  ${fsCode}(po=${po}): 失败 ${e && e.message}`);
      }
      await sleep(1200);
    }
    if (!part) { failedBoards.push(fsCode); continue; }
    if (part.rows.length < part.total * 0.9) {
      failedBoards.push(`${fsCode} 不完整 ${part.rows.length}/${part.total}`);
      continue;
    }
    try {
      merged.push(...part.rows);
      totalSum += part.total;
      pagesSum += part.pages;
      okPagesSum += part.okPages;
      console.log(`  ${fsCode}: ${part.rows.length}/${part.total}`);
    } catch (e) {
      failedBoards.push(`${fsCode} 合并失败`);
      console.log(`  ${fsCode}: 合并失败 ${e && e.message}`);
    }
    await sleep(1500);
  }
  if (failedBoards.length) {
    throw new Error(`板块缺失：${failedBoards.join(" / ")}，拒绝生成残缺快照（交给兜底并保留上一份）`);
  }
  const q = { rows: merged, total: totalSum, pages: pagesSum, okPages: okPagesSum };
  console.log(`[A] 行情 ${q.okPages}/${q.pages} 页，${q.rows.length}/${q.total} 只`);
  // 门槛从 60% 提到 90%：腾讯兜底是从上一份快照为基准的，
  // 一旦这里放行一份残缺数据（比如只有 2454 只），它就成了下一轮的基准，
  // 每轮只会更小 —— 实测已经发生过一次从 4516 掉到 2454。宁可判失败让兜底接手。
  if (q.rows.length < q.total * 0.9) {
    throw new Error(`行情不完整：${q.rows.length}/${q.total}（低于 90%，改用兜底并保留上一份）`);
  }
  const partialA = q.okPages < q.pages ? `${q.okPages}/${q.pages}` : "";

  console.log("[A] 拉取分红…");
  const recs = [];
  for (const p of buildPeriods()) {
    const rows = await fetchBonusPeriod(p);
    recs.push(...rows);
    console.log(`  ${p}: ${rows.length}`);
  }
  console.log(`[A] 分红到手 ${recs.length} 条`);

  // 分页是按 SECURITY_CODE 排序的，同一代码有多条记录时顺序不稳定，
  // 翻页有可能把同一条记录返回两次 —— 那会让该股股息率直接翻倍。先按关键字段去重。
  const seenRec = new Set();
  const deduped = [];
  for (const r of recs) {
    const key = [r.SECURITY_CODE, r.REPORT_DATE, r.PRETAX_BONUS_RMB, r.EX_DIVIDEND_DATE].join("|");
    if (seenRec.has(key)) continue;
    seenRec.add(key);
    deduped.push(r);
  }
  if (deduped.length !== recs.length) {
    console.log(`[A] 去重：${recs.length} → ${deduped.length} 条（分页重复 ${recs.length - deduped.length} 条）`);
  }

  const byCode = new Map();
  for (const r of deduped) {
    const code = r.SECURITY_CODE;
    if (!code) continue;
    const raw = num(r.PRETAX_BONUS_RMB, 0);
    const dps = raw > 0 ? raw / 10 : 0;
    if (!dps) continue;
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push({
      period: String(r.REPORT_DATE || "").slice(0, 10),
      dps,
      ex: String(r.EX_DIVIDEND_DATE || r.EQUITY_RECORD_DATE || "").slice(0, 10),
      eps: num(r.BASIC_EPS, 0),
      prog: r.ASSIGN_PROGRESS || ""
    });
  }

  const y0 = TODAY.getFullYear();
  const winFrom = new Date(TODAY.getTime() - 365 * DAY);
  let maxTs = 0;
  // 高股息样本留档：下次跑完能在 Actions 日志里直接看到「谁高、由几笔构成」，便于判断真假
  const hot = [];

  // 列式容器：字段聚在一起，gzip 比行式再省 20%
  const C = {
    code: [], name: [], px: [], chg: [], pe: [], pb: [], mc: [], ind: [], ld: [],
    t: [], l: [], a3: [], po: [], cs: [], ys: [], fl: []
  };

  // 行业名重复度很高，抽成字典按索引存，省下几十 KB
  const indList = [];
  const indIdx = new Map();
  const indId = (name) => {
    if (!indIdx.has(name)) { indIdx.set(name, indList.length); indList.push(name); }
    return indIdx.get(name);
  };

  for (const it of q.rows) {
    const code = it.f12;
    if (!code) continue;
    const qts = num(it.f124, 0);
    if (qts > maxTs) maxTs = qts;
    // 只取收盘价：f2 在收盘后即当日收盘，停牌时回退 f18（昨收）
    const price = num(it.f2, 0) || num(it.f18, 0);
    if (!(price > 0)) continue;
    const ind = String(it.f100 || "").replace(/[ⅠⅡⅢ]+$/, "");

    let listYm = 0;
    const ld = num(it.f26, 0);
    if (ld > 19000101) listYm = Math.floor(ld / 100);

    const all = byCode.get(code) || [];
    const impl = all.filter((x) => x.prog.includes("实施"));

    // TTM：按除息日滚动 12 个月，钱真正到账才算
    let ttmSum = 0, ttmCnt = 0, annualInWin = 0;
    for (const x of impl) {
      const d = x.ex ? new Date(x.ex + "T00:00:00") : null;
      if (d && !isNaN(d) && d >= winFrom && d <= TODAY) {
        ttmSum += x.dps;
        ttmCnt++;
        if (x.period.slice(5) === "12-31") annualInWin++;
      }
    }
    const ttm = ttmSum / price;

    // 按财年归集：REPORT_DATE 的年份就是这笔分红所属财年。
    // 中期/季度分红必须并进该财年，否则「上年股息率」「分红率」会系统性低估近一半 ——
    // 工行 FY2025 = 中期 1.414 + 年报 1.689 = 3.103 元/10股，
    // 只取年报会得到 1.86%，真实 3.41%；分红率 16.9% vs 真实 31.0%。
    const fy = new Map();
    for (const x of impl) {
      const d = x.ex ? new Date(x.ex + "T00:00:00") : null;
      if (!d || isNaN(d) || d > TODAY) continue; // 尚未实施的不计入
      const yr = +x.period.slice(0, 4);
      if (!yr) continue;
      const cur = fy.get(yr) || { dps: 0, eps: 0, hasAnnual: false };
      cur.dps += x.dps;
      if (x.period.slice(5) === "12-31") {
        cur.hasAnnual = true;
        if (x.eps > 0) cur.eps = x.eps; // 年报口径 EPS，用来算分红率
      }
      fy.set(yr, cur);
    }

    // 上年 = 上一个完整财年（y0-1）。拿不到就是 0，绝不回退到多年前的旧年报 ——
    // 万科最后一笔是 2022 年的 6.8 元，回退会算出 23.94% 的假高息。
    // 唯一例外：该财年年报已披露但除息日还没到（钱还没派），此时用再上一年。
    const lastYr = y0 - 1;
    const lastFY = fy.get(lastYr);
    const lateAnnual = all.some(
      (x) => x.period.slice(0, 4) === String(lastYr) && x.period.slice(5) === "12-31" && !impl.includes(x)
    );
    const useYr = !lastFY && lateAnnual ? lastYr - 1 : lastYr;
    const lastF = fy.get(useYr);
    const lastDps = lastF ? lastF.dps : 0;
    const last = lastDps / price;
    // 分红率 = 同一财年的合计派息 ÷ 该财年 EPS（不再是「单条年报 ÷ 年报 EPS」）
    const payout = lastF && lastF.eps > 0 ? lastDps / lastF.eps : null;

    // 连分年数 / 有分红年数：按财年判断，不再按「年报条数」
    let consec = 0;
    for (let yy = useYr; yy >= useYr - HISTORY_YEARS - 1; yy--) {
      const f = fy.get(yy);
      if (!f || f.dps <= 0) break;
      consec++;
    }
    let years = 0;
    for (let k = 1; k <= HISTORY_YEARS; k++) {
      const f = fy.get(y0 - k);
      if (f && f.dps > 0) years++;
    }

    // 近 3 年均值：三个财年合计派息的算术平均 ÷ 现价
    let sum3 = 0, n3 = 0;
    for (let t = 1; t <= 3; t++) {
      const f = fy.get(y0 - t);
      if (f && f.dps > 0) { sum3 += f.dps; n3++; }
    }
    const avg3 = n3 ? sum3 / n3 / price : 0;

    const flags = [];
    // 只看 TTM 会误标：除息日刚好滑出 12 个月窗口、但上年确实派了钱的股票，
    // 会出现「上年股息率 18%」配「无分红」标签的自相矛盾（硕世生物就是这样）
    if (ttm <= 0 && last <= 0) flags.push("none:无分红");
    if (ttm > 0 && consec <= 1) flags.push("warn:分红不连续");
    // 分红率超过 150% 的三种成因完全不同，不能一律叫「异常」：
    //   1) 亏损年（动态 PE<=0）：EPS 为负，分红率本身没有意义 —— 大亚圣象 EPS 0.02
    //   2) EPS 口径失真：源站年报 EPS 明显低于市场隐含（price/PE）—— 厦门国贸派 11 元
    //      对 EPS 报出 1100%，实际是那份 EPS 只覆盖了部分期间
    //   3) 真高派息：EPS 对得上，就是派得多 —— 五粮液 224%、华兰生物 194%
    const peNow = num(it.f9, NaN);
    const epsMkt = peNow > 0 && price > 0 ? price / peNow : null;
    if (payout != null && payout > 1.5) {
      if (!Number.isFinite(peNow)) flags.push("warn:分红率异常");        // 没有 PE，退回通用标签
      else if (peNow <= 0) flags.push("warn:亏损派息");
      else if (epsMkt > 0 && lastF.eps < epsMkt * 0.6) flags.push("warn:EPS口径存疑");
      else flags.push("warn:分红率异常");
    } else if (payout != null && payout > 0.9) {
      flags.push("warn:分红率>90%");
    }
    if (ttm > 0.08 && CYCLE.has(ind)) flags.push("warn:周期高位");
    if (ttm > 0.1) flags.push("bad:需核验");
    if (annualInWin >= 2) flags.push("info:含2次年报");
    // 一年派三次以上通常是特别分红/资产处置，不可持续，必须显式标出来
    // （典型例子：荣晟环保一年三笔合计 2.08 元/股，股息率被顶到 19.5%）
    if (ttmCnt >= 3) flags.push("info:一年3笔以上");
    if (ttm >= 0.03 && consec >= 5 && payout != null && payout >= 0.2 && payout <= 0.75)
      flags.push("good:稳健");

    // 剔除的是「近 6 年一笔都没派过」的噪音，而不是「最近停了」的公司：
    // 万科最后一笔是 2022 财年，它该以 0% 留在榜里能被搜到，不该整行消失。
    if (ttm <= 0 && last <= 0 && years <= 0) continue;

    if (ttm > 0.15) {
      hot.push({
        code, name: it.f14 || code, y: ttm, n: ttmCnt, px: price, sum: ttmSum,
        detail: impl
          .filter((x) => {
            const d = x.ex ? new Date(x.ex + "T00:00:00") : null;
            return d && !isNaN(d) && d >= winFrom && d <= TODAY;
          })
          .map((x) => `${x.period}派${x.dps.toFixed(3)}除${x.ex}`)
          .join(" + ")
      });
    }

    // 列式编码：相同字段聚在一起，gzip 比行式再省 20%。
    // 收盘快照里的涨跌幅/PE/PB 就是当日定格的收盘数据，不存在「滞后误导」，全部保留。
    C.code.push(code);
    C.name.push(it.f14 || code);
    C.px.push(Math.round(price * 100) / 100);
    const chgV = num(it.f3, NaN);
    C.chg.push(Number.isFinite(chgV) ? Math.round(chgV * 100) / 100 : null);
    const peV = num(it.f9, NaN);
    C.pe.push(Number.isFinite(peV) ? Math.round(peV * 10) / 10 : null);
    const pbV = num(it.f23, NaN);
    C.pb.push(Number.isFinite(pbV) ? Math.round(pbV * 100) / 100 : null);
    C.mc.push(Math.round(num(it.f20, 0) / 1e8));
    C.ind.push(indId(ind));
    C.ld.push(listYm);
    C.t.push(Math.round(ttm * 1e4));
    C.l.push(Math.round(last * 1e4));
    C.a3.push(Math.round(avg3 * 1e4));
    C.po.push(payout == null ? -1 : Math.round(payout * 1e4));
    C.cs.push(consec);
    C.ys.push(years);
    // 行内多个标记用 "~" 连接。这里千万不能用 "|"：
    // 列与列之间也是用 "|" 拼的（见下方 fl: C.fl.join("|")），
    // 混用会让第一只带多标记的股票之后整列错位 —— 实测 4516 只的 fl 被拆成了 4749 段，
    // 导致贵州茅台这类股票的「稳健」标记被挪到别人身上，默认筛选里直接看不到。
    C.fl.push(flags.join("~"));
  }

  // 高股息样本留档：打印出来便于人工判断是真高息还是数据问题
  if (hot.length) {
    hot.sort((a, b) => b.y - a.y);
    console.log(`[A] 股息率 > 15% 共 ${hot.length} 只，前 8 只：`);
    for (const h of hot.slice(0, 8)) {
      console.log(`  ${h.code} ${h.name} ${(h.y * 100).toFixed(1)}% 价${h.px.toFixed(2)} 近12月${h.n}笔 合计${h.sum.toFixed(3)}元 → ${h.detail}`);
    }
  }

  // f124 是行情时间(秒，东八区)，换算出这份快照对应的交易日
  const asof = maxTs > 0 ? new Date((maxTs + 8 * 3600) * 1000).toISOString().slice(0, 10) : null;

  if (!C.code.length) {
    // 一行都没拉到（通常是上游 502）时绝不能写出空文件，
    // 否则会把工作流「沿用上一次副本」的回填逻辑骗过去
    throw new Error("行情为空，放弃写入");
  }

  const pack = {
    v: 3, ts: Date.now(), market: "a", years: HISTORY_YEARS, asof,
    partial: partialA, inds: indList,
    code: C.code.join("|"),
    name: C.name.join("|"),
    px: C.px, chg: C.chg, pe: C.pe, pb: C.pb, mc: C.mc,
    ind: C.ind, ld: C.ld,
    t: C.t, l: C.l, a3: C.a3,
    po: C.po, cs: C.cs, ys: C.ys,
    fl: C.fl.join("|")
  };
  console.log(`[A] 计算完成 ${C.code.length} 行（已剔除从未分红），行业 ${indList.length} 个`);
  return pack;
}

/* ------------------------------ 港股 ------------------------------ */

const ymd = (d) => {
  const m = d.getMonth() + 1, dd = d.getDate();
  return `${d.getFullYear()}-${m < 10 ? "0" : ""}${m}-${dd < 10 ? "0" : ""}${dd}`;
};

function parseHKDps(text) {
  const m = /每股派\s*(港币|港元|人民币|美元|新加坡元|澳元)?\s*([0-9]+(?:\.[0-9]+)?)\s*元/.exec(text || "");
  if (!m) return null;
  let ccy = m[1] || "港币";
  if (ccy === "港元") ccy = "港币";
  const v = parseFloat(m[2]);
  if (!Number.isFinite(v) || v <= 0) return null;
  return { ccy, dps: v };
}

async function fetchHKDiv(from) {
  const base =
    `${HK_DIV}?reportName=RPT_HKF10_MAIN_DIVBASIC` +
    `&columns=SECURITY_CODE,REPORT_TYPE,EX_DIVIDEND_DATE,YEAR,PLAN_EXPLAIN` +
    `&filter=${encodeURIComponent(`(EX_DIVIDEND_DATE>="${from}")`)}` +
    `&pageSize=500&sortColumns=EX_DIVIDEND_DATE&sortTypes=-1&source=F10&client=PC`;
  const first = await getText(base + "&pageNumber=1");
  let res;
  try {
    res = JSON.parse(first).result;
  } catch (e) {
    return [];
  }
  if (!res || !res.data) return [];
  const out = res.data.slice();
  const pages = res.pages || 1;
  console.log(`[HK] 派息 ${pages} 页 / ${res.count} 条`);
  for (let p = 2; p <= pages; p++) {
    try {
      const r2 = JSON.parse(await getText(base + `&pageNumber=${p}`)).result;
      if (r2 && r2.data) out.push(...r2.data);
    } catch (e) {
      /* 丢一页会让部分股票少算股息率，但比整体失败好 */
    }
  }
  return out;
}

async function buildHK() {
  console.log("[HK] 拉取港股通行情…");
  const q = await pullClist(FS_HK_GGT, FS_HK_FIELDS, 1);
  console.log(`[HK] 行情 ${q.okPages}/${q.pages} 页，${q.rows.length}/${q.total} 只`);
  // 阈值与 A 股对齐到 90%：港股只有一个板块，60% 的放行线意味着 668 只掉到 400 只也算成功，
  // 而兜底是以上一份为基准的，一旦放行残缺数据，下一轮只会更小。
  if (q.rows.length < q.total * 0.9) {
    throw new Error(`行情严重缺失：${q.rows.length}/${q.total}（低于 90%，改用兜底并保留上一份）`);
  }
  const partialHK = q.okPages < q.pages ? `${q.okPages}/${q.pages}` : "";

  let hkMaxTs = 0;
  for (const it of q.rows) {
    const qts = num(it.f124, 0);
    if (qts > hkMaxTs) hkMaxTs = qts;
  }
  const hkAsof = hkMaxTs > 0 ? new Date((hkMaxTs + 8 * 3600) * 1000).toISOString().slice(0, 10) : null;

  const from = ymd(new Date(TODAY.getFullYear() - HISTORY_YEARS, 0, 1));
  const divs = await fetchHKDiv(from);

  const byCode = new Map();
  for (const r of divs) {
    const code = r.SECURITY_CODE;
    if (!code) continue;
    const p = parseHKDps(r.PLAN_EXPLAIN);
    if (!p) continue;
    const ex = String(r.EX_DIVIDEND_DATE || "").replace(/\//g, "-").slice(0, 10);
    const yr = num(r.YEAR, ex ? +ex.slice(0, 4) : 0);
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push({ ex, dps: p.dps, ccy: p.ccy, year: yr, type: r.REPORT_TYPE || "" });
  }

  const y0 = TODAY.getFullYear();
  const winFrom = new Date(TODAY.getTime() - 365 * DAY);
  const rows = [];

  for (const it of q.rows) {
    const c = it.f12;
    if (!/^0\d{4}$/.test(c || "")) continue;
    const price = num(it.f2, 0) || num(it.f18, 0);
    if (!(price > 0)) continue;

    // 同一笔分红会被分页接口返回两次（民生银行 2025 中期出现两条一模一样的记录），
    // 不去重会让 last 直接翻倍：11.40% vs 真实 6.63%
    const seenHk = new Set();
    const rr = [];
    for (const x of byCode.get(c) || []) {
      const k = [x.year, x.dps, x.ex, x.ccy, x.type].join("|");
      if (seenHk.has(k)) continue;
      seenHk.add(k);
      rr.push(x);
    }

    let ttmSum = 0, ttmCnt = 0, nonHkd = 0;
    const byYear = new Map();
    const byYearEx = new Map(); // 剔除特别分配，用于近 3 年均值
    for (const x of rr) {
      const rate = CCY_RATE[x.ccy];
      if (!rate) { nonHkd++; continue; }
      if (x.ccy !== "港币") nonHkd++;
      const hkd = x.dps * rate;
      const d = x.ex ? new Date(x.ex + "T00:00:00") : null;
      if (d && !isNaN(d) && d >= winFrom && d <= TODAY) { ttmSum += hkd; ttmCnt++; }
      if (x.year) {
        byYear.set(x.year, (byYear.get(x.year) || 0) + hkd);
        // 特别分配（如华晨中国 4.3 港币）是一次性的，混进均值会算出 252% 的「3 年均值」
        if (!String(x.type || "").includes("特别")) {
          byYearEx.set(x.year, (byYearEx.get(x.year) || 0) + hkd);
        }
      }
    }
    const ttm = ttmSum / price;

    // 只认上一个完整年度，不再回退到前年：
    // 01833 平安好医生唯一一笔是 2024 年特别分配，回退后「上年股息率」变成 193%，
    // 而它 2025 年其实一分未派
    const lastDps = byYear.get(y0 - 1) || 0;
    const last = lastDps / price;

    let consec = 0;
    for (let yy = y0 - 1; byYear.has(yy); yy--) consec++;
    let years = 0;
    for (let k = 1; k <= HISTORY_YEARS; k++) if (byYear.has(y0 - k)) years++;

    let sum3 = 0, n3 = 0;
    for (let t = 1; t <= 3; t++) {
      if (byYearEx.has(y0 - t)) { sum3 += byYearEx.get(y0 - t); n3++; }
    }
    const avg3 = n3 ? sum3 / n3 / price : 0;

    const flags = [];
    // 与 A 股同一口径：TTM 归零不等于没分过红（01833 就是上年 0、TTM 0 才算无分红）
    if (ttm <= 0 && last <= 0) flags.push("none:无分红");
    if (nonHkd > 0) flags.push("info:含非港币(已折算)");
    if (ttm > 0 && consec <= 1) flags.push("warn:分红不连续");
    if (ttm > 0.1) flags.push("bad:需核验");
    if (price < 1) flags.push("warn:低价股");
    if (ttm >= 0.04 && consec >= 5) flags.push("good:稳健");

    rows.push([
      c, it.f14 || c, price,
      num(it.f3, NaN), num(it.f9, NaN), num(it.f20, 0), String(it.f100 || ""),
      Math.round(ttm * 1e6), Math.round(last * 1e6), Math.round(avg3 * 1e6),
      consec, years, ttmCnt,
      flags.join("|"),
      rr.slice().sort((a, b) => b.ex.localeCompare(a.ex)).slice(0, 8)
        .map((x) => `${x.year},${x.dps},${x.ex},${x.ccy},${x.type}`).join(";"),
      // 追加在末尾，避免打乱已有下标
      Number.isFinite(num(it.f23, NaN)) ? Math.round(num(it.f23, 0) * 100) / 100 : null
    ]);
  }
  console.log(`[HK] 计算完成 ${rows.length} 行`);
  return { v: 2, ts: Date.now(), market: "hk", years: HISTORY_YEARS, asof: hkAsof, partial: partialHK, rows };
}

/* ------------------------------ 主流程 ------------------------------ */

async function main() {
  const outDir = path.join(process.cwd(), process.env.SNAPSHOT_DIR || "data");
  fs.mkdirSync(outDir, { recursive: true });

  const only = process.argv[2];
  // 港股放前面：它请求量小，先拿下；A 股 56 页跑完后同一个出口 IP 容易被限流
  const jobs = [];
  if (!only || only === "hk") jobs.push(["hk", buildHK]);
  if (!only || only === "a") jobs.push(["a", buildA]);

  let okCount = 0;
  for (const [name, fn] of jobs) {
    if (okCount > 0) await sleep(15000);
    try {
      const pack = await fn();
      const text = JSON.stringify(pack);
      fs.writeFileSync(path.join(outDir, name + ".json"), text);
      // 不再产出 .json.gz：/api/snap 返回的是 JSON 文本，压缩由 Cloudflare 边缘
      // 按 Accept-Encoding 自动完成。早期那份预压缩副本没有任何消费者，
      // 每个交易日还要往 data 分支塞 170KB 死重量。
      const n = pack.rows
        ? pack.rows.length
        : String(pack.code || "").split("|").filter(Boolean).length;
      console.log(
        `OK ${name}.json  ${(text.length / 1024).toFixed(0)}KB  ${n} 行`
      );
      okCount++;
    } catch (e) {
      // 单个市场失败不影响另一个；旧文件由工作流从上一次产物恢复
      console.error(`FAIL ${name}: ${e && e.message}`);
    }
  }

  if (okCount === 0) {
    console.error("两个市场都失败，退出");
    process.exit(1);
  }
}

main();
