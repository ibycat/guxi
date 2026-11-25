// 补齐 fundmgr 里缺失的基金（按基金维度反查经理）
//
// 背景：fundmgr 是「经理页 → 在管基金列表」反向汇总出来的，所以
// 经理没被覆盖到的基金（新人、新基金、姓名映射没命中）就成了空洞。
// 这批空洞用 /fundMNMangerList?FCODE=基金代码 直接按基金补：
//   一次返回该基金现任经理、管理天数 DAYS、起始日 FEMPDATE。
// 在管规模这个接口没有，所以再用经理 id 去 managers.json 里查；
// 查不到的少数新经理，用 /fundMSNMangerInfo 补一次（有上限）。
//
// 产物：覆盖写回 fundmgr.json（保留原有条目），顺带补 managers.json。

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

function clean(v) {
  if (v == null) return "";
  const s = String(v).trim();
  return s === "--" || s === "-" ? "" : s;
}

async function getJson(p) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(BASE + p, {
        headers: { accept: "application/json", "user-agent": "guxi-snapshot/1.0" },
        signal: AbortSignal.timeout(20000)
      });
      if (!res.ok) { await sleep(350 * (i + 1)); continue; }
      return await res.json();
    } catch (e) {
      await sleep(350 * (i + 1));
    }
  }
  return null;
}

// 一只基金的现任经理与任职天数
async function fundManagers(code) {
  const j = await getJson("/fundMNMangerList?FCODE=" + code);
  // Datas 正常是数组，个别情况下会包成单个对象，都要兼容
  let arr = [];
  if (j && Array.isArray(j.Datas)) arr = j.Datas;
  else if (j && j.Datas && typeof j.Datas === "object" && j.Datas.MGRID) arr = [j.Datas];
  if (!arr.length) return null;

  // 优先取「未离任」那条（LEMPDATE 为空或 --）
  const cur = arr.filter((x) => !clean(x.LEMPDATE));
  const row = (cur.length ? cur : arr)[0];

  const ids = clean(row.MGRID).split(",").map((s) => s.trim()).filter(Boolean);
  const names = clean(row.MGRNAME).split(",").map((s) => s.trim()).filter(Boolean);
  const office = clean(row.ISINOFFICE).split(",");
  // ISINOFFICE 为 1 表示在职，只数在职的
  let n = 0;
  for (let i = 0; i < ids.length; i++) {
    if (office.length <= i || office[i] === "1" || office[i] === "") n++;
  }

  const days = parseInt(clean(row.DAYS), 10);
  return {
    d: isFinite(days) && days > 0 ? days : null,
    n: n || ids.length,
    ids,
    names,
    since: clean(row.FEMPDATE)
  };
}

// 经理级：在管规模
async function managerAum(id) {
  const j = await getJson("/fundMSNMangerInfo?FCODE=" + id);
  const d = j && j.Datas;
  if (!d) return null;
  const nav = parseFloat(d.NETNAV);
  return {
    id,
    n: clean(d.MGRNAME),
    aum: isFinite(nav) ? Math.round(nav / 1e6) / 100 : null,
    y: parseInt(clean(d.TOTALDAYS), 10) || null
  };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const detail = readJson("funddetail.json");
  const fm = readJson("fundmgr.json");
  if (!detail || !detail.rows) throw new Error("没有 funddetail.json");
  if (!fm || !fm.rows) throw new Error("没有 fundmgr.json");

  const rows = fm.rows;
  const codes = detail.rows.map((r) => r.c).filter(Boolean);
  const missing = codes.filter((c) => !rows[c] || rows[c].d == null);
  const limit = arg("limit", 0);
  const todo = limit > 0 ? missing.slice(0, limit) : missing;

  console.log("[FILL] 基金 " + codes.length + " 只，已有任职 " + (codes.length - missing.length) + "，待补 " + missing.length + "，本次 " + todo.length);

  // 第一阶段：按基金补任职
  const found = [];
  let idx = 0, ok = 0;
  async function worker() {
    while (idx < todo.length) {
      const c = todo[idx++];
      const r = await fundManagers(c);
      if (r) { ok++; found.push({ c, ...r }); }
      if (found.length % 200 === 0 && found.length) console.log("  已补 " + found.length + " / " + todo.length);
      await sleep(60);
    }
  }
  await Promise.all(new Array(CONCURRENCY).fill(0).map(() => worker()));
  console.log("[FILL] 任职补齐 " + ok + " / " + todo.length);

  // 第二阶段：查在管规模，先看已有缓存
  const mgrCache = readJson("managers.json");
  const known = new Map();
  for (const m of (mgrCache && mgrCache.rows) || []) if (m && m.id) known.set(m.id, m);

  const needIds = new Set();
  for (const f of found) for (const id of f.ids) if (!known.has(id)) needIds.add(id);
  const idList = [...needIds].slice(0, arg("mgrcap", 1200));
  console.log("[FILL] 需要补查的经理 " + needIds.size + " 位，本次查 " + idList.length);

  const newMgrs = [];
  let mi = 0;
  async function mgrWorker() {
    while (mi < idList.length) {
      const id = idList[mi++];
      const m = await managerAum(id);
      if (m) { newMgrs.push(m); known.set(id, m); }
      await sleep(60);
    }
  }
  await Promise.all(new Array(CONCURRENCY).fill(0).map(() => mgrWorker()));
  console.log("[FILL] 经理补查 " + newMgrs.length + " 位");

  // 写回基金维度
  let added = 0;
  for (const f of found) {
    let best = 0;
    for (const id of f.ids) {
      const m = known.get(id);
      if (m && typeof m.aum === "number" && m.aum > best) best = m.aum;
    }
    rows[f.c] = { d: f.d, a: best > 0 ? best : null, n: f.n };
    added++;
  }

  const ftext = JSON.stringify({ v: 1, ts: Date.now(), count: Object.keys(rows).length, rows });
  fs.writeFileSync(path.join(OUT_DIR, "fundmgr.json"), ftext);

  // 顺带把新查到的经理合并回 managers.json
  if (newMgrs.length) {
    const merged = new Map();
    for (const m of (mgrCache && mgrCache.rows) || []) if (m && m.id) merged.set(m.id, m);
    for (const m of newMgrs) {
      const old = merged.get(m.id) || {};
      merged.set(m.id, {
        id: m.id,
        n: m.n || old.n || "",
        y: m.y || old.y || null,
        ys: old.ys || "",
        aum: m.aum != null ? m.aum : (old.aum != null ? old.aum : null),
        // 这里不重建 funds 列表，保持原缓存；fundmgr 只用到 aum 与 y
        funds: old.funds || []
      });
    }
    const ar = [...merged.values()];
    fs.writeFileSync(
      path.join(OUT_DIR, "managers.json"),
      JSON.stringify({ v: 1, ts: Date.now(), count: ar.length, rows: ar })
    );
    console.log("OK managers.json 合并后 " + ar.length + " 位");
  }

  // 覆盖率自检
  const withD = codes.filter((c) => rows[c] && rows[c].d != null).length;
  const withA = codes.filter((c) => rows[c] && rows[c].a != null).length;
  console.log(
    "OK fundmgr.json 写回 " + added + " 只，总条目 " + Object.keys(rows).length +
    "；有任职 " + withD + "/" + codes.length + "（" + ((withD / codes.length) * 100).toFixed(1) + "%）" +
    "，有在管规模 " + withA + "（" + ((withA / codes.length) * 100).toFixed(1) + "%）"
  );
}

main().catch((e) => {
  console.error("FAIL fundmgrfill: " + (e && e.message));
  process.exit(1);
});
