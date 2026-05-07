import type { TrackInput } from "../types.js";
import zlib from "node:zlib";

function asString(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nestedObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function sourceFromItem(item: Record<string, unknown>): string {
  return asString(item.source) || asString(item.platform) || asString(item.type) || "tx";
}

export function normalizeLxTrack(item: Record<string, unknown>): TrackInput | null {
  const meta = nestedObject(item.meta);
  const title = asString(item.name) || asString(item.title) || asString(item.songName);
  if (!title) return null;
  const hasTrackSignal = Boolean(
    item.source ||
      item.platform ||
      item.songmid ||
      item.mid ||
      item.hash ||
      item.url ||
      item.singer ||
      item.artist ||
      item.albumName ||
      meta.albumName ||
      item.duration ||
      item.interval
  );
  if (!hasTrackSignal) return null;
  const singer = item.singer;
  const artist =
    asString(item.artist) ||
    asString(item.author) ||
    (Array.isArray(singer) ? singer.map((entry) => asString(entry)).filter(Boolean).join(" / ") : asString(singer));

  return {
    title,
    artist,
    album: asString(item.albumName) || asString(meta.albumName) || asString(item.album),
    source: sourceFromItem(item),
    sourceId: asString(item.songmid) || asString(item.id) || asString(item.mid) || asString(item.hash) || asString(meta.songId),
    songmid: asString(item.songmid) || asString(item.mid) || asString(meta.songId),
    hash: asString(item.hash),
    interval: asString(item.interval),
    duration: asNumber(item.duration),
    artwork: asString(item.img) || asString(item.pic) || asString(item.artwork) || asString(meta.picUrl),
    directUrl: asString(item.url),
    raw: item
  };
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function parseCsv(input: string): TrackInput[] {
  const lines = input.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  const titleIndex = headers.findIndex((header) => ["歌曲名", "歌名", "name", "title"].includes(header));
  const artistIndex = headers.findIndex((header) => ["艺术家", "歌手", "artist", "singer"].includes(header));
  const albumIndex = headers.findIndex((header) => ["专辑名", "专辑", "album"].includes(header));
  return lines
    .slice(1)
    .map<TrackInput | null>((line) => {
      const cells = parseCsvLine(line);
      const title = cells[titleIndex >= 0 ? titleIndex : 0];
      if (!title) return null;
      const track: TrackInput = {
        title,
        artist: artistIndex >= 0 ? cells[artistIndex] : undefined,
        album: albumIndex >= 0 ? cells[albumIndex] : undefined,
        source: "tx",
        raw: { csv: cells }
      };
      return track;
    })
    .filter((track): track is TrackInput => Boolean(track));
}

function decodePayload(input: unknown): unknown {
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) return JSON.parse(trimmed);
    if (trimmed.includes("\n") && trimmed.includes(",")) return { csvTracks: parseCsv(trimmed) };
    return JSON.parse(trimmed);
  }

  const maybeFile = nestedObject(input);
  if (asString(maybeFile.base64)) {
    const buffer = Buffer.from(asString(maybeFile.base64)!, "base64");
    const decoded = buffer[0] === 0x1f && buffer[1] === 0x8b ? zlib.gunzipSync(buffer).toString("utf8") : buffer.toString("utf8");
    if (asString(maybeFile.fileName)?.toLowerCase().endsWith(".csv") || decoded.includes("歌曲名,艺术家")) {
      return { csvTracks: parseCsv(decoded) };
    }
    return JSON.parse(decoded);
  }

  return input;
}

function collectTracks(value: unknown, tracks: TrackInput[], seen: Set<unknown>) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((entry) => collectTracks(entry, tracks, seen));
    return;
  }

  const objectValue = value as Record<string, unknown>;
  const track = normalizeLxTrack(objectValue);
  if (track) tracks.push(track);

  for (const key of ["list", "tracks", "songs", "musicList", "data"]) {
    collectTracks(objectValue[key], tracks, seen);
  }
}

export function parseLxImport(input: unknown): { name: string; tracks: TrackInput[] } {
  const parsed = decodePayload(input);
  if (nestedObject(parsed).csvTracks) {
    return {
      name: "CSV 导入列表",
      tracks: nestedObject(parsed).csvTracks as TrackInput[]
    };
  }
  const tracks: TrackInput[] = [];
  collectTracks(parsed, tracks, new Set());
  const name =
    typeof parsed === "object" && parsed && !Array.isArray(parsed)
      ? asString((parsed as Record<string, unknown>).name) ||
        asString((parsed as Record<string, unknown>).title) ||
        asString(nestedObject((parsed as Record<string, unknown>).data).name)
      : undefined;
  return { name: name || "LX 导入列表", tracks };
}
