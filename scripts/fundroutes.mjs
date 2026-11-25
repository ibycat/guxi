// 探测第三方 API 的路由清单
//
// 目的：确认有没有「批量经理」接口（一次返回多位经理的在管规模/从业年限），
// 如果有，经理覆盖就不用几千次逐页抓，一天就能铺满。
// 文档站只展示了部分章节，这里的 /openapi.json 能直接给出全部路由和参数。

import fs from "node:fs";
import path from "node:path";

const BASE = "http://60.204.219.84:5000";
const OUT_DIR = process.env.SNAPSHOT_DIR || "data";

async function hit(p) {
  const t0 = Date.now();
  try {
    const res = await fetch(BASE + p, {
      headers: { accept: "application/json,text/html,*/*", "user-agent": "guxi-snapshot/1.0" },
      signal: AbortSignal.timeout(20000)
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}
    return { p, status: res.status, bytes: text.length, json, text, ms: Date.now() - t0 };
  } catch (e) {
    return { p, error: String((e && e.message) || e) };
  }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 0) 文档正文 40KB，抓取工具会截断，干脆在这里把经理那一章切出来
  try {
    const docUrl = "https://raw.githubusercontent.com/kouchao/TiantianFundApi/main/docs/apis/README.md";
    const res = await fetch(docUrl, { signal: AbortSignal.timeout(20000) });
    if (res.ok) {
      const md = await res.text();
      const start = md.indexOf("## 基金经理");
      const end = md.indexOf("## 股票");
      const sec = start >= 0 ? md.slice(start, end > start ? end : start + 12000) : "";
      // 基金章里的「获取基金的基金经理」
      const fStart = md.indexOf("获取基金的基金经理");
      const fSec = fStart >= 0 ? md.slice(fStart, fStart + 1500) : "";
      fs.writeFileSync(path.join(OUT_DIR, "managerdoc.md"), sec + "\n\n---\n\n" + fSec);
      console.log("OK managerdoc.md " + (sec.length + fSec.length) + " 字符");
    }
  } catch (e) {
    console.log("文档抓取失败：" + (e && e.message));
  }

  // 1) 先找 openapi
  const candidates = ["/openapi.json", "/swagger.json", "/docs", "/routes", "/api"];
  let spec = null, specPath = "";
  const tries = [];
  for (const p of candidates) {
    const r = await hit(p);
    tries.push({ p: r.p, status: r.status, bytes: r.bytes, error: r.error || "" });
    if (r.json && (r.json.paths || r.json.openapi || r.json.swagger)) { spec = r.json; specPath = p; break; }
    await new Promise((s) => setTimeout(s, 200));
  }

  let routes = [];
  if (spec && spec.paths) {
    routes = Object.keys(spec.paths).map((k) => {
      const item = spec.paths[k] || {};
      const methods = Object.keys(item);
      const params = [];
      for (const m of methods) {
        for (const pr of (item[m].parameters || [])) params.push(pr.name);
      }
      return { path: k, methods, params: [...new Set(params)] };
    });
    console.log("找到 " + specPath + "，路由 " + routes.length + " 条");
  } else {
    console.log("没找到 openapi，命中情况：" + JSON.stringify(tries));
  }

  // 2) 经理相关路由的关键字筛选
  const kw = /mgr|manager|jjjl|基金经理/i;
  const mgrRoutes = routes.filter((r) => kw.test(r.path));

  // 3) 顺手试几个可能的批量经理接口，看真实返回规模
  const probes = [];
  for (const p of mgrRoutes.map((r) => r.path).slice(0, 12)) {
    if (/[:{]/.test(p)) continue; // 带路径参数的跳过，没法直接试
    const r = await hit(p);
    let count = null, keys = null;
    if (r.json) {
      const d = r.json.Datas || r.json.data || r.json;
      if (Array.isArray(d)) { count = d.length; keys = d[0] ? Object.keys(d[0]).slice(0, 30) : null; }
      else if (d && typeof d === "object") keys = Object.keys(d).slice(0, 30);
    }
    probes.push({ p, status: r.status, bytes: r.bytes, count, keys, error: r.error || "" });
    await new Promise((s) => setTimeout(s, 200));
  }

  const pack = {
    v: 1,
    ts: Date.now(),
    specPath,
    routeCount: routes.length,
    managerRoutes: mgrRoutes,
    probes,
    allRoutes: routes.map((r) => r.path + "  [" + r.methods.join(",") + "]")
  };
  const text = JSON.stringify(pack);
  fs.writeFileSync(path.join(OUT_DIR, "apiroutes.json"), text);
  console.log("OK apiroutes.json " + (text.length / 1024).toFixed(0) + "KB，经理相关路由 " + mgrRoutes.length + " 条");
  for (const r of mgrRoutes.slice(0, 20)) console.log("  " + r.path + " " + JSON.stringify(r.params));
}

main().catch((e) => {
  console.error("FAIL: " + (e && e.message));
  process.exit(1);
});
