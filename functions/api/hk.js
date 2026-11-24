// Cloudflare Pages Function: /api/hk?mode=quote|div
//
// 港股专用聚合接口。作用是把「浏览器拉 22 页派息 + 7 页行情」压成「浏览器发 1 个请求」：
// 边缘侧把上游分页全部拉完，拼成一个响应返回，并做长短两级缓存。
//
// 为什么不让 Worker 解析后返回汇总值：Pages Functions 免费版 CPU 上限 10ms，
// 解析 1.6MB JSON 很容易超限被打断。这里只做「拉取 + 拼接 + gzip」，CPU 开销接近 0，
// 解析留在浏览器（V8 解析 JSON 非常快，10k 条约几十毫秒）。
// 分页之间用 \n\n 分隔（东财返回的是压缩 JSON，正文不含换行），前端 split 即可。

const QUOTE = "https://push2.eastmoney.com/api/qt/clist/get";
const DIV = "https://datacenter.eastmoney.com/securities/api/data/v1/get";

const FS_GGT = "b:DLMK0146";
const FS_ALL = "m:128+t:1,m:128+t:2,m:128+t:3,m:128+t:4";
const Q_FIELDS = "f2,f3,f9,f12,f14,f20,f100";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type"
};

const TTL_QUOTE = 60;
const TTL_DIV = 43200; // 派息按天变，12h 足够
const TTL_PARTIAL = 10; // 有分页没拉到时只短缓存，等下次补全
const MAX_PAGES = 40;
const DIV_CONCURRENCY = 6; // datacenter 对并发不敏感，6 连接拉 22 页约 4s
const QUOTE_CONCURRENCY = 2; // push2 对并发极敏感，6 并发时除首页外全部挂住

function fail(error, status) {
  return new Response(JSON.stringify({ ok: false, error }), {
    status: status || 502,
    headers: Object.assign(
      { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      CORS
    )
  });
}

function bundle(parts, ttl) {
  const body = parts.join("\n\n");
  const headers = Object.assign(
    {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=" + ttl + ", s-maxage=" + ttl
    },
    CORS
  );

  // Workers 不会自动压缩函数响应，1.6MB 裸传在移动端很致命。
  // CompressionStream 是流式的，CPU 开销可控（不像 JSON.parse 那样吃 CPU 配额）。
  if (typeof CompressionStream === "function") {
    try {
      const gz = new Response(body).body.pipeThrough(new CompressionStream("gzip"));
      headers["content-encoding"] = "gzip";
      headers.vary = "accept-encoding";
      return new Response(gz, { status: 200, headers });
    } catch (e) {
      /* 回退到明文 */
    }
  }

  return new Response(body, { status: 200, headers });
}

async function fetchOnce(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent": UA,
      accept: "*/*",
      referer: "https://quote.eastmoney.com/"
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error("up_" + res.status);
  const text = await res.text();
  const head = text.replace(/^\uFEFF/, "").trim().charAt(0);
  if (head !== "{" && head !== "[") throw new Error("html_response");
  return text;
}

async function fetchText(url, tries) {
  const n = tries || 2;
  let last;
  for (let i = 0; i < n; i++) {
    try {
      return await fetchOnce(url);
    } catch (e) {
      last = e;
      if (i + 1 < n) await new Promise((r) => setTimeout(r, 150 * (i + 1)));
    }
  }
  throw last;
}

// 固定并发的任务池，返回与输入等长的数组，失败位置为 null
async function poolMap(items, limit, worker) {
  const out = new Array(items.length).fill(null);
  let idx = 0;
  async function run() {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try {
        out[i] = await worker(items[i]);
      } catch (e) {
        out[i] = null;
      }
    }
  }
  const runners = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) runners.push(run());
  await Promise.all(runners);
  return out;
}

function quoteUrl(universe, page, pz) {
  const u = new URL(QUOTE);
  u.searchParams.set("po", "1");
  u.searchParams.set("np", "1");
  u.searchParams.set("fltt", "2");
  u.searchParams.set("invt", "2");
  u.searchParams.set("fid", "f12");
  u.searchParams.set("fs", universe === "all" ? FS_ALL : FS_GGT);
  u.searchParams.set("fields", Q_FIELDS);
  u.searchParams.set("pn", String(page));
  u.searchParams.set("pz", String(pz));
  return u.toString();
}

function divUrl(from, page) {
  const u = new URL(DIV);
  u.searchParams.set("reportName", "RPT_HKF10_MAIN_DIVBASIC");
  u.searchParams.set("columns", "SECURITY_CODE,REPORT_TYPE,EX_DIVIDEND_DATE,YEAR,PLAN_EXPLAIN");
  u.searchParams.set("filter", '(EX_DIVIDEND_DATE>="' + from + '")');
  u.searchParams.set("pageSize", "500");
  u.searchParams.set("pageNumber", String(page));
  u.searchParams.set("sortColumns", "EX_DIVIDEND_DATE");
  u.searchParams.set("sortTypes", "-1");
  u.searchParams.set("source", "F10");
  u.searchParams.set("client", "PC");
  return u.toString();
}

async function handleQuote(url, ctx) {
  const universe = url.searchParams.get("u") === "all" ? "all" : "ggt";
  const pz = 100;

  let first;
  try {
    first = await fetchText(quoteUrl(universe, 1, pz));
  } catch (e) {
    return fail("upstream_quote");
  }

  let total = 0;
  try {
    total = JSON.parse(first).data.total || 0;
  } catch (e) {
    return fail("bad_quote_json");
  }

  const pages = Math.min(MAX_PAGES, Math.max(1, Math.ceil(total / pz)));
  const rest = [];
  for (let p = 2; p <= pages; p++) rest.push(p);

  // push2 对单 IP 的并发连接很敏感：6 并发时除首页外基本全被挂住（实测 24s 拿不到数据）。
  // 这里压到 2 并发 + 3 次重试，仍未拿到的页再串行补一遍。
  const tail = await poolMap(rest, QUOTE_CONCURRENCY, (p) =>
    fetchText(quoteUrl(universe, p, pz), 3)
  );
  const parts = [first];
  const missing = [];
  for (let i = 0; i < rest.length; i++) {
    if (tail[i]) parts.push(tail[i]);
    else missing.push(rest[i]);
  }
  for (const p of missing) {
    try {
      parts.push(await fetchText(quoteUrl(universe, p, pz), 2));
    } catch (e) {
      /* 放弃该页 */
    }
  }

  const ttl = parts.length === pages ? TTL_QUOTE : TTL_PARTIAL;
  const res = bundle(parts, ttl);
  ctx.waitUntil(caches.default.put(new Request(url.toString()), res.clone()));
  return res;
}

async function handleDiv(url, ctx) {
  const from = url.searchParams.get("from") || "2020-01-01";

  let first;
  try {
    first = await fetchText(divUrl(from, 1));
  } catch (e) {
    return fail("upstream_div");
  }

  let pages = 1;
  try {
    const r = JSON.parse(first).result || {};
    pages = Math.min(MAX_PAGES, Math.max(1, r.pages || 1));
  } catch (e) {
    return fail("bad_div_json");
  }

  const rest = [];
  for (let p = 2; p <= pages; p++) rest.push(p);

  const tail = await poolMap(rest, DIV_CONCURRENCY, (p) => fetchText(divUrl(from, p), 2));
  const parts = [first];
  for (const t of tail) if (t) parts.push(t);

  const ttl = parts.length === pages ? TTL_DIV : TTL_PARTIAL;
  const res = bundle(parts, ttl);
  ctx.waitUntil(caches.default.put(new Request(url.toString()), res.clone()));
  return res;
}

export async function onRequest(context) {
  const request = context.request;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (request.method !== "GET") return fail("method_not_allowed", 405);

  const url = new URL(request.url);
  const mode = url.searchParams.get("mode");
  if (mode !== "quote" && mode !== "div") return fail("bad_mode", 400);

  // 客户端若带时间戳，会让边缘缓存永不命中，统一剔除
  url.searchParams.delete("_");
  url.searchParams.delete("t");
  const key = new URL(url.toString());

  const cache = caches.default;
  const hit = await cache.match(new Request(key.toString()));
  if (hit) return hit;

  return mode === "quote" ? handleQuote(key, context) : handleDiv(key, context);
}
