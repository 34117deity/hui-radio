import vm from "node:vm";

const TREE_API =
  "https://api.github.com/repos/Macrohard0001/lx-ikun-music-sources/git/trees/main?recursive=1";

const SAMPLE_TRACKS = [
  { source: "tx", songmid: "003YZWlw2uQrxe", title: "背叛", artist: "曹格" },
  { source: "wy", songmid: "1396939163", title: "一次就好 (Live)", artist: "范丞丞、魏大勋" }
];

function isLikelyAudioContentType(contentType = "") {
  return /audio|octet-stream/i.test(contentType);
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
      body
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
    console,
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
  new vm.Script(scriptText, { filename: "lx-source-probe.js" }).runInContext(sandbox, { timeout: 15000 });
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
      range: "bytes=0-2048",
      accept: "audio/*,*/*;q=0.8",
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    },
    redirect: "follow",
    signal: AbortSignal.timeout(15000)
  });
  const contentType = res.headers.get("content-type") || "";
  return { ok: res.ok || res.status === 206, status: res.status, contentType, audioLike: isLikelyAudioContentType(contentType) };
}

async function probeCandidate(rawUrl) {
  const scriptRes = await fetch(rawUrl, { signal: AbortSignal.timeout(12000) });
  if (!scriptRes.ok) throw new Error(`script download failed: ${scriptRes.status}`);
  const scriptText = await scriptRes.text();
  const handler = await loadScriptHandler(scriptText);
  if (!handler) throw new Error("no request handler registered");

  for (const track of SAMPLE_TRACKS) {
    let resolvedUrl = null;
    try {
      resolvedUrl = await handler({
        action: "musicUrl",
        source: track.source,
        info: { type: "128k", musicInfo: makeMusicInfo(track) }
      });
    } catch {
      resolvedUrl = null;
    }
    if (!resolvedUrl || typeof resolvedUrl !== "string") continue;
    const stream = await verifyStream(resolvedUrl);
    if (stream.ok && stream.audioLike) {
      return { ok: true, resolvedUrl, track, stream };
    }
  }
  return { ok: false };
}

async function main() {
  const directUrls = process.argv.slice(2).map((item) => item.trim()).filter(Boolean);
  if (directUrls.length) {
    for (const url of directUrls) {
      console.log(`Testing: ${url}`);
      const result = await probeCandidate(url);
      console.log(
        JSON.stringify(
          {
            sourceUrl: url,
            ...result
          },
          null,
          2
        )
      );
      if (!result.ok) process.exitCode = 1;
    }
    return;
  }

  const treeRes = await fetch(TREE_API, { signal: AbortSignal.timeout(20000) });
  if (!treeRes.ok) throw new Error(`github tree failed: ${treeRes.status}`);
  const tree = await treeRes.json();
  const jsPaths = (tree.tree || [])
    .filter((item) => item.type === "blob" && typeof item.path === "string" && item.path.endsWith(".js"))
    .map((item) => item.path);
  const urls = jsPaths.map((p) => `https://raw.githubusercontent.com/Macrohard0001/lx-ikun-music-sources/main/${encodeURI(p)}`);

  console.log(`Total candidates: ${urls.length}`);
  for (const url of urls) {
    process.stdout.write(`Testing: ${url}\n`);
    try {
      const result = await probeCandidate(url);
      if (result.ok) {
        console.log("FOUND_WORKING_SOURCE");
        console.log(
          JSON.stringify(
            {
              sourceUrl: url,
              sampleTrack: result.track,
              resolvedUrl: result.resolvedUrl,
              stream: result.stream
            },
            null,
            2
          )
        );
        return;
      }
    } catch (error) {
      process.stdout.write(`  failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  console.log("NO_WORKING_SOURCE");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
