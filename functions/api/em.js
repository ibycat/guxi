// Cloudflare Pages Function: /api/em?u=<host/path?query>
// 同源代理东方财富公开接口：规避浏览器跨域 / JSONP 依赖，并在边缘做分级缓存与重试。
// 只允许白名单域名，避免被当成开放代理滥用。

const ALLOWED_HOSTS = new Set([
  "push2.eastmoney.com",
  "datacenter-web.eastmoney.com"
]);

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type"
};

// 行情 60s 一刷；分红送配按天变化，缓存 12h，把上游请求量压掉两个数量级
const TTL_QUOTE = 60;
const TTL_BONUS = 43200;

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
  let last = null;
  for (let i = 0; i < attempts; i++) {
    let res;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: {
          "user-agent": UA,
          accept: "*/*",
          referer: "https://quote.eastmoney.com/"
        }
      });
    } catch (e) {
      last = { status: 0, body: "network_error" };
      await sleep(250 * Math.pow(2, i));
      continue;
    }

    if (res.ok) {
      const text = await res.text();
      // 被拦截时上游常返回 HTML 验证页，不能当成功数据用
      const head = text.replace(/^\uFEFF/, "").trim().charAt(0);
      if (head === "{" || head === "[") {
        return { status: 200, body: text };
      }
      last = { status: 502, body: "html_response" };
      break;
    }

    last = { status: res.status, body: "" };
    if (res.status !== 429 && res.status < 500) break;
    await sleep(300 * Math.pow(2, i));
  }
  return last || { status: 502, body: "unknown" };
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

  const isBonus = target.search.indexOf("RPT_SHAREBONUS_DET") >= 0;
  const ttl = isBonus ? TTL_BONUS : TTL_QUOTE;
  const key = target.toString();

  if (url.searchParams.get("nocache") !== "1") {
    const cache = caches.default;
    const cacheKey = new Request(key, { method: "GET" });
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    const upstream = await fetchUpstream(key, 3);
    if (upstream.status !== 200) {
      return json({ ok: false, error: "upstream_" + (upstream.status || "net") }, 502);
    }

    const res = new Response(upstream.body, {
      status: 200,
      headers: Object.assign(
        {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "public, max-age=" + ttl + ", s-maxage=" + ttl
        },
        CORS
      )
    });

    context.waitUntil(cache.put(cacheKey, res.clone()));
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
