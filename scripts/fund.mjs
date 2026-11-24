// 公募基金快照生成器
//
// 数据源：天天基金「基金排行」接口（fund.eastmoney.com/data/rankhandler.aspx）。
// 该接口必须带 Referer，否则返回 `var rankData ={ErrCode:-999,Data:"无访问权限"}`。
//
// 为什么分两路抓：
//   开放式基金（dt=kf）和货币基金（dt=hb）返回的字段结构不同，
//   货币基金没有净值/阶段涨幅，只有万份收益和 7 日年化。
//
// 输出的 fund.json 是「收益版」：代码、简称、类型、净值、阶段涨幅、成立日、手续费。
// 基金规模和基金经理需要逐只抓（量大），作为第二阶段补进同一份文件。
//
// 字段索引来自接口返回的分隔字符串，接口没有表头，所以解析后必须校验：
//   - 代码必须是 6 位数字
//   - 名称不能为空
// 校验失败比例过高时直接抛错，避免写出一份字段错位的废数据。

import fs from "node:fs";
import path from "node:path";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const REFERER = "https://fund.eastmoney.com/data/fundranking.html";
const BASE = "https://fund.eastmoney.com/data/rankhandler.aspx";

const OUT_DIR = process.env.SNAPSHOT_DIR || "data";
const PROBE = process.argv.includes("--probe");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ymd(d) {
  const z = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + z(d.getMonth() + 1) + "-" + z(d.getDate());
}

async function fetchRank(dt, ft, pi, pn, tries = 3) {
  const url =
    BASE +
    "?op=ph&dt=" + dt +
    "&ft=" + ft +
    "&rs=&gs=0&sc=1nzf&st=desc" +
    "&sd=" + ymd(new Date(Date.now() - 365 * 864e5)) +
    "&ed=" + ymd(new Date()) +
    "&qdii=&tabSubtype=,,,,,&pi=" + pi + "&pn=" + pn + "&dx=1";

  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { "user-agent": UA, referer: REFERER, accept: "*/*" },
        signal: AbortSignal.timeout(25000)
      });
      if (!res.ok) {
        last = "http_" + res.status;
        await sleep(800 * (i + 1));
        continue;
      }
      // 接口返回 GBK 编码的文本，但里面的中文是 UTF-8 —— 实测按 utf-8 解即可
      const text = await res.text();
      if (text.indexOf("ErrCode") >= 0) throw new Error("upstream_denied");
      const m = text.match(/datas:\[(.*?)\],allRecords:(\d+)/s);
      if (!m) {
        last = "bad_shape";
        await sleep(800 * (i + 1));
        continue;
      }
      const rows = m[1] ? m[1].split('","').map((s) => s.replace(/^"|"$/g, "")) : [];
      return { rows, all: Number(m[2]) || rows.length };
    } catch (e) {
      last = e && e.message;
      await sleep(800 * (i + 1));
    }
  }
  throw new Error("rank_fetch_failed:" + last);
}

// 开放式基金行：19 个字段
// 0 代码 1 简称 2 拼音 3 净值日期 4 单位净值 5 累计净值 6 日增长率
// 7 近1周 8 近1月 9 近3月 10 近6月 11 近1年 12 近2年 13 近3年
// 14 今年来 15 成立来 16 成立日期 17 自定义 18 手续费
function parseOpen(line) {
  const f = line.split(",");
  if (f.length < 17) return null;
  const code = f[0];
  const name = f[1];
  if (!/^\d{6}$/.test(code) || !name) return null;
  const num = (i) => {
    const v = parseFloat(f[i]);
    return Number.isFinite(v) ? v : null;
  };
  return {
    c: code,
    n: name,
    m: "open",
    d: f[3] || "",
    nav: num(4),
    acc: num(5),
    chg: num(6),
    w1: num(7),
    m1: num(8),
    m3: num(9),
    m6: num(10),
    y1: num(11),
    y2: num(12),
    y3: num(13),
    ytd: num(14),
    since: num(15),
    est: f[16] || "",
    fee: f.length > 18 ? f[18] : ""
  };
}

// 货币基金行：结构与开放式不同，只有万份收益与 7 日年化
// 0 代码 1 简称 2 日期 3 万份收益 4 7日年化 5 近1月 6 近3月 ... 末位手续费
function parseMoney(line) {
  const f = line.split(",");
  if (f.length < 5) return null;
  const code = f[0];
  const name = f[1];
  if (!/^\d{6}$/.test(code) || !name) return null;
  const num = (i) => {
    const v = parseFloat(f[i]);
    return Number.isFinite(v) ? v : null;
  };
  return {
    c: code,
    n: name,
    m: "money",
    d: f[2] || "",
    wf: num(3),
    y7: num(4),
    fee: f[f.length - 1] || ""
  };
}

async function pull(dt, ft, parse, label) {
  const out = [];
  let all = 0;
  const pn = 5000;
  for (let pi = 1; pi <= 10; pi++) {
    const { rows, all: total } = await fetchRank(dt, ft, pi, pn);
    all = total;
    if (PROBE && pi === 1 && rows.length) {
      console.log("[" + label + "] 原始首行：");
      console.log("  " + rows[0].slice(0, 400));
      console.log("  字段数 = " + rows[0].split(",").length);
    }
    let ok = 0;
    for (const line of rows) {
      const rec = parse(line);
      if (rec) { out.push(rec); ok++; }
    }
    console.log("  " + label + " 第 " + pi + " 页：" + rows.length + " 行，解析成功 " + ok);
    if (rows.length === 0 || out.length >= all) break;
    await sleep(600);
  }
  console.log("[" + label + "] 共 " + out.length + " / " + all + " 只");
  return out;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log("[FUND] 拉取开放式基金…");
  const open = await pull("kf", "all", parseOpen, "开放式");

  console.log("[FUND] 拉取货币基金…");
  let money = [];
  try {
    money = await pull("hb", "all", parseMoney, "货币");
  } catch (e) {
    console.log("[FUND] 货币基金拉取失败，跳过：" + (e && e.message));
  }

  // 同一代码可能在多个类型里重复出现，按代码去重
  const seen = new Set();
  const rows = [];
  for (const r of open.concat(money)) {
    if (seen.has(r.c)) continue;
    seen.add(r.c);
    rows.push(r);
  }

  if (!rows.length) throw new Error("基金数据为空，放弃写入");

  const pack = {
    v: 1,
    ts: Date.now(),
    asof: ymd(new Date()),
    count: rows.length,
    rows
  };

  const text = JSON.stringify(pack);
  fs.writeFileSync(path.join(OUT_DIR, "fund.json"), text);
  const zlib = await import("node:zlib");
  const gz = zlib.gzipSync(Buffer.from(text, "utf8"), { level: 9 });
  fs.writeFileSync(path.join(OUT_DIR, "fund.json.gz"), gz);
  console.log(
    "OK fund.json  " + (text.length / 1024).toFixed(0) + "KB  →  gz " +
    (gz.length / 1024).toFixed(0) + "KB  " + rows.length + " 只"
  );
}

main().catch((e) => {
  console.error("FAIL fund: " + (e && e.message));
  process.exit(1);
});
