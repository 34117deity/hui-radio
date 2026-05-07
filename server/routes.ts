import express from "express";
import NodeCache from "node-cache";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import {
  addTrackToPlaylist,
  attachTrackToPlaylist,
  enqueueTracks,
  getDefaultFavoritesPlaylist,
  getPlaylist,
  getTrack,
  listPlaylists,
  listQueue,
  listTracks,
  markQueueItem,
  removeTrack,
  upsertPlaylist,
  upsertTrack
} from "./db.js";
import { importQqPlaylist, searchQqSongs } from "./importers/qq.js";
import { parseLxImport } from "./importers/lx.js";
import { askAi, createWelcome, synthesizeSpeech } from "./services/openai.js";
import { getLxSourceHealth, loadLxSource, resolveLxMusicUrl } from "./services/lxSource.js";

export const api = express.Router();
const externalPlaybackCache = new NodeCache({ stdTTL: 60 * 15, checkperiod: 60 });

const trackInputSchema = z.object({
  title: z.string().min(1),
  artist: z.string().optional(),
  album: z.string().optional(),
  source: z.string().optional(),
  sourceId: z.string().optional(),
  songmid: z.string().optional(),
  hash: z.string().optional(),
  interval: z.string().optional(),
  duration: z.number().int().optional(),
  artwork: z.string().optional(),
  lyric: z.string().optional(),
  raw: z.unknown().optional(),
  directUrl: z.string().optional()
});

async function proxyAudio(url: string, req: express.Request, res: express.Response) {
  const upstream = await fetch(url, {
    headers: {
      accept: req.headers.accept || "audio/*,*/*;q=0.8",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      ...(req.headers.range ? { range: req.headers.range } : {})
    },
    redirect: "follow",
    signal: AbortSignal.timeout(35_000)
  });

  if (!upstream.ok && upstream.status !== 206) {
    const detail = await upstream.text().catch(() => "");
    throw new Error(`Audio upstream failed: ${upstream.status}${detail ? ` ${detail.slice(0, 120)}` : ""}`);
  }
  if (!upstream.body) throw new Error("Audio upstream returned empty body");

  const contentType = upstream.headers.get("content-type") || "audio/mpeg";
  if (/json|text\/html/i.test(contentType)) {
    const detail = await upstream.text().catch(() => "");
    throw new Error(`Audio upstream returned non-audio: ${detail.slice(0, 120) || contentType}`);
  }

  res.status(upstream.status === 206 ? 206 : 200);
  res.setHeader("content-type", contentType);
  res.setHeader("accept-ranges", upstream.headers.get("accept-ranges") || "bytes");
  const contentLength = upstream.headers.get("content-length");
  const contentRange = upstream.headers.get("content-range");
  if (contentLength) res.setHeader("content-length", contentLength);
  if (contentRange) res.setHeader("content-range", contentRange);
  try {
    await pipeline(Readable.fromWeb(upstream.body as unknown as Parameters<typeof Readable.fromWeb>[0]), res);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!res.headersSent) {
      throw new Error(`Audio stream interrupted: ${message}`);
    }
    res.destroy();
  }
}

api.get("/health", async (_req, res) => {
  const lx = getLxSourceHealth();
  if (!lx.ready && !lx.activeSource) {
    void loadLxSource().catch(() => undefined);
  }
  res.json({ ok: true, lx, time: new Date().toISOString() });
});

api.get("/playlists", (_req, res) => res.json({ playlists: listPlaylists() }));
api.get("/tracks", (_req, res) => res.json({ tracks: listTracks() }));
api.get("/queue", (_req, res) => res.json({ queue: listQueue() }));

api.post("/queue", (req, res) => {
  const body = z.object({ trackIds: z.array(z.number().int().positive()).min(1) }).parse(req.body);
  res.json({ queue: enqueueTracks(body.trackIds) });
});

api.patch("/queue/:id", (req, res) => {
  const params = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
  const body = z.object({ status: z.enum(["played", "skipped"]) }).parse(req.body);
  res.json({ queue: markQueueItem(params.id, body.status) });
});

api.post("/tracks", (req, res) => {
  const body = trackInputSchema.parse(req.body);
  res.json({ track: upsertTrack(body) });
});

api.delete("/tracks/:id", (req, res) => {
  const params = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
  res.json(removeTrack(params.id));
});

api.post("/playlists/:id/tracks", (req, res) => {
  const body = z.object({ trackId: z.number().int().positive().optional(), track: trackInputSchema.optional() }).parse(req.body);
  const playlist =
    req.params.id === "default" ? getDefaultFavoritesPlaylist() : getPlaylist(z.coerce.number().int().positive().parse(req.params.id));
  if (!playlist) throw new Error("Playlist not found");
  const track = body.trackId ? getTrack(body.trackId) : body.track ? upsertTrack(body.track) : undefined;
  if (!track) throw new Error("Track not found");
  addTrackToPlaylist(playlist.id, track.id);
  res.json({ playlist, track });
});

api.post("/import/lx", (req, res) => {
  const body = z.object({ payload: z.unknown(), name: z.string().optional() }).parse(req.body);
  const parsed = parseLxImport(body.payload);
  const playlist = upsertPlaylist(body.name || parsed.name, "lx", body.name || parsed.name);
  let imported = 0;
  let skipped = 0;
  const tracks = parsed.tracks.map((input, index) => {
    const track = upsertTrack(input);
    attachTrackToPlaylist(playlist.id, track.id, index);
    imported += 1;
    return track;
  });
  if (parsed.tracks.length === 0) skipped += 1;
  res.json({ playlist, imported, skipped, tracks, warnings: parsed.tracks.length ? [] : ["No LX songs found"] });
});

api.post("/import/qq-playlist", async (req, res, next) => {
  try {
    const body = z.object({ link: z.string().min(5) }).parse(req.body);
    const imported = await importQqPlaylist(body.link);
    const playlist = upsertPlaylist(imported.name, "qq", imported.externalId);
    const tracks = imported.tracks.map((input, index) => {
      const track = upsertTrack(input);
      attachTrackToPlaylist(playlist.id, track.id, index);
      return track;
    });
    res.json({ playlist, imported: tracks.length, skipped: 0, tracks, warnings: [] });
  } catch (error) {
    next(error);
  }
});

api.post("/music/search", async (req, res, next) => {
  try {
    const body = z.object({ query: z.string().min(1), limit: z.number().int().positive().max(20).default(6) }).parse(req.body);
    res.json({ tracks: await searchQqSongs(body.query, body.limit) });
  } catch (error) {
    next(error);
  }
});

api.post("/music/resolve", async (req, res, next) => {
  try {
    const body = z
      .object({
        trackId: z.number().int().positive().optional(),
        track: trackInputSchema.optional(),
        quality: z.string().default("128k")
      })
      .parse(req.body);
    const track = body.trackId ? getTrack(body.trackId) : body.track;
    if (!track) throw new Error("Track not found for resolve");
    const resolved = await resolveLxMusicUrl(track, body.quality);
    let playbackUrl = resolved.url;
    if (body.trackId) {
      playbackUrl = `/api/music/stream?trackId=${body.trackId}&quality=${encodeURIComponent(body.quality)}`;
    } else if (body.track) {
      const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      externalPlaybackCache.set(token, { url: resolved.url, track: body.track, quality: body.quality });
      playbackUrl = `/api/music/stream-external/${encodeURIComponent(token)}`;
    }
    res.json({ ...resolved, playbackUrl });
  } catch (error) {
    next(error);
  }
});

api.get("/music/stream", async (req, res, next) => {
  try {
    const query = z.object({ trackId: z.coerce.number().int().positive(), quality: z.string().default("128k") }).parse(req.query);
    const track = getTrack(query.trackId);
    if (!track) throw new Error("Track not found for stream");
    const resolved = await resolveLxMusicUrl(track, query.quality);
    await proxyAudio(resolved.url, req, res);
  } catch (error) {
    next(error);
  }
});

api.get("/music/stream-external/:token", async (req, res, next) => {
  try {
    const params = z.object({ token: z.string().min(1) }).parse(req.params);
    const cached = externalPlaybackCache.get<{ url: string }>(params.token);
    if (!cached?.url) throw new Error("External playback token expired, resolve the song again");
    await proxyAudio(cached.url, req, res);
  } catch (error) {
    next(error);
  }
});

api.post("/ai/chat", async (req, res, next) => {
  try {
    const body = z
      .object({
        message: z.string().min(1),
        context: z
          .object({
            city: z.string().optional(),
            weather: z.string().optional(),
            mood: z.string().optional(),
            timeSlot: z.string().optional(),
            currentTrack: z
              .object({ id: z.number(), title: z.string(), artist: z.string().optional(), source: z.string().optional() })
              .nullable()
              .optional()
          })
          .optional(),
        allowExternal: z.boolean().default(true)
      })
      .parse(req.body);
    const action = await askAi(body.message, { context: body.context, allowExternal: body.allowExternal });
    if (action.queueTrackIds?.length) enqueueTracks(action.queueTrackIds);

    let externalCandidates: Awaited<ReturnType<typeof searchQqSongs>> = [];
    let externalSearchError: string | undefined;
    if (body.allowExternal && action.externalSearchQuery) {
      try {
        externalCandidates = await searchQqSongs(action.externalSearchQuery, 4);
      } catch (error) {
        externalSearchError = error instanceof Error ? error.message : String(error);
      }
    }

    res.json({ action, queue: listQueue(), externalCandidates, externalSearchError });
  } catch (error) {
    next(error);
  }
});

api.post("/ai/welcome", async (req, res, next) => {
  try {
    const body = z
      .object({
        context: z
          .object({
            city: z.string().optional(),
            weather: z.string().optional(),
            mood: z.string().optional(),
            timeSlot: z.string().optional(),
            currentTrack: z
              .object({ id: z.number(), title: z.string(), artist: z.string().optional(), source: z.string().optional() })
              .nullable()
              .optional()
          })
          .optional(),
        trackCount: z.number().int().nonnegative().optional()
      })
      .parse(req.body);
    res.json(await createWelcome({ context: body.context, trackCount: body.trackCount }));
  } catch (error) {
    next(error);
  }
});

api.post("/tts", async (req, res, next) => {
  try {
    const body = z.object({ text: z.string().min(1).max(1000) }).parse(req.body);
    res.json(await synthesizeSpeech(body.text));
  } catch (error) {
    next(error);
  }
});
