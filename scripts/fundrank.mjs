// 从第三方天天基金 API 拉全市场排行（收益 + 规模）
//
// 接口：http://60.204.219.84:5000/fundMNRank
//   - 单页最多 30 条（文档写明 pageSize 最大 30），全市场约 2.5 万只 → 约 850 页
//   - 每行 55 个字段，含 ENDNAV（规模，单位「元」）与全套阶段收益
//   - 注意：这个接口**没有**基金经理、成立日、主题，那三项要走 detail 逐只补
//
// 产物 fundrank.json：
//   c 代码 / n 简称 / t 类型 / nav 单位净值 / acc 累计净值 / chg 日涨幅
//   w1 m1 m3 m6 y1 y2 y3 y5 ytd since 各阶段收益
//   nav2 规模（亿元，已从元换算）
//
// 用法：node scripts/fundrank.mjs --pages 5    只拉 5 页验证
//      node scripts/fundrank.mjs                全量

import fs from "node:fs";
import path from "node:path";

const BASE = "http://60.204.219.84:5000";
const OUT_DIR = process.env.SNAPSHOT_DIR || "data";
const CONCURRENCY = 4;
const PAGE_SIZE = 30;

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v == null ? def : Number(v);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function n(v) {
  const x = parseFloat(v);
  return Number.isFinite(x) ? x : null;
}

async function fetchPage(pi) {
  const url = BASE + "/fundMNRank?FundType=0&SortColumn=SYL_1N&Sort=desc" +
    "&pageIndex=" + pi + "&pageSize=" + PAGE_SIZE;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, {
        headers: { accept: "application/json", "user-agent": "guxi-snapshot/1.0" },
        signal: AbortSignal.timeout(25000)
      });
      if (!res.ok) { await sleep(500 * (i + 1)); continue; }
      const j = await res.json();
      if (!j || !j.Success || !Array.isArray(j.Datas)) {
        await sleep(500 * (i + 1));
        continue;
      }
      return { rows: j.Datas, total: Number(j.TotalCount) || 0 };
    } catch (e) {
      await sleep(500 * (i + 1));
    }
  }
  return { rows: [], total: 0, err: true };
}

function mapRow(r) {
  const nav2 = n(r.ENDNAV);
  return {
    c: r.FCODE,
    n: r.SHORTNAME,
    t: r.FTYPE || r.FUNDTYPE || "",
    nav: n(r.DWJZ),
    acc: n(r.LJJZ),
    chg: n(r.RZDF),
    w1: n(r.SYL_Z),
    m1: n(r.SYL_Y),
    m3: n(r.SYL_3Y),
    m6: n(r.SYL_6Y),
    y1: n(r.SYL_1N),
    y2: n(r.SYL_2N),
    y3: n(r.SYL_3N),
    y5: n(r.SYL_5N),
    ytd: n(r.SYL_JN),
    since: n(r.SYL_LN),
    // 接口给的是元，统一换成亿元
    nav2: nav2 == null ? null : Math.round(nav2 / 1e6) / 100
  };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const first = await fetchPage(1);
  if (!first.rows.length) throw new Error("第一页就没数据，接口可能不可用");
  const total = first.total;
  const maxPage = arg("pages", 0);
  const pages = maxPage > 0 ? maxPage : Math.ceil(total / first.rows.length);
  console.log("[RANK] 总数 " + total + "，每页 " + first.rows.length + "，计划抓 " + pages + " 页");

  const all = first.rows.slice();
  let pi = 2, done = 1, fail = 0;

  async function worker() {
    while (pi <= pages) {
      const cur = pi++;
      const r = await fetchPage(cur);
      done++;
      if (r.err) fail++;
      else all.push(...r.rows);
      if (done % 50 === 0) console.log("  进度 " + done + "/" + pages + " 页，累计 " + all.length + " 行");
      await sleep(80);
    }
  }

  await Promise.all([worker(), worker(), worker(), worker()]);
  console.log("[RANK] 抓完 " + done + " 页，失败 " + fail + " 页，原始 " + all.length + " 行");

  // 去重（分页过程中榜单可能有微小变动导致重复）
  const seen = new Set();
  const rows = [];
  for (const r of all) {
    if (!r || !r.FCODE || seen.has(r.FCODE)) continue;
    seen.add(r.FCODE);
    rows.push(mapRow(r));
  }
  console.log("[RANK] 去重后 " + rows.length + " 只");

  const pack = { v: 1, ts: Date.now(), total: total, count: rows.length, rows };
  const text = JSON.stringify(pack);
  fs.writeFileSync(path.join(OUT_DIR, "fundrank.json"), text);
  console.log("OK fundrank.json " + (text.length / 1024).toFixed(0) + "KB  " + rows.length + " 只");

  const sample = rows.slice(0, 2);
  for (const s of sample) console.log("  " + JSON.stringify(s));
}

main().catch((e) => {
  console.error("FAIL fundrank: " + (e && e.message));
  process.exit(1);
});
