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
const SRC = "https://raw.githubusercontent.com/ibycat/guxi/data/fund.json";
const BASE = "https://fundf10.eastmoney.com/jbgk_";
const REFERER = "https://fundf10.eastmoney.com/";

const OUT_DIR = process.env.SNAPSHOT_DIR || "data";
const CONCURRENCY = 3;

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
  const local = path.join(OUT_DIR, "fund.json");
  let pack = null;
  if (fs.existsSync(local)) {
    pack = JSON.parse(fs.readFileSync(local, "utf8"));
    console.log("[META] 使用本地 " + local);
  } else {
    const res = await fetch(SRC, { headers: { "user-agent": UA } });
    if (!res.ok) throw new Error("fund.json 拉取失败 " + res.status);
    pack = await res.json();
    console.log("[META] 从 data 分支读取 fund.json");
  }
  return (pack.rows || []).map((r) => r.c).filter(Boolean);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const all = await loadCodes();
  const limit = arg("limit", 300);
  // 跨类型抽样：按固定步长取，避免前 300 只全是同一家公司的同一类基金
  let codes;
  if (limit > 0 && limit < all.length) {
    const step = Math.floor(all.length / limit);
    codes = [];
    for (let i = 0; i < all.length && codes.length < limit; i += step) codes.push(all[i]);
  } else {
    codes = all;
  }
  console.log("[META] 待抓 " + codes.length + " / " + all.length + " 只");

  const rows = [];
  let done = 0, ok = 0;
  let idx = 0;

  async function worker() {
    while (idx < codes.length) {
      const code = codes[idx++];
      const rec = await fetchCode(code);
      done++;
      if (!rec.err) ok++;
      rows.push(rec);
      if (done % 25 === 0 || done === codes.length) {
        console.log("  进度 " + done + "/" + codes.length + "，成功 " + ok);
      }
      await sleep(120);
    }
  }

  await Promise.all([worker(), worker(), worker()]);
  console.log("[META] 抓取完成：成功 " + ok + " / " + rows.length);

  // 按基金全称合并份额规模：同一只基金的 A/C/E 等份额规模相加
  const groupSum = new Map();
  const groupCnt = new Map();
  for (const r of rows) {
    if (!r.full) continue;
    groupCnt.set(r.full, (groupCnt.get(r.full) || 0) + 1);
    if (r.s == null) continue;
    groupSum.set(r.full, (groupSum.get(r.full) || 0) + r.s);
  }
  for (const r of rows) {
    r.gs = r.full && r.s != null ? Math.round(groupSum.get(r.full) * 100) / 100 : null;
    r.gn = r.full ? groupCnt.get(r.full) : 0;
  }

  // 解析质量自检：关键字段的空值率，用来判断 HTML 结构有没有变
  const total = rows.filter((r) => !r.err).length || 1;
  const miss = (f) => rows.filter((r) => !r.err && (r[f] == null || r[f] === "" || r[f] === undefined)).length;
  console.log("[META] 空值率：全称 " + ((miss("full") / total) * 100).toFixed(1) + "%" +
    " / 规模 " + ((miss("s") / total) * 100).toFixed(1) + "%" +
    " / 经理 " + ((rows.filter((r) => !r.err && (!r.mgr || !r.mgr.length)).length / total) * 100).toFixed(1) + "%" +
    " / 成立日 " + ((miss("est") / total) * 100).toFixed(1) + "%");

  const sample = rows.filter((r) => !r.err).slice(0, 3);
  console.log("[META] 样本：");
  for (const s of sample) console.log("  " + JSON.stringify(s));

  if (!rows.filter((r) => !r.err).length) throw new Error("全部抓取失败，放弃写入");

  const pack = { v: 1, ts: Date.now(), count: rows.length, mode: limit > 0 ? "sample" : "full", rows };
  const text = JSON.stringify(pack);
  fs.writeFileSync(path.join(OUT_DIR, "fundmeta.json"), text);
  console.log("OK fundmeta.json  " + (text.length / 1024).toFixed(0) + "KB  " + rows.length + " 行");
}

main().catch((e) => {
  console.error("FAIL fundmeta: " + (e && e.message));
  process.exit(1);
});
