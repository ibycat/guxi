// 预生成快照：由 GitHub Actions 定时运行，把东财数据抓下来算好，写成静态 JSON。
//
// 为什么不放在 Cloudflare 侧跑：
//   1. Pages Functions 没有 Cron Trigger；要 Cron 就得再建一个 Worker + KV 绑定
//   2. 更关键的是，东财对 Cloudflare 出口 IP 有风控，抓多了会直接 502；
//      GitHub Runner 的出口 IP 完全不同，天然避开这个问题
//
// 产物：data/a.json、data/hk.json，由 Pages 当静态文件直出（CDN + gzip），
// 页面首屏只读这一个文件，不再实时打东财。

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// 本地调试用：Node 的 fetch 不读系统代理，机器在内网时需要走 curl。
// GitHub Actions 上直接用 fetch，不设这个变量即可。
const USE_CURL = !!process.env.SNAPSHOT_USE_CURL;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// push2 有多个镜像，被限流时依次回退
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
const FS_A_FIELDS = "f2,f3,f5,f6,f8,f9,f12,f13,f14,f20,f21,f23,f26,f100";
const FS_HK_GGT = "b:DLMK0146";
const FS_HK_ALL = "m:128+t:1,m:128+t:2,m:128+t:3,m:128+t:4";
const FS_HK_FIELDS = "f2,f3,f9,f12,f14,f20,f100";

const CYCLE = new Set([
  "煤炭开采", "航运港口", "炼化及贸易", "化学制品", "化学原料", "钢铁",
  "工业金属", "小金属", "贵金属", "证券", "房地产开发", "水泥", "玻璃玻纤",
  "农化制品", "油服工程", "燃气", "渔业", "种植业"
]);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function rawGet(url) {
  if (USE_CURL) {
    const { stdout } = await execFileP(
      "curl",
      ["-sS", "--retry", "3", "--retry-all-errors", "--max-time", "25", "-A", UA, "-H", "referer: https://quote.eastmoney.com/", url],
      { maxBuffer: 128 * 1024 * 1024, encoding: "utf8" }
    );
    if (!stdout || stdout.charAt(0) === "{") return stdout;
    throw new Error("curl_empty");
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
      if (i + 1 < tries) await sleep(400 * (i + 1));
    }
  }
  throw last;
}

// 分页拉取：host 列表按顺序回退，每页也允许换 host 重试
async function pullPages(pathname, query, startPage, pageCount, concurrency) {
  const out = new Array(pageCount);
  let idx = 0;
  let hostIdx = 0;

  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= pageCount) return;
      const page = startPage + i;
      let ok = false;
      for (let attempt = 0; attempt < PUSH2_HOSTS.length && !ok; attempt++) {
        const host = PUSH2_HOSTS[(hostIdx + attempt) % PUSH2_HOSTS.length];
        const url = `https://${host}${pathname}?${query}&pn=${page}`;
        try {
          out[i] = await getText(url, 2);
          ok = true;
        } catch (e) {
          /* 换下一个镜像 */
        }
      }
      if (!ok) out[i] = null;
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, pageCount) }, () => worker())
  );
  return out;
}

function diffOf(text) {
  try {
    const j = JSON.parse(text);
    const d = j && j.data && j.data.diff;
    if (!d) return [];
    return Array.isArray(d) ? d : Object.values(d);
  } catch (e) {
    return [];
  }
}

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function isST(name) {
  return /ST|退|PT/i.test(name);
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

async function fetchBonusPeriod(period, fromOffset, pageSize) {
  const base =
    `${DATACENTER}?reportName=RPT_SHAREBONUS_DET` +
    `&columns=SECURITY_CODE,PRETAX_BONUS_RMB,EX_DIVIDEND_DATE,EQUITY_RECORD_DATE,REPORT_DATE,ASSIGN_PROGRESS,BASIC_EPS` +
    `&filter=${encodeURIComponent(`(REPORT_DATE='${period}')`)}` +
    `&pageSize=${pageSize}&source=WEB&client=WEB`;
  const first = await getText(base + "&pageNumber=1&sortColumns=SECURITY_CODE&sortTypes=1");
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
      const t = await getText(base + `&pageNumber=${p}&sortColumns=SECURITY_CODE&sortTypes=1`);
      const r2 = JSON.parse(t).result;
      if (r2 && r2.data) out.push(...r2.data);
    } catch (e) {
      /* 丢一页不致命 */
    }
  }
  return out;
}

async function buildA() {
  console.log("[A] 拉取行情…");
  const first = await getText(
    `https://${PUSH2_HOSTS[0]}${PATH_CLIST}?po=0&np=1&fltt=2&invt=2&fid=f12` +
      `&fs=${FS_A}&fields=${FS_A_FIELDS}&pn=1&pz=100`
  );
  const head = JSON.parse(first);
  const total = (head.data && head.data.total) || 0;
  const pages = Math.max(1, Math.ceil(total / 100));
  console.log(`[A] 行情 ${pages} 页 / ${total} 只`);
  const rest = await pullPages(PATH_CLIST, `po=0&np=1&fltt=2&invt=2&fid=f12&fs=${FS_A}&fields=${FS_A_FIELDS}&pz=100`, 2, pages - 1, 4);
  const quotes = diffOf(first);
  for (const t of rest) if (t) quotes.push(...diffOf(t));
  console.log(`[A] 行情到手 ${quotes.length} 条`);

  console.log("[A] 拉取分红…");
  const periods = buildPeriods();
  const recs = [];
  for (const p of periods) {
    const rows = await fetchBonusPeriod(p, 0, 500);
    recs.push(...rows);
    console.log(`  ${p}: ${rows.length}`);
  }
  console.log(`[A] 分红到手 ${recs.length} 条`);

  const byCode = new Map();
  for (const r of recs) {
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
  const rows = [];

  for (const it of quotes) {
    const code = it.f12;
    if (!code) continue;
    const price = num(it.f2, 0);
    if (!(price > 0)) continue;
    const name = it.f14 || code;
    const ind = String(it.f100 || "").replace(/[ⅠⅡⅢ]+$/, "");

    let listDate = 0;
    const ld = num(it.f26, 0);
    if (ld > 19000101) {
      listDate = new Date(Math.floor(ld / 10000), (Math.floor(ld / 100) % 100) - 1, 1).getTime();
    }

    const all = byCode.get(code) || [];
    const impl = all.filter((x) => x.prog.includes("实施"));

    let ttmSum = 0;
    let ttmCnt = 0;
    let annualInWin = 0;
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

    let sum3 = 0;
    let n3 = 0;
    for (let t = 1; t <= 3; t++) {
      const found = annuals.find((a) => +a.period.slice(0, 4) === y0 - t);
      if (found) {
        sum3 += found.dps;
        n3++;
      }
    }
    const avg3 = n3 ? sum3 / n3 / price : 0;

    const flags = [];
    if (ttm <= 0) flags.push("n:无分红");
    if (ttm > 0 && consec <= 1) flags.push("w:分红不连续");
    if (payout != null && payout > 0.9) flags.push("w:分红率>90%");
    if (ttm > 0.08 && CYCLE.has(ind)) flags.push("w:周期高位");
    if (ttm > 0.1) flags.push("b:需核验");
    if (annualInWin >= 2) flags.push("i:含2次年报");
    if (ttm >= 0.03 && consec >= 5 && payout != null && payout >= 0.2 && payout <= 0.75)
      flags.push("g:稳健");

    rows.push([
      code,
      name,
      price,
      num(it.f3, NaN),
      num(it.f9, NaN),
      num(it.f23, NaN),
      num(it.f20, 0),
      ind,
      listDate,
      Math.round(ttm * 1e6),
      Math.round(last * 1e6),
      Math.round(avg3 * 1e6),
      payout == null ? -1 : Math.round(payout * 1e4),
      consec,
      years,
      ttmCnt,
      flags.join("|"),
      all
        .slice()
        .sort((a, b) => b.period.localeCompare(a.period))
        .slice(0, 6)
        .map((x) => `${x.period},${x.dps},${x.ex},${x.prog}`)
        .join(";")
    ]);
  }
  console.log(`[A] 计算完成 ${rows.length} 行`);
  return { ts: Date.now(), market: "a", years: HISTORY_YEARS, rows };
}

/* ------------------------------ 港股 ------------------------------ */

function ymd(d) {
  const m = d.getMonth() + 1;
  const dd = d.getDate();
  return d.getFullYear() + "-" + (m < 10 ? "0" : "") + m + "-" + (dd < 10 ? "0" : "") + dd;
}

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
      const t = await getText(base + `&pageNumber=${p}`);
      const r2 = JSON.parse(t).result;
      if (r2 && r2.data) out.push(...r2.data);
    } catch (e) {
      /* 丢一页不致命 */
    }
  }
  return out;
}

async function buildHK() {
  console.log("[HK] 拉取港股通行情…");
  const qq = `po=1&np=1&fltt=2&invt=2&fid=f12&fs=${FS_HK_GGT}&fields=${FS_HK_FIELDS}&pz=100`;
  const first = await getText(`https://${PUSH2_HOSTS[0]}${PATH_CLIST}?${qq}&pn=1`);
  const total = JSON.parse(first).data.total || 0;
  const pages = Math.max(1, Math.ceil(total / 100));
  const rest = await pullPages(PATH_CLIST, qq, 2, pages - 1, 2);
  const quotes = diffOf(first);
  for (const t of rest) if (t) quotes.push(...diffOf(t));
  console.log(`[HK] 行情 ${quotes.length}/${total} 条`);

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

  for (const it of quotes) {
    const c = it.f12;
    if (!/^0\d{4}$/.test(c || "")) continue;
    const price = num(it.f2, 0);
    if (!(price > 0)) continue;
    const mcap = num(it.f20, 0);

    const rr = byCode.get(c) || [];
    let ttmSum = 0;
    let ttmCnt = 0;
    let nonHkd = 0;
    const byYear = new Map();
    for (const x of rr) {
      if (x.ccy !== "港币") {
        nonHkd++;
        continue;
      }
      const d = x.ex ? new Date(x.ex + "T00:00:00") : null;
      if (d && !isNaN(d) && d >= winFrom && d <= TODAY) {
        ttmSum += x.dps;
        ttmCnt++;
      }
      if (x.year) byYear.set(x.year, (byYear.get(x.year) || 0) + x.dps);
    }
    const ttm = ttmSum / price;

    let lastYr = null;
    for (let y = y0 - 1; y >= y0 - 2; y--) {
      if (byYear.has(y)) {
        lastYr = y;
        break;
      }
    }
    const last = lastYr ? byYear.get(lastYr) / price : 0;

    let consec = 0;
    for (let yy = y0 - 1; byYear.has(yy); yy--) consec++;
    let years = 0;
    for (let k = 1; k <= HISTORY_YEARS; k++) if (byYear.has(y0 - k)) years++;

    let sum3 = 0;
    let n3 = 0;
    for (let t = 1; t <= 3; t++) {
      if (byYear.has(y0 - t)) {
        sum3 += byYear.get(y0 - t);
        n3++;
      }
    }
    const avg3 = n3 ? sum3 / n3 / price : 0;

    const flags = [];
    if (ttm <= 0) flags.push("n:无分红");
    if (nonHkd > 0) flags.push("i:非港币派息");
    if (ttm > 0 && consec <= 1) flags.push("w:分红不连续");
    if (ttm > 0.1) flags.push("b:需核验");
    if (price < 1) flags.push("w:低价股");
    if (ttm >= 0.04 && consec >= 5) flags.push("g:稳健");

    rows.push([
      c,
      it.f14 || c,
      price,
      num(it.f3, NaN),
      num(it.f9, NaN),
      mcap,
      String(it.f100 || ""),
      Math.round(ttm * 1e6),
      Math.round(last * 1e6),
      Math.round(avg3 * 1e6),
      consec,
      years,
      ttmCnt,
      flags.join("|"),
      rr
        .slice()
        .sort((a, b) => b.ex.localeCompare(a.ex))
        .slice(0, 8)
        .map((x) => `${x.year},${x.dps},${x.ex},${x.ccy},${x.type}`)
        .join(";")
    ]);
  }
  console.log(`[HK] 计算完成 ${rows.length} 行`);
  return { ts: Date.now(), market: "hk", years: HISTORY_YEARS, rows };
}

/* ------------------------------ 主流程 ------------------------------ */

async function main() {
  // 快照不进 main：Pages 免费版每月 500 次构建，频繁提交会打爆配额。
  // 工作流会把产物推到独立的 data 分支，页面用 raw.githubusercontent 直读。
  const outDir = path.join(process.cwd(), process.env.SNAPSHOT_DIR || "data");
  fs.mkdirSync(outDir, { recursive: true });

  const only = process.argv[2];
  const jobs = [];
  if (!only || only === "a") jobs.push(["a", buildA]);
  if (!only || only === "hk") jobs.push(["hk", buildHK]);

  for (const [name, fn] of jobs) {
    try {
      const pack = await fn();
      const file = path.join(outDir, name + ".json");
      const text = JSON.stringify(pack);
      fs.writeFileSync(file, text);
      console.log(`写入 ${file}  ${(text.length / 1024).toFixed(0)}KB  ${pack.rows.length} 行`);
    } catch (e) {
      console.error(`[${name}] 失败：${e && e.message}`);
      process.exitCode = 1;
    }
  }
}

main();
