// Cloudflare Pages Function: /api/snap?f=a|hk|fund
//
// 快照同源代理。快照本体放在仓库的 data 分支（由 GitHub Actions 每天生成），
// raw.githubusercontent.com 在国内访问又慢又不稳，所以这里做一层同源代理：
//   - 浏览器只打自己的域，走 Cloudflare 边缘
//   - 边缘缓存 5 分钟，避免每个用户都回源 GitHub
//   - 回源失败时返回上一次成功缓存的副本，宁可给旧数据也不要空白
//
// 关于压缩（踩过坑，记录一下）：
//   Pages Functions 免费版 CPU 上限 10ms/次调用，在函数里 gzip 大 JSON 有超限风险；
//   但反过来「在函数里压完再把 content-encoding: gzip 透传」也不行 ——
//   实测 Cloudflare 会在这种响应上再压一层，变成 gzip(gzip(json))，
//   浏览器只解一层，r.json() 拿到二进制直接报 Unexpected token。
//   最终方案：函数什么都不压、也不设 content-encoding，原样返回 JSON 文本，
//   由 Cloudflare 边缘按 accept-encoding 统一压缩一次。这样既没有 CPU 开销，
//   也不存在多层压缩的可能。
//
// 注意：data 分支里的 *.json.gz 已经没有用了（历史产物），保留不影响运行。

const SRC = "https://raw.githubusercontent.com/ibycat/guxi/data/";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type"
};

const TTL_FRESH = 300; // 5 分钟：快照一天才更新几次
const TTL_STALE = 21600; // 6 小时：兜底副本

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
  if (f !== "a" && f !== "hk" && f !== "fund") return jsonError("bad_f", 400);

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
