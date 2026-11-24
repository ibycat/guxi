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

const PUSH2_HOSTS = [
  "push2.eastmoney.com",
  "82.push2.eastmoney.com",
  "1.push2.eastmoney.com",
  "17.push2.eastmoney.com",
  "push2delay.eastmoney.com"
];

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
  "煤炭开采", "航运港口", "炼化及贸易", "化学制品", "化学原料", "钢铁",
  "工业金属", "小金属", "贵金属", "证券", "房地产开发", "水泥", "玻璃玻纤",
  "农化制品", "油服工程", "燃气", "渔业", "种植业"
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rawGet(url) {
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
    signal: AbortSignal.timeout(20000)
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

// 镜像轮换：任一域名成功就记住它，下次优先用
let hostCursor = 0;
async function getRotating(buildUrl, triesPerHost = 2) {
  let last;
  for (let i = 0; i < PUSH2_HOSTS.length; i++) {
    const idx = (hostCursor + i) % PUSH2_HOSTS.length;
    try {
      const text = await getText(buildUrl(PUSH2_HOSTS[idx]), triesPerHost);
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
  const q = (pn) =>
    `${PATH_CLIST}?po=${po}&np=1&fltt=2&invt=2&fid=f12&fs=${fsCode}&fields=${fields}&pz=100&pn=${pn}`;

  let first = null;
  for (let attempt = 0; attempt < 3 && !first; attempt++) {
    if (attempt) await sleep(5000 * attempt);
    try {
      first = await getRotating((h) => `https://${h}${q(1)}`, 2);
    } catch (e) {
      console.log(`  首页获取失败（第 ${attempt + 1} 次）：${e && e.message}`);
    }
  }
  if (!first) throw new Error("首页拉取失败");
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
      } catch (e) {
        texts[i] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, pages - 1) }, () => worker()));

  for (let round = 1; round <= 2; round++) {
    const missing = [];
    for (let i = 1; i < pages; i++) if (!texts[i]) missing.push(i);
    if (!missing.length) break;
    console.log(`  第 ${round} 轮补拉：缺 ${missing.length} 页`);
    for (const i of missing) {
      try {
        await sleep(400 * round);
        texts[i] = await getRotating((h) => `https://${h}${q(i + 1)}`, 3);
      } catch (e) {
        /* 放弃该页 */
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
  return Array.from(new Set(ttm.concat(hist)));
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
    if (!part) continue;
    try {
      merged.push(...part.rows);
      totalSum += part.total;
      pagesSum += part.pages;
      okPagesSum += part.okPages;
      console.log(`  ${fsCode}: ${part.rows.length}/${part.total}`);
    } catch (e) {
      console.log(`  ${fsCode}: 合并失败 ${e && e.message}`);
    }
    await sleep(1500);
  }
  const q = { rows: merged, total: totalSum, pages: pagesSum, okPages: okPagesSum };
  console.log(`[A] 行情 ${q.okPages}/${q.pages} 页，${q.rows.length}/${q.total} 只`);
  if (q.rows.length < q.total * 0.6) {
    throw new Error(`行情严重缺失：${q.rows.length}/${q.total}`);
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

    const annuals = impl
      .filter((x) => x.period.slice(5) === "12-31")
      .sort((a, b) => b.period.localeCompare(a.period));

    const lastA = annuals.length ? annuals[0] : null;
    const last = lastA ? lastA.dps / price : 0;
    const payout = lastA && lastA.eps > 0 ? lastA.dps / lastA.eps : null;

    const yearSet = new Set(annuals.map((a) => +a.period.slice(0, 4)));
    let consec = 0;
    for (let yy = y0 - 1; yearSet.has(yy); yy--) consec++;
    let years = 0;
    for (let k = 1; k <= HISTORY_YEARS; k++) if (yearSet.has(y0 - k)) years++;

    let sum3 = 0, n3 = 0;
    for (let t = 1; t <= 3; t++) {
      const found = annuals.find((a) => +a.period.slice(0, 4) === y0 - t);
      if (found) { sum3 += found.dps; n3++; }
    }
    const avg3 = n3 ? sum3 / n3 / price : 0;

    const flags = [];
    if (ttm <= 0) flags.push("none:无分红");
    if (ttm > 0 && consec <= 1) flags.push("warn:分红不连续");
    if (payout != null && payout > 0.9) flags.push("warn:分红率>90%");
    if (ttm > 0.08 && CYCLE.has(ind)) flags.push("warn:周期高位");
    if (ttm > 0.1) flags.push("bad:需核验");
    if (annualInWin >= 2) flags.push("info:含2次年报");
    if (ttm >= 0.03 && consec >= 5 && payout != null && payout >= 0.2 && payout <= 0.75)
      flags.push("good:稳健");

    // 从未分红的标的在股息率榜单里就是一堆 0 值噪音，不进快照（省 15% 体积）
    if (ttm <= 0 && last <= 0 && consec <= 0) continue;

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
    C.fl.push(flags.join("|"));
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
  if (q.rows.length < q.total * 0.6) {
    throw new Error(`行情严重缺失：${q.rows.length}/${q.total}`);
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

    const rr = byCode.get(c) || [];
    let ttmSum = 0, ttmCnt = 0, nonHkd = 0;
    const byYear = new Map();
    for (const x of rr) {
      const rate = CCY_RATE[x.ccy];
      if (!rate) { nonHkd++; continue; }
      if (x.ccy !== "港币") nonHkd++;
      const hkd = x.dps * rate;
      const d = x.ex ? new Date(x.ex + "T00:00:00") : null;
      if (d && !isNaN(d) && d >= winFrom && d <= TODAY) { ttmSum += hkd; ttmCnt++; }
      if (x.year) byYear.set(x.year, (byYear.get(x.year) || 0) + hkd);
    }
    const ttm = ttmSum / price;

    let lastYr = null;
    for (let yy = y0 - 1; yy >= y0 - 2; yy--) {
      if (byYear.has(yy)) { lastYr = yy; break; }
    }
    const last = lastYr ? byYear.get(lastYr) / price : 0;

    let consec = 0;
    for (let yy = y0 - 1; byYear.has(yy); yy--) consec++;
    let years = 0;
    for (let k = 1; k <= HISTORY_YEARS; k++) if (byYear.has(y0 - k)) years++;

    let sum3 = 0, n3 = 0;
    for (let t = 1; t <= 3; t++) {
      if (byYear.has(y0 - t)) { sum3 += byYear.get(y0 - t); n3++; }
    }
    const avg3 = n3 ? sum3 / n3 / price : 0;

    const flags = [];
    if (ttm <= 0) flags.push("none:无分红");
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
      const n = pack.rows
        ? pack.rows.length
        : String(pack.code || "").split("|").filter(Boolean).length;
      console.log(`OK ${name}.json  ${(text.length / 1024).toFixed(0)}KB  ${n} 行`);
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
