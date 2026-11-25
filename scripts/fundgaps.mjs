// 查漏：统计 funddetail / fundmgr 里的空洞，并按原因归类
//
// 目的不是修数据，是搞清楚「缺的那几百只到底是什么」：
// 是新基金没披露季报？货币基金本来就不发规模？还是解析漏了？
// 分清楚了才知道哪些能补、哪些补不了。

import fs from "node:fs";
import path from "node:path";

const OUT_DIR = process.env.SNAPSHOT_DIR || "data";

function readJson(f) {
  try { return JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), "utf8")); } catch (e) { return null; }
}

function byKey(arr, fn) {
  const m = {};
  for (const x of arr) {
    const k = fn(x) || "未知";
    m[k] = (m[k] || 0) + 1;
  }
  return Object.keys(m)
    .sort((a, b) => m[b] - m[a])
    .reduce((o, k) => { o[k] = m[k]; return o; }, {});
}

function main() {
  const detail = readJson("funddetail.json");
  const fm = readJson("fundmgr.json");
  const rank = readJson("fundrank.json");
  if (!detail || !detail.rows) throw new Error("没有 funddetail.json");

  const rows = detail.rows.filter((r) => r && r.c);
  const fmRows = (fm && fm.rows) || {};
  const rankBy = new Map();
  for (const r of (rank && rank.rows) || []) rankBy.set(r.c, r);

  const noScale = rows.filter((r) => r.s == null);
  const noMgr = rows.filter((r) => !fmRows[r.c] || fmRows[r.c].a == null);
  const noDays = rows.filter((r) => !fmRows[r.c] || fmRows[r.c].d == null);

  // 收益缺口单独看（排行接口的 y1 常有空）
  const noY1 = [];
  for (const r of rows) {
    const k = rankBy.get(r.c);
    if (!k || k.y1 == null) noY1.push(r);
  }

  const yearOf = (r) => (r.est ? r.est.slice(0, 4) : "无成立日");

  const pack = {
    v: 1,
    ts: Date.now(),
    total: rows.length,
    summary: {
      noScale: noScale.length,
      noMgrAum: noMgr.length,
      noMgrDays: noDays.length,
      noY1: noY1.length
    },
    // 缺规模：按类型和成立年份分布，判断是「新基金」还是「某类基金不发规模」
    noScaleByType: byKey(noScale, (r) => r.t),
    noScaleByYear: byKey(noScale, yearOf),
    noScaleSample: noScale.slice(0, 60).map((r) => ({ c: r.c, n: r.nm, t: r.t, est: r.est, bench: (r.bench || "").slice(0, 30) })),
    // 缺经理/任职
    noMgrByType: byKey(noMgr, (r) => r.t),
    noMgrSample: noMgr.slice(0, 40).map((r) => ({ c: r.c, n: r.nm, t: r.t, est: r.est, jj: r.jj })),
    noDaysSample: noDays.slice(0, 20).map((r) => ({ c: r.c, n: r.nm, est: r.est }))
  };

  const text = JSON.stringify(pack);
  fs.writeFileSync(path.join(OUT_DIR, "gapreport.json"), text);
  console.log("OK gapreport.json " + (text.length / 1024).toFixed(0) + "KB");
  console.log("总数 " + rows.length + "：缺规模 " + noScale.length + "，缺在管规模 " + noMgr.length + "，缺任职 " + noDays.length + "，缺近1年收益 " + noY1.length);
  console.log("缺规模的类型分布：" + JSON.stringify(pack.noScaleByType));
  console.log("缺规模的成立年份：" + JSON.stringify(pack.noScaleByYear));
}

try { main(); } catch (e) {
  console.error("FAIL fundgaps: " + (e && e.message));
  process.exit(1);
}
