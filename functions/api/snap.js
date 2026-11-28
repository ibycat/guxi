// Cloudflare Pages Function: /api/snap?f=a|hk|fundrank|funddetail|fundmgr|mgrmap|managers
//
// 快照同源代理。快照本体放在仓库的 data 分支（由 GitHub Actions 每天生成），
// raw.githubusercontent.com 在国内访问又慢又不稳，所以这里做一层同源代理：
//   - 浏览器只打自己的域，走 Cloudflare 边缘
//   - 边缘缓存 5 分钟，避免每个用户都回源 GitHub
//   - 回源失败时返回上一次成功缓存的副本，宁可给旧数据也不要空白
//
// 关于压缩，这里踩了三个坑，最终结论是「函数绝对不要碰压缩」：
//   1) Pages Functions 免费版 CPU 上限 10ms/次调用，在函数里 gzip 大 JSON 有超限风险；
//   2) 在函数里压完、再带 content-encoding: gzip 返回，边缘会**再压一层**，
//      变成 br(gzip(json))。浏览器只解一层，r.json() 拿到二进制直接报 Unexpected token；
//   3) 带 Accept-Encoding 的浏览器请求，Cloudflare 本来就会自动压缩一次；
//      不带该头的客户端（如 curl 默认）则不压缩、拿到明文。
//   所以函数只负责原样输出 JSON 文本，压缩完全交给边缘，正确性和体积都能保证。
//
// 注意：data 分支里的 *.json.gz 是早期产物，现在没有用了，留着不影响运行。

const SRC = "https://raw.githubusercontent.com/ibycat/guxi/data/";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type"
};

// 快照每天收盘后更新一次，边缘缓存没必要只留 5 分钟。
// 原来 5 分钟一过期，冷 colo 的第一个人就要回源 GitHub（常见 0.5~1.5s），
// 这段时间就是用户感知的「首页打开慢」。改成一小时，缓存 key 里带版本号，
// 格式变了照样能立刻失效；点「刷新」走 nocache=1 也会直接回源。
const TTL_FRESH = 3600; // 1 小时
const TTL_STALE = 604800; // 7 天：兜底副本，源站挂了也能开

function jsonError(error, status) {
  return new Response(JSON.stringify({ ok: false, error }), {
    status: status || 503,
    headers: Object.assign(
      { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      CORS
    )
  });
}

function build(text, ttl) {
  return new Response(text, {
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

async function fetchSnapshot(f) {
  const res = await fetch(SRC + f + ".json", {
    headers: { "user-agent": UA, accept: "*/*" },
    signal: AbortSignal.timeout(25000),
    cf: { cacheTtl: 0 }
  });
  if (!res.ok) throw new Error("up_" + res.status);
  const body = await res.text();
  if (body.trim().charAt(0) !== "{") throw new Error("bad_body");
  return body;
}

export async function onRequest(context) {
  const request = context.request;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (request.method !== "GET") return jsonError("method_not_allowed", 405);

  const u = new URL(request.url);
  const f = u.searchParams.get("f");
  const ALLOWED = ["a", "hk", "fundrank", "funddetail", "fundmgr", "mgrmap", "managers"];
  if (ALLOWED.indexOf(f) < 0) return jsonError("bad_f", 400);

  // 客户端带版本号：快照格式一变就能整体失效旧缓存，不用等 5 分钟
  const ver = u.searchParams.get("v") || "1";

  const cache = caches.default;
  const freshKey = new Request("https://snap.internal/fresh/" + f + "/" + ver);
  const staleKey = new Request("https://snap.internal/stale/" + f + "/" + ver);

  // 手动刷新时带 nocache=1，跳过边缘缓存直接回源
  if (u.searchParams.get("nocache") !== "1") {
    const hit = await cache.match(freshKey);
    if (hit) return hit;
  }

  let text = null;
  try {
    text = await fetchSnapshot(f);
  } catch (e) {
    // 回源失败：优先给上一次成功过的副本
    const stale = await cache.match(staleKey);
    if (stale) return stale;
    return jsonError("snapshot_unavailable");
  }

  const fresh = build(text, TTL_FRESH);
  context.waitUntil(cache.put(freshKey, fresh.clone()));

  const stale = build(text, TTL_STALE);
  context.waitUntil(cache.put(staleKey, stale.clone()));

  return fresh;
}
