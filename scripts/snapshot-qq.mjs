// A 股快照兜底：东财 push2 对 GitHub Runner 的出口 IP 整体封禁（全程 502）时用它。
//
// 思路：只换「价格」这一个输入。
//   1. 从上一份快照（v3 列式）拿代码、名称、行业、上市日期、分红率、连分年数、标记；
//   2. 用腾讯行情批量接口（qt.gtimg.cn，60 只一批）拿最新价、涨跌幅、PE、PB、总市值；
//   3. 股息率按价格比例换算：dps 不变，所以 新股息率 = 旧股息率 × 旧价 / 新价。
//      这样不用重抓分红（分红走的是 datacenter 接口，没被封，但重抓要多花一分半）。
//
// 产物格式与 snapshot.mjs 的 a.json 完全一致（v3），页面不用改。
//
// 用法：
//   PREV_DIR=prev SNAPSHOT_DIR=out node scripts/snapshot-qq.mjs
//   node scripts/snapshot-qq.mjs --prev ./_snaptest/a.json --out ./_snaptest/a-qq.json

import fs from "node:fs";
import path from "node:path";

const OUT_DIR = process.env.SNAPSHOT_DIR || "out";
const PREV_DIR = process.env.PREV_DIR || "prev";
const BATCH = 60;
const CONC = 3;

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return def;
  return process.argv[i + 1] == null ? def : process.argv[i + 1];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findPrev() {
  const direct = arg("prev", "");
  if (direct && fs.existsSync(direct)) return direct;
  for (const d of [PREV_DIR, OUT_DIR, "."]) {
    const p = path.join(d, "a.json");
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// 6 位代码 → 腾讯前缀
function qqCode(c) {
  if (/^6/.test(c)) return "sh" + c;
  if (/^(0|3)/.test(c)) return "sz" + c;
  if (/^(4|8|9)/.test(c)) return "bj" + c;
  return "sh" + c;
}

// 腾讯返回 GBK 编码，必须按 GBK 解，否则中文全是乱码
async function fetchBatch(codes) {
  const q = codes.map(qqCode).join(",");
  const url = "https://qt.gtimg.cn/q=" + q;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, {
        headers: { referer: "https://gu.qq.com/", "user-agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(15000)
      });
      if (!res.ok) throw new Error("http_" + res.status);
      const buf = await res.arrayBuffer();
      const text = new TextDecoder("gbk").decode(buf);
      const out = new Map();
      for (const line of text.split(";")) {
        const m = line.match(/v_[a-z]{2}\d{6}="([^"]*)"/);
        if (!m) continue;
        const f = m[1].split("~");
        if (f.length < 47) continue;
        const code = f[2];
        const price = parseFloat(f[3]);
        if (!code || !isFinite(price) || price <= 0) continue;
        out.set(code, {
          px: price,
          chg: parseFloat(f[32]) || 0,
          pe: parseFloat(f[39]) || 0,
          pb: parseFloat(f[46]) || 0,
          mc: parseFloat(f[45]) || 0, // 亿元
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

async function main() {
  const prevPath = findPrev();
  if (!prevPath) throw new Error("找不到上一份 a.json，无法兜底");
  console.log("[QQ] 基准快照 " + prevPath);

  const prev = JSON.parse(fs.readFileSync(prevPath, "utf8"));
  if (prev.v !== 3 || !prev.code) throw new Error("上一份快照不是 v3 列式，无法兜底");

  const codes = String(prev.code).split("|");
  const nameStr = String(prev.name).split("|");
  console.log("[QQ] 需要补价格 " + codes.length + " 只");

  const quotes = new Map();
  const chunks = [];
  for (let i = 0; i < codes.length; i += BATCH) chunks.push(codes.slice(i, i + BATCH));

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
  console.log("[QQ] 腾讯行情命中 " + quotes.size + " / " + codes.length);

  if (quotes.size < codes.length * 0.6) {
    throw new Error("腾讯行情命中率过低：" + quotes.size + "/" + codes.length);
  }

  const px = [], chg = [], pe = [], pb = [], mc = [];
  let updated = 0, kept = 0, suspended = 0;

  for (let i = 0; i < codes.length; i++) {
    const q = quotes.get(codes[i]);
    const oldPx = prev.px[i];
    if (!q) {
      // 停牌或代码不在腾讯列表：原样保留，价格不动
      px.push(oldPx); chg.push(prev.chg[i]); pe.push(prev.pe[i]); pb.push(prev.pb[i]); mc.push(prev.mc[i]);
      kept++;
      continue;
    }
    if (q.px === oldPx) suspended++;
    updated++;
    px.push(q.px);
    chg.push(q.chg);
    pe.push(q.pe || prev.pe[i]);
    pb.push(q.pb || prev.pb[i]);
    mc.push(q.mc || prev.mc[i]);
  }

  // 股息率按价格比例换算：dps 不变 → 新比率 = 旧比率 × 旧价 / 新价
  const t = [], l = [], a3 = [];
  for (let i = 0; i < codes.length; i++) {
    const oldPx = prev.px[i], newPx = px[i];
    const k = oldPx > 0 && newPx > 0 ? oldPx / newPx : 1;
    t.push(Math.round((prev.t[i] || 0) * k));
    l.push(Math.round((prev.l[i] || 0) * k));
    a3.push(Math.round((prev.a3[i] || 0) * k));
  }

  const now = new Date();
  const asof = prev.asof || now.toISOString().slice(0, 10);

  const pack = {
    v: 3,
    ts: Date.now(),
    market: "a",
    years: prev.years,
    asof,
    // 标记来源：页面看到 partial 会提示「部分分页未取到」，这里换成兜底说明
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
  console.log(
    "[QQ] 写出 " + outPath + "  " + (JSON.stringify(pack).length / 1024).toFixed(0) + "KB  " +
    codes.length + " 只（更新 " + updated + "，价格变动 " + moved + "，停牌同价 " + suspended + "，无行情保留 " + kept + "）"
  );
  for (let i = 0; i < Math.min(3, codes.length); i++) {
    console.log("  " + codes[i] + " " + nameStr[i] + " " + prev.px[i] + " → " + px[i] +
      " 股息率 " + (prev.t[i] / 1e4 * 100).toFixed(2) + "% → " + (t[i] / 1e4 * 100).toFixed(2) + "%");
  }
}

main().catch((e) => {
  console.error("FAIL snapshot-qq: " + (e && e.message));
  process.exit(1);
});
