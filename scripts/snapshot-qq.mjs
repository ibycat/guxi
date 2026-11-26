// 快照兜底：东财 push2 对 GitHub Runner 的出口 IP 整体封禁（全程 302/502）时用它。
//
// 思路：只换「价格」这一个输入。
//   A 股：从上一份快照（v3 列式）拿代码/名称/行业/上市日/股息率，用腾讯行情补价格，
//         股息率按 旧值 × 旧价 / 新价 换算（dps 不变，所以是精确换算不是估算）。
//   港股：同上，只是 hk.json 是 v2 行式，价格在第 2 位、市值第 5 位、股息率第 7 位。
//
// 两个市场都只在「主脚本没产出该文件」时才跑，产物格式与原脚本一致，页面不用改。
//
// 用法：
//   SNAPSHOT_DIR=out PREV_DIR=prev node scripts/snapshot-qq.mjs
//   node scripts/snapshot-qq.mjs --prev ./_snaptest/a.json --out ./_snaptest/a-qq.json
//   node scripts/snapshot-qq.mjs --market hk --hk ./_snaptest/hk.json --out-hk ./_snaptest/hk-qq.json

import fs from "node:fs";
import path from "node:path";

const OUT_DIR = process.env.SNAPSHOT_DIR || "out";
const PREV_DIR = process.env.PREV_DIR || "prev";
const BATCH_A = 60;
const BATCH_HK = 50;
const CONC = 3;

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return def;
  return process.argv[i + 1] == null ? def : process.argv[i + 1];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findPrev(name, explicit) {
  if (explicit && fs.existsSync(explicit)) return explicit;
  for (const d of [PREV_DIR, OUT_DIR, "."]) {
    const p = path.join(d, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// A 股 6 位代码 → 腾讯前缀
function qqCodeA(c) {
  if (/^6/.test(c)) return "sh" + c;
  if (/^(0|3)/.test(c)) return "sz" + c;
  if (/^(4|8|9)/.test(c)) return "bj" + c;
  return "sh" + c;
}

async function fetchBatch(symbols) {
  const url = "https://qt.gtimg.cn/q=" + symbols.join(",");
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, {
        headers: { referer: "https://gu.qq.com/", "user-agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(15000)
      });
      if (!res.ok) throw new Error("http_" + res.status);
      // 腾讯返回 GBK，必须按 GBK 解，否则中文全是乱码
      const text = new TextDecoder("gbk").decode(await res.arrayBuffer());
      const out = new Map();
      for (const line of text.split(";")) {
        const m = line.match(/v_[a-z0-9_]+="([^"]*)"/);
        if (!m) continue;
        const f = m[1].split("~");
        if (f.length < 47) continue;
        const code = f[2];
        const price = parseFloat(f[3]);
        if (!code || !isFinite(price) || price <= 0) continue;
        out.set(code, {
          px: price,
          chg: parseFloat(f[32]) || 0,
          mc: (parseFloat(f[45]) || 0) * 1e8, // 腾讯给的是亿元
          name: f[1]
        });
      }
      return out;
    } catch (e) {
      if (i === 2) throw e;
      await sleep(600 * (i + 1));
    }
  }
  return new Map();
}

async function fetchAll(symbols, batchSize) {
  const quotes = new Map();
  const chunks = [];
  for (let i = 0; i < symbols.length; i += batchSize) chunks.push(symbols.slice(i, i + batchSize));
  let idx = 0, done = 0;
  async function worker() {
    while (idx < chunks.length) {
      const cur = chunks[idx++];
      const m = await fetchBatch(cur);
      for (const [k, v] of m) quotes.set(k, v);
      done++;
      if (done % 20 === 0) console.log("  已请求 " + done + "/" + chunks.length + " 批，命中 " + quotes.size);
      await sleep(80);
    }
  }
  await Promise.all(Array.from({ length: CONC }, () => worker()));
  return quotes;
}

/* ------------------------------ A 股 ------------------------------ */

async function runA() {
  const prevPath = findPrev("a.json", arg("prev", ""));
  if (!prevPath) throw new Error("找不到上一份 a.json");
  const prev = JSON.parse(fs.readFileSync(prevPath, "utf8"));
  if (prev.v !== 3 || !prev.code) throw new Error("上一份 a.json 不是 v3 列式");

  const codes = String(prev.code).split("|");
  console.log("[QQ-A] 基准 " + prevPath + "，" + codes.length + " 只");

  const quotes = await fetchAll(codes.map(qqCodeA), BATCH_A);
  console.log("[QQ-A] 腾讯行情命中 " + quotes.size + " / " + codes.length);
  if (quotes.size < codes.length * 0.6) {
    throw new Error("腾讯命中率过低：" + quotes.size + "/" + codes.length);
  }

  const px = [], chg = [], pe = [], pb = [], mc = [];
  let hit = 0, kept = 0;
  for (let i = 0; i < codes.length; i++) {
    const q = quotes.get(codes[i]);
    if (!q) {
      // 停牌或不在腾讯列表：原样保留
      px.push(prev.px[i]); chg.push(prev.chg[i]); pe.push(prev.pe[i]); pb.push(prev.pb[i]); mc.push(prev.mc[i]);
      kept++;
      continue;
    }
    hit++;
    px.push(q.px);
    chg.push(q.chg);
    pe.push(prev.pe[i]); // 腾讯也有 PE/PB，但口径是动态的，与东财不一致，沿用旧值更稳
    pb.push(prev.pb[i]);
    mc.push(q.mc > 0 ? Math.round(q.mc / 1e8) : prev.mc[i]); // 快照里市值单位是亿元
  }

  // 股息率按价格比例换算：dps 不变 → 新比率 = 旧比率 × 旧价 / 新价
  const t = [], l = [], a3 = [];
  for (let i = 0; i < codes.length; i++) {
    const k = prev.px[i] > 0 && px[i] > 0 ? prev.px[i] / px[i] : 1;
    t.push(Math.round((prev.t[i] || 0) * k));
    l.push(Math.round((prev.l[i] || 0) * k));
    a3.push(Math.round((prev.a3[i] || 0) * k));
  }

  const pack = {
    v: 3,
    ts: Date.now(),
    market: "a",
    years: prev.years,
    asof: new Date().toISOString().slice(0, 10),
    partial: "qq",
    inds: prev.inds,
    code: prev.code,
    name: prev.name,
    px, chg, pe, pb, mc,
    ind: prev.ind,
    ld: prev.ld,
    t, l, a3,
    po: prev.po,
    cs: prev.cs,
    ys: prev.ys,
    fl: prev.fl
  };

  const outPath = arg("out", path.join(OUT_DIR, "a.json"));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(pack));
  const moved = codes.filter((c, i) => quotes.get(c) && quotes.get(c).px !== prev.px[i]).length;
  console.log("[QQ-A] 写出 " + outPath + "，" + codes.length + " 只（更新 " + hit + "，价格变动 " + moved + "，无行情保留 " + kept + "）");
}

/* ------------------------------ 港股 ------------------------------ */

async function runHK() {
  const prevPath = findPrev("hk.json", arg("hk", ""));
  if (!prevPath) throw new Error("找不到上一份 hk.json");
  const prev = JSON.parse(fs.readFileSync(prevPath, "utf8"));
  if (!Array.isArray(prev.rows) || !prev.rows.length) throw new Error("上一份 hk.json 没有 rows");

  const rows = prev.rows;
  console.log("[QQ-HK] 基准 " + prevPath + "，" + rows.length + " 只");

  const quotes = await fetchAll(rows.map((r) => "r_hk" + r[0]), BATCH_HK);
  console.log("[QQ-HK] 腾讯行情命中 " + quotes.size + " / " + rows.length);
  if (quotes.size < rows.length * 0.6) {
    throw new Error("腾讯港股命中率过低：" + quotes.size + "/" + rows.length);
  }

  let moved = 0, kept = 0;
  const out = rows.map((r) => {
    const q = quotes.get(r[0]);
    const row = r.slice();
    if (!q) { kept++; return row; }
    const oldPx = r[2], newPx = q.px;
    if (oldPx !== newPx) moved++;
    const k = oldPx > 0 && newPx > 0 ? oldPx / newPx : 1;
    row[2] = newPx;                            // 价格
    row[3] = q.chg;                            // 涨跌幅
    if (q.mc > 0) row[5] = Math.round(q.mc);   // 市值（元）
    // 股息率存的是 ×1e6 的比率
    row[7] = Math.round((r[7] || 0) * k);
    row[8] = Math.round((r[8] || 0) * k);
    row[9] = Math.round((r[9] || 0) * k);
    return row;
  });

  const pack = {
    v: prev.v || 2,
    ts: Date.now(),
    market: "hk",
    years: prev.years,
    asof: new Date().toISOString().slice(0, 10),
    partial: "qq",
    rows: out
  };

  const outPath = arg("out-hk", path.join(OUT_DIR, "hk.json"));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(pack));
  console.log("[QQ-HK] 写出 " + outPath + "，" + out.length + " 只（价格变动 " + moved + "，无行情保留 " + kept + "）");
}

/* ------------------------------ 入口 ------------------------------ */

async function main() {
  const market = arg("market", "both");
  let ok = 0, fail = 0;
  if (market === "a" || market === "both") {
    try { await runA(); ok++; } catch (e) { console.error("FAIL a: " + (e && e.message)); fail++; }
  }
  if (market === "hk" || market === "both") {
    try { await runHK(); ok++; } catch (e) { console.error("FAIL hk: " + (e && e.message)); fail++; }
  }
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error("FAIL snapshot-qq: " + (e && e.message));
  process.exit(1);
});
