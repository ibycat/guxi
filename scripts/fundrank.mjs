// 全市场基金排行（东财 rankhandler 版）
//
// 换掉第三方 /fundMNRank：那个服务是临时的，不能当长期依赖。
// 东财自己这个接口一页能拿 5000 条，全市场 5 页就够，比按 30 条分页快得多。
//
// 字段口径（逗号分隔）：
//   0 代码 1 简称 2 拼音 3 净值日期 4 单位净值 5 累计净值 6 日涨幅
//   7 近1周 8 近1月 9 近3月 10 近6月 11 近1年 12 近2年 13 近3年
//   14 今年来 15 成立来 16 自定义 17 成立日期
// 成立日期在不同 ft 参数下下标会浮动，所以不按固定下标取，
// 而是从第 16 项往后找一个形如 YYYY-MM-DD 的字段。
//
// 注意：这个接口**没有规模**。规模改由 fundmeta（F10 概况页）提供，
// 页面本来就是从 funddetail 取规模，所以不影响展示。

import fs from "node:fs";
import path from "node:path";

const SRC = "https://fund.eastmoney.com/data/rankhandler.aspx";
const OUT_DIR = process.env.SNAPSHOT_DIR || "data";
const PAGE_SIZE = 5000;
const CONCURRENCY = 3;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const REFERER = "https://fund.eastmoney.com/data/fundranking.html";

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

function query(page) {
  return (
    "op=ph&dt=kf&ft=all&rs=&gs=0&sc=1nzf&st=desc&sd=&ed=" +
    "&qdii=&tabSubtype=,,,,,&pi=" + page + "&pn=" + PAGE_SIZE + "&dx=1&v=" + Date.now()
  );
}

async function fetchPage(page) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(SRC + "?" + query(page), {
        headers: {
          "user-agent": UA,
          referer: REFERER,
          accept: "*/*",
          "accept-language": "zh-CN,zh;q=0.9"
        },
        signal: AbortSignal.timeout(30000)
      });
      if (!res.ok) { await sleep(700 * (i + 1)); continue; }
      const text = await res.text();

      const m = text.match(/datas:\s*\[([\s\S]*?)\],\s*allRecords:(\d+)/);
      if (!m) { await sleep(700 * (i + 1)); continue; }

      const total = Number(m[2]) || 0;
      const arr = m[1] ? m[1].split('","').map((s) => s.replace(/^"|"$/g, "")) : [];
      return { total, arr };
    } catch (e) {
      await sleep(700 * (i + 1));
    }
  }
  return null;
}

function parseRow(s) {
  const f = s.split(",");
  if (f.length < 16 || !/^\d{6}$/.test(f[0])) return null;

  let est = "";
  for (let i = 16; i < f.length && i < 22; i++) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(f[i])) { est = f[i]; break; }
  }

  return {
    c: f[0],
    n: f[1],
    t: "",            // 排行接口不给类型，由 fundmeta 补
    nav: n(f[4]),
    acc: n(f[5]),
    chg: n(f[6]),
    w1: n(f[7]),
    m1: n(f[8]),
    m3: n(f[9]),
    m6: n(f[10]),
    y1: n(f[11]),
    y2: n(f[12]),
    y3: n(f[13]),
    ytd: n(f[14]),
    since: n(f[15]),
    est
  };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const limitPages = arg("pages", 0);

  const first = await fetchPage(1);
  if (!first || !first.arr.length) throw new Error("第 1 页就没拿到数据，接口可能不可用");
  const total = first.total;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  console.log("[RANK] 全市场 " + total + " 条，每页 " + PAGE_SIZE + "，共 " + pages + " 页");

  const rows = [];
  for (const s of first.arr) {
    const r = parseRow(s);
    if (r) rows.push(r);
  }

  const rest = [];
  for (let p = 2; p <= pages; p++) rest.push(p);
  const todo = limitPages > 0 ? rest.slice(0, limitPages - 1) : rest;

  let idx = 0;
  async function worker() {
    while (idx < todo.length) {
      const p = todo[idx++];
      const r = await fetchPage(p);
      if (!r) { console.log("  第 " + p + " 页失败"); continue; }
      for (const s of r.arr) {
        const one = parseRow(s);
        if (one) rows.push(one);
      }
      console.log("  第 " + p + " 页 " + r.arr.length + " 条，累计 " + rows.length);
      await sleep(350);
    }
  }
  await Promise.all(new Array(CONCURRENCY).fill(0).map(() => worker()));

  if (!rows.length) throw new Error("一条都没解析出来");

  const seen = new Set();
  const uniq = [];
  for (const r of rows) {
    if (seen.has(r.c)) continue;
    seen.add(r.c);
    uniq.push(r);
  }

  const pack = {
    v: 1,
    ts: Date.now(),
    total: total,
    count: uniq.length,
    pages: pages,
    mode: uniq.length >= total * 0.9 ? "full" : "partial",
    rows: uniq
  };
  const text = JSON.stringify(pack);
  fs.writeFileSync(path.join(OUT_DIR, "fundrank.json"), text);

  const noY1 = uniq.filter((r) => r.y1 == null).length;
  console.log(
    "OK fundrank.json " + (text.length / 1024).toFixed(0) + "KB  行数 " +
    uniq.length + " / " + total + "，无近1年 " + noY1
  );
  for (const s of uniq.slice(0, 3)) console.log("  " + JSON.stringify(s));
}

main().catch((e) => {
  console.error("FAIL fundrank: " + (e && e.message));
  process.exit(1);
});
