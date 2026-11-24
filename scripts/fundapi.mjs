// 第三方天天基金 API 探测脚本
//
// 目标机 http://60.204.219.84:5000 是纯 HTTP，浏览器/WebFetch 都会被强制升级到 HTTPS，
// 所以统一放到 GitHub Actions 里拉（Node fetch 没有这个限制）。
// 本脚本只负责「把原始返回打下来」，产物 fundapi_probe.json 用于确认字段结构，
// 确认后再写正式的解析逻辑。
//
// 用法：node scripts/fundapi.mjs

import fs from "node:fs";
import path from "node:path";

const BASE = "http://60.204.219.84:5000";
const OUT_DIR = process.env.SNAPSHOT_DIR || "data";

const TARGETS = [
  ["rank_all", "/fundMNRank?FundType=0&SortColumn=SYL_1N&Sort=desc&pageIndex=1&pageSize=30"],
  ["rank_scale", "/fundMNRank?FundType=0&SortColumn=ENDNAV&Sort=desc&pageIndex=1&pageSize=30"],
  ["detail", "/fundMNDetailInformation?FCODE=003834"],
  ["intro", "/fundMNStopWatch?FCODE=003834"],
  ["search", "/fundSearch?m=1&key=11"],
  ["company", "/fundCompanyBaseList"],
  ["subject", "/fundMNSubjectList"]
];

function shape(v, depth) {
  if (depth > 2) return typeof v;
  if (Array.isArray(v)) return v.length ? [shape(v[0], depth + 1) + " ×" + v.length] : [];
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v).slice(0, 40)) o[k] = shape(v[k], depth + 1);
    return o;
  }
  return v === null ? "null" : typeof v;
}

async function probe(name, p) {
  const url = BASE + p;
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json,*/*", "user-agent": "guxi-snapshot/1.0" },
      signal: AbortSignal.timeout(30000)
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
    console.log("[" + name + "] " + res.status + " " + text.length + "B " + (Date.now() - t0) + "ms JSON=" + !!json);
    return {
      name,
      path: p,
      status: res.status,
      bytes: text.length,
      ms: Date.now() - t0,
      isJson: !!json,
      shape: json ? shape(json, 0) : null,
      // 原始片段：非 JSON 时靠它看出返回的是什么
      raw: text.slice(0, 2500)
    };
  } catch (e) {
    console.log("[" + name + "] FAIL " + (e && e.message));
    return { name, path: p, error: String(e && e.message), ms: Date.now() - t0 };
  }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = [];
  for (const [name, p] of TARGETS) {
    out.push(await probe(name, p));
    await new Promise((r) => setTimeout(r, 300));
  }
  const alive = out.filter((o) => o.status === 200 && o.isJson).length;
  console.log("OK 可达接口 " + alive + " / " + out.length);

  const pack = { v: 1, ts: Date.now(), base: BASE, reachable: alive, probes: out };
  const text = JSON.stringify(pack);
  fs.writeFileSync(path.join(OUT_DIR, "fundapi_probe.json"), text);
  console.log("OK fundapi_probe.json " + (text.length / 1024).toFixed(0) + "KB");

  // 一个都不通就报错，避免把废文件推到 data 分支
  if (!alive) throw new Error("所有接口都不可达");
}

main().catch((e) => {
  console.error("FAIL fundapi: " + (e && e.message));
  process.exit(1);
});
