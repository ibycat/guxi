// Cloudflare Pages Function: /api/snap?f=a|hk
//
// 快照同源代理。快照本体放在仓库的 data 分支（由 GitHub Actions 每天生成两次），
// raw.githubusercontent.com 在国内访问又慢又不稳，所以这里做一层同源代理：
//   - 浏览器只打自己的域，走 Cloudflare 边缘
//   - 边缘缓存 5 分钟，避免每个用户都回源 GitHub
//   - 回源失败时返回上一次成功缓存的副本，宁可给旧数据也不要空白
//
// 关于压缩（重要）：
//   Pages Functions 免费版 CPU 上限是 10ms/次调用，在函数里 gzip 一个 1.5MB 的 JSON
//   很可能超限被打断。所以压缩挪到 GitHub Actions 里做：data 分支同时产出
//   a.json.gz / hk.json.gz，这里只做「取字节 + 打上 content-encoding: gzip」的透传，
//   压缩开销恒为 0。只有在 .gz 缺失时才退回现场压缩（兼容旧产物）。

const SRC = "https://raw.githubusercontent.com/ibycat/guxi/data/";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type"
};

const TTL_FRESH = 300; // 5 分钟：快照本身一天才更新两次
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

function baseHeaders(ttl) {
  return Object.assign(
    {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=" + ttl + ", s-maxage=" + ttl
    },
    CORS
  );
}

// 透明传输预压缩字节：不做任何解压/压缩，CPU 开销接近 0
function wrapGz(bytes, ttl) {
  const headers = baseHeaders(ttl);
  headers["content-encoding"] = "gzip";
  headers.vary = "accept-encoding";
  return new Response(bytes, { status: 200, headers });
}

// 兼容分支：产物里没有 .gz 时现场压缩（仅过渡期会走到）
// 注意要先把压缩流读完再返回，直接返回 ReadableStream 在某些路径下会被
// 边缘再压一层，变成 gzip(gzip(json))，浏览器解一次拿到的是二进制。
async function wrapText(body, ttl) {
  const headers = baseHeaders(ttl);
  if (typeof CompressionStream === "function") {
    try {
      const stream = new Response(body).body.pipeThrough(new CompressionStream("gzip"));
      const buf = await new Response(stream).arrayBuffer();
      headers["content-encoding"] = "gzip";
      headers.vary = "accept-encoding";
      return new Response(buf, { status: 200, headers });
    } catch (e) {
      /* 回退明文 */
    }
  }
  return new Response(body, { status: 200, headers });
}

// 取预压缩产物。返回 { gz: Uint8Array } 或 { text: string }
async function fetchSnapshot(f) {
  try {
    const res = await fetch(SRC + f + ".json.gz", {
      headers: { "user-agent": UA, accept: "*/*" },
      signal: AbortSignal.timeout(25000),
      cf: { cacheTtl: 0 }
    });
    if (res.ok) {
      const buf = new Uint8Array(await res.arrayBuffer());
      // 校验 gzip 魔术字节，防止上游把文件解压过（那样字节就不是 gzip 了）
      if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
        return { gz: buf };
      }
      const text = new TextDecoder().decode(buf);
      if (text.trim().charAt(0) === "{") return { text };
    }
  } catch (e) {
    /* 落到下面走未压缩分支 */
  }

  const res = await fetch(SRC + f + ".json", {
    headers: { "user-agent": UA, accept: "*/*" },
    signal: AbortSignal.timeout(25000),
    cf: { cacheTtl: 0 }
  });
  if (!res.ok) throw new Error("up_" + res.status);
  const body = await res.text();
  if (body.trim().charAt(0) !== "{") throw new Error("bad_body");
  return { text: body };
}

function build(payload, ttl) {
  return payload.gz ? wrapGz(payload.gz, ttl) : wrapText(payload.text, ttl);
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

  let payload = null;
  try {
    payload = await fetchSnapshot(f);
  } catch (e) {
    // 回源失败：优先给上一次成功过的副本
    const stale = await cache.match(staleKey);
    if (stale) return stale;
    return jsonError("snapshot_unavailable");
  }

  const fresh = build(payload, TTL_FRESH);
  context.waitUntil(cache.put(freshKey, fresh.clone()));

  const stale = build(payload, TTL_STALE);
  context.waitUntil(cache.put(staleKey, stale.clone()));

  return fresh;
}
