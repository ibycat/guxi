// Cloudflare Pages Function: /api/snap?f=a|hk|fund
//
// 快照同源代理。快照本体放在仓库的 data 分支（由 GitHub Actions 每天生成），
// raw.githubusercontent.com 在国内访问又慢又不稳，所以这里做一层同源代理：
//   - 浏览器只打自己的域，走 Cloudflare 边缘
//   - 边缘缓存 5 分钟，避免每个用户都回源 GitHub
//   - 回源失败时返回上一次成功缓存的副本，宁可给旧数据也不要空白
//
// 关于压缩（踩过两个坑，都记在这里）：
//   1) Pages Functions 免费版 CPU 上限 10ms/次调用，在函数里 gzip 大 JSON 有超限风险；
//   2) 但「先压成完整字节、再带 content-encoding: gzip 返回」会让 Cloudflare 再压一层，
//      变成 gzip(gzip(json))，浏览器只解一层就拿到二进制，r.json() 直接报 Unexpected token。
//   实测可行的形态是**流式**：ReadableStream + content-encoding: gzip 不会被二次压缩。
//   所以这里两条路都走流：预压缩文件包成流透传，没有预压缩时才现场压（也是流）。

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

function baseHeaders(ttl) {
  return Object.assign(
    {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=" + ttl + ", s-maxage=" + ttl
    },
    CORS
  );
}

// 已经压好的字节：包成流透传，别再压缩、也别再缓冲
function wrapGz(bytes, ttl) {
  const headers = baseHeaders(ttl);
  headers["content-encoding"] = "gzip";
  headers.vary = "accept-encoding";
  return new Response(new Blob([bytes]).stream(), { status: 200, headers });
}

// 没有预压缩版本时才现场压，同样走流
function wrapText(body, ttl) {
  const headers = baseHeaders(ttl);
  if (typeof CompressionStream === "function") {
    try {
      const gz = new Response(body).body.pipeThrough(new CompressionStream("gzip"));
      headers["content-encoding"] = "gzip";
      headers.vary = "accept-encoding";
      return new Response(gz, { status: 200, headers });
    } catch (e) {
      /* 回退明文 */
    }
  }
  return new Response(body, { status: 200, headers });
}

function build(payload, ttl) {
  return payload.gz ? wrapGz(payload.gz, ttl) : wrapText(payload.text, ttl);
}

async function fetchSnapshot(f) {
  // 优先取 Actions 预压缩的 .gz：省掉函数内压缩的 CPU
  try {
    const res = await fetch(SRC + f + ".json.gz", {
      headers: { "user-agent": UA, accept: "*/*" },
      signal: AbortSignal.timeout(25000),
      cf: { cacheTtl: 0 }
    });
    if (res.ok) {
      const buf = new Uint8Array(await res.arrayBuffer());
      // 校验 gzip 魔术字节：万一上游已经把内容解压过，字节就不是 gzip 了
      if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) return { gz: buf };
      const txt = new TextDecoder().decode(buf);
      if (txt.trim().charAt(0) === "{") return { text: txt };
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

  const stale2 = build(payload, TTL_STALE);
  context.waitUntil(cache.put(staleKey, stale2.clone()));

  return fresh;
}
