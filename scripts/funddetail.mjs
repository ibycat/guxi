// 基金详情批量抓取（第三方 API 版）
//
// 接口：http://60.204.219.84:5000/fundMNDetailInformation?FCODE=xxx
// 一次返回：FULLNAME（全称）、JJJL（经理）、ESTABDATE（成立日）、
//          ENDNAV（规模，元）、PERFCMP/BENCH（业绩基准）、INDEXNAME（跟踪指数）
//
// 比抓 F10 概况页强的地方：
//   1) 是 JSON，不用正则啃 HTML，页面改版也不会崩；
//   2) 一个请求把「合并份额用的全称」和「经理/成立日/主题」全给了。
//
// 产物 funddetail.json：
//   c 代码 / full 全称 / nm 简称 / t 类型 / est 成立日 / s 规模(亿)
//   jj 经理（原名，多人用、分隔）/ jjn 经理人数 / bench 业绩基准 / idx 跟踪指数
//   gs 同全称合并后的规模(亿) / gn 同全称的份额数
//
// 用法：node scripts/funddetail.mjs --limit 200    先小批量验证
//      node scripts/funddetail.mjs                 增量跑（默认每批 8000）

import fs from "node:fs";
import path from "node:path";

const BASE = "http://60.204.219.84:5000";
const OUT_DIR = process.env.SNAPSHOT_DIR || "data";
const CONCURRENCY = 5;

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v == null ? def : Number(v);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJson(f) {
  try { return JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), "utf8")); } catch (e) { return null; }
}

function num(v) {
  const x = parseFloat(v);
  return Number.isFinite(x) ? x : null;
}

function clean(v) {
  if (v == null) return "";
  const s = String(v).trim();
  return s === "--" || s === "-" || s === "—" ? "" : s;
}

async function fetchOne(code) {
  const url = BASE + "/fundMNDetailInformation?FCODE=" + code;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, {
        headers: { accept: "application/json", "user-agent": "guxi-snapshot/1.0" },
        signal: AbortSignal.timeout(20000)
      });
      if (!res.ok) { await sleep(400 * (i + 1)); continue; }
      const j = await res.json();
      const d = j && j.Datas;
      if (!d || !d.FCODE) { await sleep(400 * (i + 1)); continue; }

      const navRaw = num(d.ENDNAV);
      const jj = clean(d.JJJL);
      const jjn = jj ? jj.split(/[、,，;；]/).map((x) => x.trim()).filter(Boolean).length : 0;

      return {
        c: d.FCODE,
        full: clean(d.FULLNAME),
        nm: clean(d.SHORTNAME),
        t: clean(d.FTYPE),
        est: clean(d.ESTABDATE),
        s: navRaw == null ? null : Math.round(navRaw / 1e6) / 100,
        jj: jj,
        jjn: jjn,
        bench: clean(d.PERFCMP || d.BENCH).slice(0, 100),
        idx: clean(d.INDEXNAME)
      };
    } catch (e) {
      await sleep(400 * (i + 1));
    }
  }
  return { c: code, err: "failed" };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 代码来源：优先用刚拉下来的排行（覆盖全市场），没有就退回旧快照
  const rank = readJson("fundrank.json");
  const base = readJson("fund.json");
  const codes = rank && rank.rows && rank.rows.length
    ? rank.rows.map((r) => r.c).filter(Boolean)
    : ((base && base.rows) || []).map((r) => r.c).filter(Boolean);
  if (!codes.length) throw new Error("没有可用的基金代码列表");

  const old = readJson("funddetail.json");
  const have = new Map();
  for (const r of (old && old.rows) || []) if (r && r.c && !r.err) have.set(r.c, r);

  const pending = codes.filter((c) => !have.has(c));
  const limit = arg("limit", 8000);
  const todo = limit > 0 ? pending.slice(0, limit) : pending;

  console.log(
    "[DETAIL] 代码 " + codes.length + " 只，已覆盖 " + have.size + "，本次抓 " + todo.length
  );

  const rows = [];
  let idx = 0, ok = 0;
  async function worker() {
    while (idx < todo.length) {
      const code = todo[idx++];
      const rec = await fetchOne(code);
      if (!rec.err) ok++;
      rows.push(rec);
      if (rows.length % 500 === 0) {
        console.log("  进度 " + rows.length + "/" + todo.length + "，成功 " + ok);
      }
      await sleep(60);
    }
  }
  await Promise.all(new Array(CONCURRENCY).fill(0).map(() => worker()));
  console.log("[DETAIL] 本批完成：成功 " + ok + " / " + rows.length);

  // 合并历史（失败的不写入，下次自动重试）
  const merged = new Map(have);
  for (const r of rows) if (!r.err) merged.set(r.c, r);
  const allRows = [...merged.values()];

  // 按基金全称合并份额规模 —— 必须基于全量已抓记录算
  const sum = new Map();
  const cnt = new Map();
  for (const r of allRows) {
    if (!r.full) continue;
    cnt.set(r.full, (cnt.get(r.full) || 0) + 1);
    if (r.s == null) continue;
    sum.set(r.full, (sum.get(r.full) || 0) + r.s);
  }
  for (const r of allRows) {
    r.gs = r.full && r.s != null ? Math.round(sum.get(r.full) * 100) / 100 : null;
    r.gn = r.full ? cnt.get(r.full) : 0;
  }

  // 自检：本批关键字段空值率
  const batch = rows.filter((r) => !r.err);
  const tot = batch.length || 1;
  const miss = (f) => batch.filter((r) => r[f] == null || r[f] === "").length;
  console.log(
    "[DETAIL] 本批空值率：全称 " + ((miss("full") / tot) * 100).toFixed(1) + "%" +
    " / 规模 " + ((miss("s") / tot) * 100).toFixed(1) + "%" +
    " / 经理 " + ((miss("jj") / tot) * 100).toFixed(1) + "%" +
    " / 成立日 " + ((miss("est") / tot) * 100).toFixed(1) + "%"
  );
  for (const s of batch.slice(0, 3)) console.log("  " + JSON.stringify(s));

  if (!allRows.length) throw new Error("一条都没抓成功");

  const pack = {
    v: 1,
    ts: Date.now(),
    total: codes.length,
    count: allRows.length,
    mode: allRows.length >= codes.length ? "full" : "partial",
    rows: allRows
  };
  const text = JSON.stringify(pack);
  fs.writeFileSync(path.join(OUT_DIR, "funddetail.json"), text);
  console.log(
    "OK funddetail.json " + (text.length / 1024).toFixed(0) + "KB  覆盖 " +
    allRows.length + " / " + codes.length
  );
}

main().catch((e) => {
  console.error("FAIL funddetail: " + (e && e.message));
  process.exit(1);
});
