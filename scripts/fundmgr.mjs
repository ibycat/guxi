// 基金经理抓取：从业年限 / 在管规模 / 每只基金的任职天数
//
// 数据源：https://fund.eastmoney.com/manager/<id>.html
// 一个页面同时给了三样东西：
//   累计任职时间（从业年限）、任职起始日期、现任基金资产总规模（在管规模），
//   以及「管理过的基金一览」表格 —— 每行带 任职时间 / 任职天数 / 是否「至今」。
// 所以「管理该基金时长」不用再单独爬基金经理变动表，这里一次就够。
//
// 产物：
//   managers.json  经理级缓存（增量续跑用）
//   fundmgr.json   基金级汇总：每只基金的 现任经理数 / 最长任职天数 / 在管规模
//
// 用法：node scripts/fundmgr.mjs --limit 20

import fs from "node:fs";
import path from "node:path";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const BASE = "https://fund.eastmoney.com/manager/";

const OUT_DIR = process.env.SNAPSHOT_DIR || "data";

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v == null ? def : Number(v);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stripTags(s) {
  return String(s || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// 「7年又217天」/「217天」→ 天数
function toDays(txt) {
  if (!txt) return null;
  const y = txt.match(/(\d+)\s*年/);
  const d = txt.match(/(\d+)\s*天/);
  if (!y && !d) return null;
  return (y ? Number(y[1]) * 365 : 0) + (d ? Number(d[1]) : 0);
}

// 任职天数：表格里没有这一列，用起始日期算到今天（已离任的算到离任日）
function spanDays(from, to) {
  const a = new Date(from + "T00:00:00");
  const b = to ? new Date(to + "T00:00:00") : new Date();
  if (isNaN(a)) return null;
  const d = Math.round((b - a) / 864e5);
  return d >= 0 ? d : null;
}

function parseManager(html, id) {
  const text = stripTags(html);

  const yearsTxt = (text.match(/累计任职时间[：:]\s*([0-9]+年(?:又[0-9]+天)?|[0-9]+天)/) || [])[1] || "";
  const start = (text.match(/任职起始日期[：:]\s*(\d{4}-\d{2}-\d{2})/) || [])[1] || "";
  const aum = (text.match(/现任基金资产\s*总规模\s*([\d.]+)\s*亿/) || [])[1];
  const nm = (text.match(/基金经理[：:]?\s*([^\s，,]{2,8})\s*的档案/) || [])[1] || "";

  // 「管理过的基金一览」表格：逐行拆 <tr>，找带 6 位代码的行。
  // 注意链接是协议相对写法 //fund.eastmoney.com/027684.html，不能只认 /027684.html
  const funds = [];
  const rows = html.split(/<tr[\s>]/i);
  for (const r of rows) {
    const m = r.match(/href="(?:\/\/fund\.eastmoney\.com)?\/(\d{6})\.html"/);
    if (!m) continue;
    const period = r.match(/(\d{4}-\d{2}-\d{2})\s*~\s*(至今|\d{4}-\d{2}-\d{2})/);
    if (!period) continue;
    const from = period[1];
    const to = period[2];
    const cur = to === "至今";
    funds.push({
      c: m[1],
      s: from,
      cur: cur,
      d: spanDays(from, cur ? null : to)
    });
  }

  return {
    id,
    n: nm,
    y: toDays(yearsTxt),
    ys: start,
    aum: aum == null ? null : Number(aum),
    funds: funds.slice(0, 40)
  };
}

async function fetchManager(id) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(BASE + id + ".html", {
        headers: { "user-agent": UA, referer: "https://fund.eastmoney.com/", accept: "text/html,*/*" },
        signal: AbortSignal.timeout(20000)
      });
      if (res.status === 404) return { id, err: "404" };
      if (!res.ok) { await sleep(500 * (i + 1)); continue; }
      const html = await res.text();
      if (html.indexOf("累计任职时间") < 0) { await sleep(500 * (i + 1)); continue; }
      return parseManager(html, id);
    } catch (e) {
      await sleep(500 * (i + 1));
    }
  }
  return { id, err: "fetch_failed" };
}

function readJson(f) {
  try { return JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), "utf8")); } catch (e) { return null; }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 经理 id 来源：优先用 mgrmap.json（姓名→id，来自 /fundSearch?m=7）。
  // 那条链路几分钟就能建完；fundmeta 里也带 id，但它要爬 F10 概况页，速度慢，
  // 只作为兜底保留。
  const ids = new Set();
  const mm = readJson("mgrmap.json");
  for (const r of (mm && mm.rows) || []) if (r && r.id) ids.add(r.id);

  if (!ids.size) {
    const meta = readJson("fundmeta.json");
    for (const r of (meta && meta.rows) || []) {
      for (const m of r.mgr || []) if (m.id) ids.add(m.id);
    }
    if (ids.size) console.log("[MGR] mgrmap 不可用，退回 fundmeta 的经理 id（" + ids.size + " 个）");
  }
  if (!ids.size) throw new Error("没有 mgrmap.json 也没有 fundmeta.json，无法确定经理 id");

  const cache = readJson("managers.json");
  const done = new Map();
  for (const r of (cache && cache.rows) || []) if (r && r.id && !r.err) done.set(r.id, r);

  const pending = [...ids].filter((id) => !done.has(id));
  const limit = arg("limit", 20);
  const todo = limit > 0 ? pending.slice(0, limit) : pending;

  console.log("[MGR] 经理共 " + ids.size + " 位，已抓 " + done.size + "，本次抓 " + todo.length);

  const rows = [];
  let idx = 0, ok = 0;
  async function worker() {
    while (idx < todo.length) {
      const id = todo[idx++];
      const rec = await fetchManager(id);
      if (!rec.err) ok++;
      rows.push(rec);
      if (rows.length % 10 === 0) console.log("  已处理 " + rows.length + "/" + todo.length + "，成功 " + ok);
      await sleep(120);
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  console.log("[MGR] 完成：成功 " + ok + " / " + rows.length);

  // 合并缓存
  const mergedMgr = new Map(done);
  for (const r of rows) if (!r.err) mergedMgr.set(r.id, r);
  const mgrRows = [...mergedMgr.values()];

  // 抽样打印，便于人工确认解析
  for (const s of mgrRows.slice(0, 3)) {
    console.log("  " + JSON.stringify({ id: s.id, n: s.n, y: s.y, ys: s.ys, aum: s.aum, cur: (s.funds || []).filter((x) => x.cur).length }));
  }

  // 反转到基金维度：每只基金取「现任经理」里最长的任职天数、最大的在管规模
  const byFund = new Map();
  for (const m of mgrRows) {
    for (const f of m.funds || []) {
      if (!f.cur) continue;
      let o = byFund.get(f.c);
      if (!o) { o = { d: 0, a: 0, n: 0 }; byFund.set(f.c, o); }
      o.n++;
      if (f.d && f.d > o.d) o.d = f.d;
      if (m.aum != null && m.aum > o.a) o.a = m.aum;
    }
  }

  const fundRows = {};
  for (const [c, o] of byFund) fundRows[c] = { d: o.d || null, a: o.a || null, n: o.n };

  const mtext = JSON.stringify({ v: 1, ts: Date.now(), count: mgrRows.length, rows: mgrRows });
  fs.writeFileSync(path.join(OUT_DIR, "managers.json"), mtext);

  const ftext = JSON.stringify({ v: 1, ts: Date.now(), count: Object.keys(fundRows).length, rows: fundRows });
  fs.writeFileSync(path.join(OUT_DIR, "fundmgr.json"), ftext);

  console.log(
    "OK managers.json " + (mtext.length / 1024).toFixed(0) + "KB（" + mgrRows.length + " 位）" +
    " / fundmgr.json " + (ftext.length / 1024).toFixed(0) + "KB（" + Object.keys(fundRows).length + " 只基金）"
  );
}

main().catch((e) => {
  console.error("FAIL fundmgr: " + (e && e.message));
  process.exit(1);
});
