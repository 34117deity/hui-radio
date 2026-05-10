import NodeCache from "node-cache";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pLimit from "p-limit";
import vm from "node:vm";
import { config } from "../config.js";
import type { TrackInput } from "../types.js";

type RequestHandler = (payload: { action: string; source: string; info: Record<string, unknown> }) => Promise<string | null>;

type SourceAttempt = {
  sourceRef: string;
  strategy: "env_base64" | "local_snapshot" | "remote";
  attempt: number;
  durationMs: number;
  success: boolean;
  error?: string;
};

type SourceHealth = {
  ready: boolean;
  error: string | null;
  meta: unknown;
  activeSource: string | null;
  fallbackUsed: boolean;
  perSourceErrors: Record<string, string>;
  attempts: SourceAttempt[];
};

const urlCache = new NodeCache({ stdTTL: 60 * 20, checkperiod: 60 });
const limiter = pLimit(1);
const snapshotPath = path.join(config.cacheDir, "lx-source.snapshot.js");

let handler: RequestHandler | null = null;
let sourceReady = false;
let loadError: string | null = null;
let sourceMeta: unknown = null;
let activeSourceRef: string | null = null;
let fallbackUsed = false;
const badSourceUntil = new Map<string, number>();
let perSourceErrors: Record<string, string> = {};
let lastAttempts: SourceAttempt[] = [];

function availableSourceKeys(): string[] {
  const meta = sourceMeta as { sources?: Record<string, unknown> } | null;
  const keys = meta?.sources ? Object.keys(meta.sources) : [];
  return keys.filter(Boolean);
}

async function httpRequest(url: string, options: Record<string, unknown>, callback: (error: Error | null, response?: unknown) => void) {
  try {
    const headers = (options.headers as Record<string, string> | undefined) || {};
    const rawBody = options.body;
    const requestBody =
      typeof rawBody === "string"
        ? rawBody
        : rawBody && typeof rawBody === "object"
          ? JSON.stringify(rawBody)
          : undefined;
    const response = await fetch(url, {
      method: typeof options.method === "string" ? options.method : "GET",
      headers,
      body: requestBody
    });
    const contentType = response.headers.get("content-type") || "";
    const text = await response.text();
    const body = contentType.includes("json") ? JSON.parse(text) : text;
    callback(null, { statusCode: response.status, headers: Object.fromEntries(response.headers.entries()), body });
  } catch (error) {
    callback(error instanceof Error ? error : new Error(String(error)));
  }
}

function sourceCandidates(): string[] {
  const candidates = [config.LX_SOURCE_URL, ...(config.LX_SOURCE_FALLBACK_URLS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)];
  const unique = [...new Set(candidates)];
  const now = Date.now();
  const healthy = unique.filter((ref) => {
    const until = badSourceUntil.get(ref);
    return !until || until <= now;
  });
  const cooling = unique.filter((ref) => !healthy.includes(ref));
  return [...healthy, ...cooling];
}

async function markSourceFailure(sourceRef: string, reason: string) {
  badSourceUntil.set(sourceRef, Date.now() + config.LX_BAD_SOURCE_TTL_MS);
  perSourceErrors[sourceRef] = reason;
}

function markSourceSuccess(sourceRef: string) {
  badSourceUntil.delete(sourceRef);
  delete perSourceErrors[sourceRef];
}

async function readRemoteWithRetries(sourceRef: string, retries = config.LX_SOURCE_FETCH_RETRIES): Promise<string> {
  let lastError: unknown;
  const totalAttempts = retries + 1;
  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    const startedAt = Date.now();
    try {
      const response = await fetch(sourceRef, { signal: AbortSignal.timeout(config.LX_SOURCE_FETCH_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`LX source download failed: ${response.status}`);
      const script = await response.text();
      lastAttempts.push({
        sourceRef,
        strategy: "remote",
        attempt,
        durationMs: Date.now() - startedAt,
        success: true
      });
      return script;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      lastAttempts.push({
        sourceRef,
        strategy: "remote",
        attempt,
        durationMs: Date.now() - startedAt,
        success: false,
        error: reason
      });
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || "Unknown remote fetch failure"));
}

async function readSourceScript(sourceRef: string, options?: { retries?: number }): Promise<string> {
  if (!/^https?:\/\//i.test(sourceRef)) {
    const sourcePath = sourceRef.startsWith("file://") ? fileURLToPath(sourceRef) : sourceRef;
    return fs.readFile(sourcePath, "utf8");
  }
  return readRemoteWithRetries(sourceRef, options?.retries);
}

async function readSnapshotScript() {
  try {
    const script = await fs.readFile(snapshotPath, "utf8");
    lastAttempts.push({
      sourceRef: snapshotPath,
      strategy: "local_snapshot",
      attempt: 1,
      durationMs: 0,
      success: true
    });
    return script;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    lastAttempts.push({
      sourceRef: snapshotPath,
      strategy: "local_snapshot",
      attempt: 1,
      durationMs: 0,
      success: false,
      error: reason
    });
    return null;
  }
}

async function fetchSourceScript(): Promise<string> {
  lastAttempts = [];
  perSourceErrors = {};
  fallbackUsed = false;

  if (config.LX_SOURCE_TEXT_BASE64) {
    const startedAt = Date.now();
    try {
      const script = Buffer.from(config.LX_SOURCE_TEXT_BASE64, "base64").toString("utf8");
      lastAttempts.push({
        sourceRef: "env:LX_SOURCE_TEXT_BASE64",
        strategy: "env_base64",
        attempt: 1,
        durationMs: Date.now() - startedAt,
        success: true
      });
      activeSourceRef = "env:LX_SOURCE_TEXT_BASE64";
      return script;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      lastAttempts.push({
        sourceRef: "env:LX_SOURCE_TEXT_BASE64",
        strategy: "env_base64",
        attempt: 1,
        durationMs: Date.now() - startedAt,
        success: false,
        error: reason
      });
      perSourceErrors["env:LX_SOURCE_TEXT_BASE64"] = reason;
    }
  }

  const errors: string[] = [];
  const candidates = sourceCandidates();
  for (const [index, sourceRef] of candidates.entries()) {
    try {
      const retries = index === 0 ? 0 : config.LX_SOURCE_FETCH_RETRIES;
      const script = await readSourceScript(sourceRef, { retries });
      activeSourceRef = sourceRef;
      markSourceSuccess(sourceRef);
      await fs.writeFile(snapshotPath, script, "utf8").catch(() => undefined);
      return script;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      errors.push(`${sourceRef}: ${reason}`);
      await markSourceFailure(sourceRef, reason);
    }
  }

  const snapshotScript = await readSnapshotScript();
  if (snapshotScript) {
    activeSourceRef = snapshotPath;
    fallbackUsed = true;
    return snapshotScript;
  }

  activeSourceRef = null;
  throw new Error(`LX source load failed: ${errors.join(" | ")}`);
}

function currentHealth(): SourceHealth {
  return {
    ready: sourceReady,
    error: loadError,
    meta: sourceMeta,
    activeSource: activeSourceRef,
    fallbackUsed,
    perSourceErrors,
    attempts: lastAttempts
  };
}

export function getLxSourceHealth(): SourceHealth {
  return currentHealth();
}

export async function loadLxSource(force = false): Promise<SourceHealth> {
  if (sourceReady && !force) return currentHealth();
  loadError = null;
  const listeners = new Map<string, RequestHandler>();
  const eventNames = {
    request: "request",
    inited: "inited",
    updateAlert: "updateAlert"
  };

  try {
    const script = await fetchSourceScript();
    const lx = {
      EVENT_NAMES: eventNames,
      request: httpRequest,
      on: (eventName: string, callback: RequestHandler) => listeners.set(eventName, callback),
      send: (eventName: string, payload: unknown) => {
        if (eventName === eventNames.inited) sourceMeta = payload;
      },
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
    new vm.Script(script, { filename: "lx-source.js" }).runInContext(sandbox, { timeout: 10_000 });
    handler = listeners.get(eventNames.request) || Array.from(listeners.values())[0] || null;
    sourceReady = Boolean(handler);
    if (!handler) throw new Error("LX source script did not register request handler");
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
    handler = listeners.get(eventNames.request) || Array.from(listeners.values())[0] || handler;
    sourceReady = Boolean(handler);
  }

  return currentHealth();
}

function cacheKey(track: TrackInput, quality: string) {
  return [track.source, track.songmid, track.hash, track.sourceId, quality, track.title, track.artist].filter(Boolean).join("|");
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function buildMusicInfo(track: TrackInput): Record<string, unknown> {
  const raw = objectRecord(track.raw);
  const meta = objectRecord(raw.meta);
  const source = track.source || String(raw.source || "tx");
  const songId = track.songmid || track.sourceId || String(meta.songId || raw.songmid || raw.mid || raw.id || "");
  return {
    ...raw,
    meta: {
      ...meta,
      songId: meta.songId || songId,
      albumName: meta.albumName || track.album,
      picUrl: meta.picUrl || track.artwork
    },
    id: raw.id || (source && songId ? `${source}_${songId}` : songId),
    name: raw.name || track.title,
    singer: raw.singer || track.artist,
    albumName: raw.albumName || track.album,
    source,
    songmid: raw.songmid || songId,
    mid: raw.mid || songId,
    hash: raw.hash || track.hash,
    interval: raw.interval || track.interval,
    img: raw.img || raw.pic || raw.artwork || track.artwork,
    url: raw.url || track.directUrl
  };
}

export async function resolveLxMusicUrl(track: TrackInput, quality = "128k"): Promise<{ url: string; cached: boolean; sourceReady: boolean }> {
  if (track.directUrl) return { url: track.directUrl, cached: false, sourceReady: true };
  const key = cacheKey(track, quality);
  const cached = urlCache.get<string>(key);
  if (cached) return { url: cached, cached: true, sourceReady };

  await loadLxSource();
  if (!handler) throw new Error(loadError || "LX source is not ready");

  const musicInfo = buildMusicInfo(track);
  const sourcePool = [
    track.source,
    typeof musicInfo.source === "string" ? musicInfo.source : undefined,
    ...availableSourceKeys(),
    "wy",
    "tx",
    "kg",
    "kw",
    "mg"
  ]
    .filter((item): item is string => Boolean(item))
    .filter((item, index, arr) => arr.indexOf(item) === index);

  let url: string | null = null;
  for (const source of sourcePool) {
    try {
      const result = await limiter(() =>
        handler?.({
          action: "musicUrl",
          source,
          info: {
            type: quality,
            musicInfo
          }
        })
      );
      if (typeof result === "string" && result) {
        url = result;
        break;
      }
    } catch {
      // Try next source.
    }
  }

  if (!url) {
    await loadLxSource(true);
    if (!handler) throw new Error(loadError || "LX source is not ready");
    for (const source of sourcePool) {
      try {
        const result = await limiter(() =>
          handler?.({
            action: "musicUrl",
            source,
            info: {
              type: quality,
              musicInfo
            }
          })
        );
        if (typeof result === "string" && result) {
          url = result;
          break;
        }
      } catch {
        // Try next source.
      }
    }
  }

  if (!url) throw new Error("LX source did not return a playable URL");
  urlCache.set(key, url);
  return { url, cached: false, sourceReady: true };
}
