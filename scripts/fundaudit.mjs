// 收益数据审计
//
// 起因：960033 农银消费主题混合H 在排行接口里的「近1年」是 304.68%，明显不对。
// 这类错误靠肉眼看不过来，所以按规则筛出可疑行，再逐只去东财的
// pingzhongdata/{code}.js 取 syl_1n（近一年）做交叉核对：
//   两边一致 → 接口没问题，是这只基金本身异常（比如份额折算）
//   两边差很远 → 接口字段错位，整列都不可信
//
// 产物 audit.json：各规则的命中数 + 抽样对照明细

import fs from "node:fs";
import path from "node:path";

const OUT_DIR = process.env.SNAPSHOT_DIR || "data";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function readJson(f) {
  try { return JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), "utf8")); } catch (e) { return null; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isNum = (v) => typeof v === "number" && isFinite(v);

// 东财 pingzhongdata 里的近一年收益
async function emY1(code) {
  const url = "https://fund.eastmoney.com/pingzhongdata/" + code + ".js";
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetch(url, {
        headers: { "user-agent": UA, referer: "https://fund.eastmoney.com/" },
        signal: AbortSignal.timeout(15000)
      });
      if (!res.ok) return { code, err: "http_" + res.status };
      const text = await res.text();
      const nm = (text.match(/var fS_name\s*=\s*"([^"]*)"/) || [])[1] || "";
      const v = (text.match(/var syl_1n\s*=\s*"([^"]*)"/) || [])[1];
      const num = v == null || v === "" ? null : parseFloat(v);
      return { code, name: nm, y1: isFinite(num) ? num : null };
    } catch (e) {
      await sleep(400);
    }
  }
  return { code, err: "failed" };
}

async function main() {
  const rank = readJson("fundrank.json");
  if (!rank || !rank.rows) throw new Error("没有 fundrank.json");
  const rows = rank.rows.filter((r) => r && r.c);

  const rules = {
    navNull: [],        // 净值缺失
    y1Absurd: [],       // |近1年| >= 150%
    collapsed: [],      // 多个区间收益塌缩到同一个值
    y1NoEst: []         // 有收益但没规模（多为新基金）
  };

  for (const r of rows) {
    if (r.nav == null) rules.navNull.push(r);
    if (isNum(r.y1) && Math.abs(r.y1) >= 150) rules.y1Absurd.push(r);

    const vals = [r.m1, r.m3, r.m6, r.y1, r.y2, r.y3, r.y5].filter(isNum);
    if (vals.length >= 4) {
      const mx = Math.max(...vals), mn = Math.min(...vals);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      // 半年、1年、2年、3年、5年几乎一模一样，且数值很大 —— 典型字段错位
      if (mx - mn < 3 && Math.abs(mean) > 50) rules.collapsed.push(r);
    }
    if (isNum(r.y1) && r.nav2 == null) rules.y1NoEst.push(r);
  }

  const counts = {};
  for (const k in rules) counts[k] = rules[k].length;

  // 抽样核对：可疑的取 40 只，正常的取 20 只做对照
  const pick = [];
  for (const r of rules.collapsed.slice(0, 20)) pick.push({ r, why: "collapsed" });
  for (const r of rules.y1Absurd.slice(0, 20)) {
    if (!pick.some((p) => p.r.c === r.c)) pick.push({ r, why: "y1Absurd" });
  }
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 20 && rows.length; i++) {
    const r = rows[Math.floor(rand() * rows.length)];
    if (!pick.some((p) => p.r.c === r.c)) pick.push({ r, why: "control" });
  }

  const checks = [];
  for (const { r, why } of pick) {
    const em = await emY1(r.c);
    checks.push({
      c: r.c, n: r.n, why,
      api: isNum(r.y1) ? r.y1 : null,
      em: isNum(em.y1) ? em.y1 : null,
      diff: isNum(r.y1) && isNum(em.y1) ? Math.round((r.y1 - em.y1) * 100) / 100 : null,
      emName: em.name || "",
      err: em.err || ""
    });
    await sleep(200);
  }

  const byWhy = {};
  for (const c of checks) {
    const b = byWhy[c.why] || (byWhy[c.why] = { n: 0, match: 0, mismatch: 0, unknown: 0, samples: [] });
    b.n++;
    if (c.diff == null) b.unknown++;
    else if (Math.abs(c.diff) <= 1) b.match++;
    else b.mismatch++;
    if (b.samples.length < 5) b.samples.push(c);
  }

  const pack = { v: 1, ts: Date.now(), total: rows.length, counts, byWhy, checks };
  const text = JSON.stringify(pack);
  fs.writeFileSync(path.join(OUT_DIR, "audit.json"), text);

  console.log("OK audit.json " + (text.length / 1024).toFixed(0) + "KB");
  console.log("总数 " + rows.length + "，可疑：" + JSON.stringify(counts));
  for (const k in byWhy) {
    const b = byWhy[k];
    console.log("  [" + k + "] 抽 " + b.n + "：一致 " + b.match + "，不一致 " + b.mismatch + "，无法判定 " + b.unknown);
  }
  for (const c of checks.slice(0, 8)) {
    console.log("  " + c.c + " " + c.n + " api=" + c.api + " em=" + c.em + " diff=" + c.diff);
  }
}

main().catch((e) => {
  console.error("FAIL fundaudit: " + (e && e.message));
  process.exit(1);
});
