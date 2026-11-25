// 基金元信息抓取：规模 / 基金经理 / 跟踪标的 / 基金全称
//
// 数据源：https://fundf10.eastmoney.com/jbgk_<code>.html （基金基本概况页）
// 该页一次给全：净资产规模、基金经理名单（带 manager id）、基金全称、
// 跟踪标的、业绩比较基准、成立日期、基金类型。
//
// 为什么按「基金全称」分组：A/C/E 等份额的简称不同，但基金全称完全一样，
// 所以它是合并份额最可靠的分组键（比按简称去后缀稳，不会把「XX混合A」
// 和「XX债券A」错并）。
//
// 用法：
//   node scripts/fundmeta.mjs --limit 300     只抓前 300 只（样本验证）
//   node scripts/fundmeta.mjs --limit 0       全量
// 产物：fundmeta.json（含每只基金的自身规模 s、同全称合并后的 gs）

import fs from "node:fs";
import path from "node:path";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const SRC = "https://raw.githubusercontent.com/ibycat/guxi/data/fundrank.json";
const BASE = "https://fundf10.eastmoney.com/jbgk_";
const REFERER = "https://fundf10.eastmoney.com/";

const OUT_DIR = process.env.SNAPSHOT_DIR || "data";
const CONCURRENCY = 8;

// 代码 → 简称，用来填充 funddetail.json 的 nm 字段（F10 概况页不给简称）
const NAME_MAP = new Map();

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v == null ? def : Number(v);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function stripTags(s) {
  return String(s || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

// 取「<th>字段名</th> 之后紧跟的那个 <td>」的文本。
// th 里可能还嵌 <a>，所以中间允许一小段任意内容。
function cellText(html, key) {
  const re = new RegExp(
    "<th[^>]*>[\\s\\S]{0,60}?" + key + "[\\s\\S]{0,120}?</th>\\s*<td[^>]*>([\\s\\S]*?)</td>",
    "i"
  );
  const m = html.match(re);
  return m ? stripTags(m[1]) : "";
}

function cellHtml(html, key) {
  const re = new RegExp(
    "<th[^>]*>[\\s\\S]{0,60}?" + key + "[\\s\\S]{0,120}?</th>\\s*<td[^>]*>([\\s\\S]*?)</td>",
    "i"
  );
  const m = html.match(re);
  return m ? m[1] : "";
}

function parseScale(text) {
  // 形如：66.84亿元（截止至：2026年09月30日） / 12.34亿元（截止至：2026-09-30）
  const m = text.match(/([\d.]+)\s*亿/);
  const d = text.match(/(\d{4})[年\-\/](\d{1,2})[月\-\/](\d{1,2})/);
  return {
    scale: m ? Number(m[1]) : null,
    sdate: d ? d[1] + "-" + String(d[2]).padStart(2, "0") + "-" + String(d[3]).padStart(2, "0") : ""
  };
}

function parseManagers(tdHtml) {
  const out = [];
  const re = /\/manager\/(\d+)\.html[^>]*>([^<]+)</g;
  let m;
  while ((m = re.exec(tdHtml))) {
    out.push({ id: m[1], n: stripTags(m[2]) });
  }
  // 有的页面经理不是链接，退化成按「、」切分文本
  if (!out.length) {
    const txt = stripTags(tdHtml);
    for (const nm of txt.split(/[、,，\s]+/)) {
      if (nm && nm.length <= 6 && nm !== "暂无") out.push({ id: "", n: nm });
    }
  }
  return out;
}

async function fetchCode(code) {
  const url = BASE + code + ".html";
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, {
        headers: { "user-agent": UA, referer: REFERER, accept: "text/html,*/*" },
        signal: AbortSignal.timeout(20000)
      });
      if (res.status === 404) return { c: code, err: "404" };
      if (!res.ok) { await sleep(600 * (i + 1)); continue; }
      const html = await res.text();
      if (html.length < 2000 || html.indexOf("基金全称") < 0) {
        await sleep(600 * (i + 1));
        continue;
      }

      const full = cellText(html, "基金全称");
      const type = cellText(html, "基金类型");
      const scaleTxt = cellText(html, "净资产规模");
      const { scale, sdate } = parseScale(scaleTxt);
      const estTxt = cellText(html, "成立日期");
      const estM = estTxt.match(/(\d{4})[年\-\/](\d{1,2})[月\-\/](\d{1,2})/);
      const est = estM
        ? estM[1] + "-" + String(estM[2]).padStart(2, "0") + "-" + String(estM[3]).padStart(2, "0")
        : "";
      const mgr = parseManagers(cellHtml(html, "基金经理"));
      let track = cellText(html, "跟踪标的");
      if (/无跟踪标的|^---?$/.test(track)) track = "";
      let bench = cellText(html, "业绩比较基准");
      if (bench.length > 120) bench = bench.slice(0, 120);

      return { c: code, full, t: type, s: scale, sdate, est, mgr: mgr.slice(0, 6), track, bench };
    } catch (e) {
      await sleep(600 * (i + 1));
    }
  }
  return { c: code, err: "fetch_failed" };
}

async function loadCodes() {
  // 代码来源改成 fundrank.json（原来的 fund.json 已随旧工作流下线）
  const local = path.join(OUT_DIR, "fundrank.json");
  let pack = null;
  if (fs.existsSync(local)) {
    pack = JSON.parse(fs.readFileSync(local, "utf8"));
    console.log("[META] 使用本地 " + local);
  } else {
    const res = await fetch(SRC, { headers: { "user-agent": UA } });
    if (!res.ok) throw new Error("fundrank.json 拉取失败 " + res.status);
    pack = await res.json();
    console.log("[META] 从 data 分支读取 fundrank.json");
  }
  const codes = [];
  for (const r of pack.rows || []) {
    if (!r || !r.c) continue;
    codes.push(r.c);
    if (r.n) NAME_MAP.set(r.c, r.n);
  }
  return codes;
}

// 读取上一次的产物，用于增量续跑：已经抓成功的代码不再重复抓，
// 否则分批跑的时候每一批都会把前一批的结果覆盖掉。
function loadExisting() {
  const p = path.join(OUT_DIR, "fundmeta.json");
  if (!fs.existsSync(p)) return new Map();
  try {
    const d = JSON.parse(fs.readFileSync(p, "utf8"));
    const m = new Map();
    for (const r of d.rows || []) {
      if (r && r.c && !r.err) {
        // 老记录没有抓取时间，按 0 处理 —— 滚动刷新时它们排在队首，最先被更新
        if (!r.t) r.t = 0;
        m.set(r.c, r);
      }
    }
    return m;
  } catch (e) {
    return new Map();
  }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const all = await loadCodes();
  const limit = arg("limit", 300);
  // 滚动刷新：每轮额外重抓 N 只「最久没更新」的基金。
  // 只补新增的话，规模（季报）和经理会永远停在第一次抓到的状态。
  const refreshN = arg("refresh", 0);
  const done = loadExisting();
  // 已经抓过的跳过，每次只处理「还没抓的」前 N 只 —— 这样分批跑能自然接续
  const pending = all.filter((c) => !done.has(c));
  let codes = limit > 0 ? pending.slice(0, limit) : pending;

  let refreshCodes = [];
  if (refreshN > 0) {
    const chosen = new Set(codes);
    refreshCodes = Array.from(done.values())
      .filter((r) => !chosen.has(r.c))
      .sort((a, b) => (a.t || 0) - (b.t || 0))
      .slice(0, refreshN)
      .map((r) => r.c);
    codes = codes.concat(refreshCodes);
  }

  console.log(
    "[META] 全量 " + all.length + " 只，已覆盖 " + done.size + " 只；" +
    "本批新增 " + (codes.length - refreshCodes.length) + " 只，滚动刷新 " + refreshCodes.length + " 只"
  );

  const rows = [];
  let n = 0, ok = 0;
  let idx = 0;

  async function worker() {
    while (idx < codes.length) {
      const code = codes[idx++];
      const rec = await fetchCode(code);
      n++;
      if (!rec.err) { ok++; rec.t = Date.now(); }
      rows.push(rec);
      if (n % 25 === 0 || n === codes.length) {
        console.log("  进度 " + n + "/" + codes.length + "，成功 " + ok);
      }
      await sleep(80);
    }
  }

  await Promise.all(new Array(CONCURRENCY).fill(0).map(() => worker()));
  console.log("[META] 抓取完成：成功 " + ok + " / " + rows.length);

  // 合并：本次成功的写入，失败的丢弃（下次自动重试），历史记录保留
  const merged = new Map(done);
  for (const r of rows) {
    if (r.err) continue;
    merged.set(r.c, r);
  }
  const allRows = Array.from(merged.values());

  // 按基金全称合并份额规模：同一只基金的 A/C/E 等份额规模相加。
  // 必须基于「全量已抓记录」计算 —— 只用本批算的话，分批跑时合并值会偏小。
  const groupSum = new Map();
  const groupCnt = new Map();
  for (const r of allRows) {
    if (!r.full) continue;
    groupCnt.set(r.full, (groupCnt.get(r.full) || 0) + 1);
    if (r.s == null) continue;
    groupSum.set(r.full, (groupSum.get(r.full) || 0) + r.s);
  }
  for (const r of allRows) {
    r.gs = r.full && r.s != null ? Math.round(groupSum.get(r.full) * 100) / 100 : null;
    r.gn = r.full ? groupCnt.get(r.full) : 0;
  }

  // 解析质量自检：只看本批，用来判断 HTML 结构有没有变
  const batch = rows.filter((r) => !r.err);
  const total = batch.length || 1;
  const miss = (f) => batch.filter((r) => r[f] == null || r[f] === "").length;
  console.log("[META] 本批空值率：全称 " + ((miss("full") / total) * 100).toFixed(1) + "%" +
    " / 规模 " + ((miss("s") / total) * 100).toFixed(1) + "%" +
    " / 经理 " + ((batch.filter((r) => !r.mgr || !r.mgr.length).length / total) * 100).toFixed(1) + "%" +
    " / 成立日 " + ((miss("est") / total) * 100).toFixed(1) + "%");

  for (const s of batch.slice(0, 3)) console.log("  " + JSON.stringify(s));

  if (!allRows.length) throw new Error("一条都没抓成功，放弃写入");

  const pack = {
    v: 1,
    ts: Date.now(),
    total: all.length,
    count: allRows.length,
    mode: allRows.length >= all.length ? "full" : "partial",
    rows: allRows
  };
  const text = JSON.stringify(pack);
  fs.writeFileSync(path.join(OUT_DIR, "fundmeta.json"), text);

  // 顺手产出两份「下游已经在用」的文件，避免再去依赖第三方接口：
  //   funddetail.json —— 基金页读它取全称/经理/成立日/规模/基准
  //   mgrmap.json     —— 经理姓名 → id，fundmgr 靠它确定要抓谁
  const det = [];
  const mgrMap = Object.create(null);
  const mgrRows = [];
  for (const r of allRows) {
    const mgr = r.mgr || [];
    det.push({
      c: r.c,
      full: r.full || "",
      nm: NAME_MAP.get(r.c) || "",
      t: r.t || "",
      est: r.est || "",
      s: r.s,
      jj: mgr.map((m) => m.n).join("、"),
      jjn: mgr.length,
      bench: r.bench || "",
      idx: r.track || "",
      gs: r.gs,
      gn: r.gn
    });
    for (const m of mgr) {
      if (!m || !m.id || !m.n) continue;
      if (!mgrMap[m.n]) {
        mgrMap[m.n] = m.id;
        mgrRows.push({ n: m.n, id: m.id, com: "", exact: true, dup: 0 });
      }
    }
  }

  fs.writeFileSync(
    path.join(OUT_DIR, "funddetail.json"),
    JSON.stringify({
      v: 1,
      ts: Date.now(),
      total: all.length,
      count: det.length,
      mode: pack.mode,
      rows: det
    })
  );
  // mgrmap 必须增量合并：本批只覆盖几千只基金，直接覆盖会把之前批次
  // 带来的经理丢掉，fundmgr 就会变少。以旧文件为底，新的补进去。
  try {
    const p = path.join(OUT_DIR, "mgrmap.json");
    if (fs.existsSync(p)) {
      const old = JSON.parse(fs.readFileSync(p, "utf8"));
      for (const r of old.rows || []) {
        if (!r || !r.n || !r.id) continue;
        if (!mgrMap[r.n]) {
          mgrMap[r.n] = r.id;
          mgrRows.push(r);
        }
      }
    }
  } catch (e) { /* 旧文件坏了就从零开始 */ }

  fs.writeFileSync(
    path.join(OUT_DIR, "mgrmap.json"),
    JSON.stringify({
      v: 1,
      ts: Date.now(),
      count: mgrRows.length,
      totalNames: mgrRows.length,
      map: mgrMap,
      rows: mgrRows
    })
  );
  console.log(
    "OK 附带产出 funddetail.json " + det.length + " 只、mgrmap.json " + mgrRows.length + " 位经理"
  );
  console.log(
    "OK fundmeta.json  " + (text.length / 1024).toFixed(0) + "KB  覆盖 " +
    allRows.length + " / " + all.length + " 只"
  );
}

main().catch((e) => {
  console.error("FAIL fundmeta: " + (e && e.message));
  process.exit(1);
});
