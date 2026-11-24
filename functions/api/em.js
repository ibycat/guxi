// Cloudflare Pages Function: /api/em?u=<host/path?query>
// 同源代理东方财富公开接口，规避浏览器跨域与 JSONP 依赖，并在边缘做 60 秒缓存。
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

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign(
      { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      CORS
    )
  });
}

export async function onRequest(context) {
  const request = context.request;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (request.method !== "GET") {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }

  const raw = new URL(request.url).searchParams.get("u");
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

  const cacheKey = new Request(target.toString(), { method: "GET" });
  const cache = caches.default;

  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      method: "GET",
      headers: {
        "user-agent": UA,
        accept: "*/*",
        referer: "https://quote.eastmoney.com/"
      }
    });
  } catch (e) {
    return json({ ok: false, error: "upstream_failed" }, 502);
  }

  if (!upstream.ok) {
    return json({ ok: false, error: "upstream_" + upstream.status }, 502);
  }

  const text = await upstream.text();

  const res = new Response(text, {
    status: 200,
    headers: Object.assign(
      {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=60, s-maxage=300"
      },
      CORS
    )
  });

  context.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}
