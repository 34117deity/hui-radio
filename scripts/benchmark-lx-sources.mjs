import vm from "node:vm";
import dotenv from "dotenv";

dotenv.config({ quiet: true });
process.on("unhandledRejection", () => {});
process.on("uncaughtException", () => {});

const CURRENT_URLS = [
  process.env.LX_SOURCE_URL,
  ...(process.env.LX_SOURCE_FALLBACK_URLS || "").split(",")
]
  .map((item) => item?.trim())
  .filter(Boolean);

const GITHUB_TREES = [
  {
    name: "Macrohard0001/lx-ikun-music-sources",
    api: "https://api.github.com/repos/Macrohard0001/lx-ikun-music-sources/git/trees/main?recursive=1",
    raw: (path) => `https://cdn.jsdelivr.net/gh/Macrohard0001/lx-ikun-music-sources@main/${encodeURI(path)}`
  },
  {
    name: "pdone/lx-music-source",
    api: "https://api.github.com/repos/pdone/lx-music-source/git/trees/main?recursive=1",
    raw: (path) => `https://cdn.jsdelivr.net/gh/pdone/lx-music-source@main/${encodeURI(path)}`
  },
  {
    name: "lyswhut/lx-music-source",
    api: "https://api.github.com/repos/lyswhut/lx-music-source/git/trees/master?recursive=1",
    raw: (path) => `https://cdn.jsdelivr.net/gh/lyswhut/lx-music-source@master/${encodeURI(path)}`
  }
];

const SAMPLE_TRACKS = [
  { source: "tx", songmid: "003YZWlw2uQrxe", title: "背包", artist: "曹格" },
  { source: "wy", songmid: "1396939163", title: "一次就好 (Live)", artist: "范丞丞、魏大勋" }
];

const QUALITIES = ["128k", "320k"];
const CONCURRENCY = Number(process.env.LX_BENCH_CONCURRENCY || 4);
const LIMIT = Number(process.env.LX_BENCH_LIMIT || 0);

function nowMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}

function isLikelyAudioContentType(contentType = "") {
  return /audio|octet-stream|application\/force-download/i.test(contentType);
}

async function timed(label, fn) {
  const start = nowMs();
  const value = await fn();
  return { label, durationMs: nowMs() - start, value };
}

async function httpRequest(url, options, callback) {
  try {
    const headers = options?.headers || {};
    const body =
      typeof options?.body === "string"
        ? options.body
        : options?.body && typeof options.body === "object"
          ? JSON.stringify(options.body)
          : undefined;
    const res = await fetch(url, {
      method: typeof options?.method === "string" ? options.method : "GET",
      headers,
      body,
      signal: AbortSignal.timeout(15000)
    });
    const text = await res.text();
    const contentType = res.headers.get("content-type") || "";
    let parsed = text;
    if (contentType.includes("json")) {
      try {
        parsed = JSON.parse(text);
      } catch {}
    }
    callback(null, {
      statusCode: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body: parsed
    });
  } catch (error) {
    callback(error);
  }
}

async function loadScriptHandler(scriptText) {
  const listeners = new Map();
  const eventNames = { request: "request", inited: "inited", updateAlert: "updateAlert" };
  const lx = {
    EVENT_NAMES: eventNames,
    request: httpRequest,
    on: (eventName, callback) => listeners.set(eventName, callback),
    send: () => {},
    currentScriptInfo: { type: "desktop", version: "2.10.0" },
    utils: {}
  };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    fetch,
    setTimeout,
    clearTimeout,
    Promise,
    Map,
    Date,
    Error,
    Number,
    Math,
    JSON,
    String,
    Object,
    Array,
    RegExp,
    parseInt,
    decodeURIComponent,
    globalThis: { lx }
  };
  vm.createContext(sandbox);
  new vm.Script(scriptText, { filename: "lx-source-benchmark.js" }).runInContext(sandbox, { timeout: 15000 });
  return listeners.get(eventNames.request) || Array.from(listeners.values())[0] || null;
}

function makeMusicInfo(track) {
  return {
    id: `${track.source}_${track.songmid}`,
    name: track.title,
    singer: track.artist,
    source: track.source,
    songmid: track.songmid,
    mid: track.songmid,
    meta: { songId: track.songmid }
  };
}

async function verifyStream(url) {
  const res = await fetch(url, {
    headers: {
      range: "bytes=0-4095",
      accept: "audio/*,*/*;q=0.8",
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    },
    redirect: "follow",
    signal: AbortSignal.timeout(15000)
  });
  const contentType = res.headers.get("content-type") || "";
  return {
    ok: res.ok || res.status === 206,
    status: res.status,
    contentType,
    audioLike: isLikelyAudioContentType(contentType)
  };
}

async function collectCandidates() {
  const candidates = [];
  for (const url of CURRENT_URLS) {
    candidates.push({ sourceUrl: url, origin: "current-config" });
    const cdnUrl = toJsdelivrUrl(url);
    if (cdnUrl && cdnUrl !== url) candidates.push({ sourceUrl: cdnUrl, origin: "current-config-jsdelivr" });
  }
  for (const tree of GITHUB_TREES) {
    try {
      const res = await fetch(tree.api, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) continue;
      const body = await res.json();
      for (const item of body.tree || []) {
        if (item.type === "blob" && typeof item.path === "string" && item.path.endsWith(".js")) {
          candidates.push({ sourceUrl: tree.raw(item.path), origin: tree.name });
        }
      }
    } catch {}
  }
  const seen = new Set();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.sourceUrl)) return false;
    seen.add(candidate.sourceUrl);
    return true;
  });
}

function toJsdelivrUrl(url) {
  const match = url.match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/(?:refs\/heads\/)?([^/]+)\/(.+)$/i);
  if (!match) return null;
  const [, owner, repo, branch, rawPath] = match;
  return `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${rawPath}`;
}

async function probeCandidate(candidate) {
  const totalStart = nowMs();
  try {
    const download = await timed("download", async () => {
      const res = await fetch(candidate.sourceUrl, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`script download failed: ${res.status}`);
      return res.text();
    });
    const handler = await loadScriptHandler(download.value);
    if (!handler) throw new Error("no request handler registered");

    const attempts = [];
    for (const track of SAMPLE_TRACKS) {
      for (const quality of QUALITIES) {
        const resolveStart = nowMs();
        let resolvedUrl = null;
        try {
          resolvedUrl = await handler({
            action: "musicUrl",
            source: track.source,
            info: { type: quality, musicInfo: makeMusicInfo(track) }
          });
        } catch (error) {
          attempts.push({
            track: `${track.source}:${track.songmid}`,
            quality,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            resolveMs: nowMs() - resolveStart
          });
          continue;
        }
        const resolveMs = nowMs() - resolveStart;
        if (!resolvedUrl || typeof resolvedUrl !== "string") {
          attempts.push({ track: `${track.source}:${track.songmid}`, quality, ok: false, error: "empty url", resolveMs });
          continue;
        }
        const streamStart = nowMs();
        try {
          const stream = await verifyStream(resolvedUrl);
          const streamMs = nowMs() - streamStart;
          const ok = stream.ok && stream.audioLike;
          attempts.push({
            track: `${track.source}:${track.songmid}`,
            quality,
            ok,
            resolveMs,
            streamMs,
            status: stream.status,
            contentType: stream.contentType,
            resolvedUrl
          });
          if (ok) {
            return {
              ...candidate,
              ok: true,
              totalMs: nowMs() - totalStart,
              downloadMs: download.durationMs,
              resolveMs,
              streamMs,
              latencyMs: resolveMs + streamMs,
              verified: attempts.at(-1)
            };
          }
        } catch (error) {
          attempts.push({
            track: `${track.source}:${track.songmid}`,
            quality,
            ok: false,
            resolveMs,
            streamMs: nowMs() - streamStart,
            error: error instanceof Error ? error.message : String(error),
            resolvedUrl
          });
        }
      }
    }
    return { ...candidate, ok: false, totalMs: nowMs() - totalStart, downloadMs: download.durationMs, attempts };
  } catch (error) {
    return {
      ...candidate,
      ok: false,
      totalMs: nowMs() - totalStart,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  let candidates = await collectCandidates();
  if (LIMIT > 0) candidates = candidates.slice(0, LIMIT);
  console.error(`Collected ${candidates.length} candidate source scripts. Testing with concurrency ${CONCURRENCY}.`);
  const results = await mapLimit(candidates, CONCURRENCY, async (candidate, index) => {
    const result = await probeCandidate(candidate);
    const marker = result.ok ? "OK" : "NO";
    console.error(`[${index + 1}/${candidates.length}] ${marker} ${result.latencyMs ?? result.totalMs}ms ${candidate.sourceUrl}`);
    return result;
  });
  const working = results
    .filter((item) => item.ok)
    .sort((a, b) => a.latencyMs - b.latencyMs || a.totalMs - b.totalMs);
  console.log(JSON.stringify({ testedAt: new Date().toISOString(), total: results.length, working, results }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
