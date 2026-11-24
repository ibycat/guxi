// Cloudflare Pages Function: /api/em?u=<host/path?query>
// 同源代理东方财富公开接口：规避浏览器跨域 / JSONP 依赖，并在边缘做分级缓存、重试与分页预热。
// 只允许白名单域名，避免被当成开放代理滥用。

const ALLOWED_HOSTS = new Set([
  "push2.eastmoney.com",
  "datacenter-web.eastmoney.com",
  "datacenter.eastmoney.com",
  // 基金自定义区间收益要打基金排行接口（必须带 Referer，代理里统一补）
  "fund.eastmoney.com"
]);

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type"
};

// 行情 60s 一刷；分红送配按天变化，缓存 12h
const TTL_QUOTE = 60;
const TTL_BONUS = 43200;
const MAX_PAGE = 60;
const WARM_AHEAD = 8;

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign(
      { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      CORS
    )
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchUpstream(url, attempts) {
  // 基金接口校验 Referer，其它接口沿用行情站的
  const referer = url.indexOf("fund.eastmoney.com") >= 0
    ? "https://fund.eastmoney.com/data/fundranking.html"
    : "https://quote.eastmoney.com/";
  let last = null;
  for (let i = 0; i < attempts; i++) {
    let res;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: {
          "user-agent": UA,
          accept: "*/*",
          referer: referer
        }
      });
    } catch (e) {
      last = { status: 0, body: "network_error" };
      await sleep(200 * Math.pow(2, i));
      continue;
    }

    if (res.ok) {
      const text = await res.text();
      const body = text.replace(/^\uFEFF/, "").trim();
      const head = body.charAt(0);
      if (head === "{" || head === "[") return { status: 200, body: text };
      // 基金排行接口返回的是 `var rankData ={...}`，不是纯 JSON，单独放行
      if (body.indexOf("var rankData") === 0) return { status: 200, body: text };
      last = { status: 502, body: "html_response" };
      break;
    }

    last = { status: res.status, body: "" };
    if (res.status !== 429 && res.status < 500) break;
    await sleep(250 * Math.pow(2, i));
  }
  return last || { status: 502, body: "unknown" };
}

function cacheable(body, ttl) {
  return new Response(body, {
    status: 200,
    headers: Object.assign(
      {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=" + ttl + ", s-maxage=" + ttl
      },
      CORS
    )
  });
}

// 预热单个分页：命中缓存就跳过，否则拉取并写入边缘缓存
async function warmOne(cache, url, ttl) {
  const rk = new Request(url, { method: "GET" });
  try {
    const hit = await cache.match(rk);
    if (hit) return;
  } catch (e) {
    return;
  }
  const up = await fetchUpstream(url, 1);
  if (up.status !== 200) return;
  try {
    await cache.put(rk, cacheable(up.body, ttl));
  } catch (e) {
    /* ignore */
  }
}

export async function onRequest(context) {
  const request = context.request;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (request.method !== "GET") {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }

  const url = new URL(request.url);
  const raw = url.searchParams.get("u");
  if (!raw) return json({ ok: false, error: "missing_u" }, 400);

  let target;
  try {
    target = new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw);
  } catch (e) {
    return json({ ok: false, error: "bad_url" }, 400);
  }

  if (!ALLOWED_HOSTS.has(target.hostname)) {
    return json({ ok: false, error: "host_not_allowed" }, 403);
  }

  // 上游若带 JSONP 回调参数，返回的就不是合法 JSON，必须剔除
  target.searchParams.delete("cb");
  target.searchParams.delete("callback");
  // 客户端用 _=<timestamp> 防浏览器缓存，但它会让边缘缓存永远不命中，必须剔除
  target.searchParams.delete("_");

  const isBonus =
    target.search.indexOf("RPT_SHAREBONUS_DET") >= 0 ||
    target.search.indexOf("RPT_HKF10") >= 0;
  const ttl = isBonus ? TTL_BONUS : TTL_QUOTE;
  const key = target.toString();
  const cache = caches.default;

  if (url.searchParams.get("nocache") !== "1") {
    const cacheKey = new Request(key, { method: "GET" });
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    const upstream = await fetchUpstream(key, 3);
    if (upstream.status !== 200) {
      return json({ ok: false, error: "upstream_" + (upstream.status || "net") }, 502);
    }

    const res = cacheable(upstream.body, ttl);
    context.waitUntil(cache.put(cacheKey, res.clone()));

    // 行情列表共有几十页，逐页串行回源要好几分钟；这里把后面几页一起拉进缓存
    if (!isBonus && target.pathname.indexOf("clist/get") >= 0) {
      const pn = Number(target.searchParams.get("pn") || 0);
      if (pn > 0) {
        const jobs = [];
        for (let i = 1; i <= WARM_AHEAD; i++) {
          const p = pn + i;
          if (p > MAX_PAGE) break;
          const next = new URL(key);
          next.searchParams.set("pn", String(p));
          jobs.push(warmOne(cache, next.toString(), ttl));
        }
        if (jobs.length) context.waitUntil(Promise.all(jobs));
      }
    }

    return res;
  }

  const upstream = await fetchUpstream(key, 1);
  if (upstream.status !== 200) {
    return json({ ok: false, error: "upstream_" + (upstream.status || "net") }, 502);
  }
  return new Response(upstream.body, {
    status: 200,
    headers: Object.assign(
      { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      CORS
    )
  });
}
