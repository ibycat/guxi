// 基金经理「姓名 → id」映射
//
// 为什么需要：funddetail.json 只给经理姓名（JJJL），而抓经理页要的是数字 id。
// 之前的 id 来自 fundmeta（爬 F10 概况页），那套又慢又要解析 HTML。
// 这里改用 /fundSearch?m=7 按姓名反查，约 3000 个姓名，几分钟跑完，
// 之后 fundmeta 就可以彻底下线。
//
// 同名经理不止一个人，所以记录里带「是否精确匹配」和「同名候选数」，
// 后续对不确定的可以人工核。
//
// 产物 mgrmap.json：{ map: {姓名: id}, rows: [{n, id, com, exact, dup}] }

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

function cleanName(s) {
  return String(s || "").replace(/\s+/g, "").trim();
}

async function searchMgr(name) {
  const url = BASE + "/fundSearch?m=7&key=" + encodeURIComponent(name);
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, {
        headers: { accept: "application/json", "user-agent": "guxi-snapshot/1.0" },
        signal: AbortSignal.timeout(20000)
      });
      if (!res.ok) { await sleep(400 * (i + 1)); continue; }
      const arr = await res.json();
      if (!Array.isArray(arr)) { await sleep(400 * (i + 1)); continue; }

      const exact = arr.filter((x) => cleanName(x.MgrName) === name);
      const pool = exact.length ? exact : arr;
      if (!pool.length) return { n: name, id: "", exact: false, dup: 0 };

      // 同名多人时取第一个，并记下候选数，便于后续排查
      const hit = pool[0];
      return {
        n: name,
        id: hit.MgrId || "",
        com: hit.JJGS || "",
        exact: exact.length > 0,
        dup: pool.length
      };
    } catch (e) {
      await sleep(400 * (i + 1));
    }
  }
  return { n: name, id: "", err: "failed" };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const detail = readJson("funddetail.json");
  if (!detail || !detail.rows || !detail.rows.length) throw new Error("没有 funddetail.json");

  // 从「A、B」这种多人串里拆出每个姓名
  const names = new Set();
  for (const r of detail.rows) {
    if (!r.jj) continue;
    for (const one of String(r.jj).split(/[、,，;；]/)) {
      const nm = cleanName(one);
      if (nm && nm.length <= 6) names.add(nm);
    }
  }
  console.log("[MAP] funddetail 覆盖 " + detail.count + " 只，去重后经理姓名 " + names.size + " 个");

  const oldMap = readJson("mgrmap.json");
  const have = new Map();
  for (const r of (oldMap && oldMap.rows) || []) if (r && r.n && r.id) have.set(r.n, r);

  const pending = [...names].filter((n) => !have.has(n));
  const limit = arg("limit", 4000);
  const todo = limit > 0 ? pending.slice(0, limit) : pending;
  console.log("[MAP] 已映射 " + have.size + "，本次查 " + todo.length);

  const rows = [];
  let idx = 0, ok = 0, exactCnt = 0;
  async function worker() {
    while (idx < todo.length) {
      const nm = todo[idx++];
      const rec = await searchMgr(nm);
      if (rec.id) { ok++; if (rec.exact) exactCnt++; }
      rows.push(rec);
      if (rows.length % 300 === 0) console.log("  已查 " + rows.length + "/" + todo.length + "，命中 " + ok);
      await sleep(50);
    }
  }
  await Promise.all(new Array(CONCURRENCY).fill(0).map(() => worker()));
  console.log("[MAP] 本批完成：命中 " + ok + " / " + rows.length + "（精确 " + exactCnt + "）");

  // 只把拿到 id 的写进缓存，失败的下一轮自动重试
  const merged = new Map(have);
  for (const r of rows) if (r.id) merged.set(r.n, r);

  const map = {};
  for (const [n, r] of merged) map[n] = r.id;

  const pack = {
    v: 1,
    ts: Date.now(),
    count: merged.size,
    totalNames: names.size,
    map: map,
    rows: [...merged.values()]
  };
  const text = JSON.stringify(pack);
  fs.writeFileSync(path.join(OUT_DIR, "mgrmap.json"), text);

  const sample = [...merged.values()].slice(0, 5);
  for (const s of sample) console.log("  " + JSON.stringify(s));
  console.log(
    "OK mgrmap.json " + (text.length / 1024).toFixed(0) + "KB  映射 " +
    merged.size + " / " + names.size
  );
}

main().catch((e) => {
  console.error("FAIL fundmgrmap: " + (e && e.message));
  process.exit(1);
});
