import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import type { Playlist, QueueItem, Track, TrackInput } from "./types.js";

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.cacheDir, { recursive: true });
fs.mkdirSync(config.ttsCacheDir, { recursive: true });

export const db = new Database(process.env.VITEST ? ":memory:" : path.join(config.dataDir, "hui-radio.sqlite"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS playlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  external_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source, external_id)
);

CREATE TABLE IF NOT EXISTS tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  artist TEXT,
  album TEXT,
  source TEXT NOT NULL DEFAULT 'url',
  source_id TEXT,
  songmid TEXT,
  hash TEXT,
  interval TEXT,
  duration INTEGER,
  artwork TEXT,
  lyric TEXT,
  direct_url TEXT,
  raw_json TEXT,
  removed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS playlist_tracks (
  playlist_id INTEGER NOT NULL,
  track_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, track_id),
  FOREIGN KEY (playlist_id) REFERENCES playlists(id),
  FOREIGN KEY (track_id) REFERENCES tracks(id)
);

CREATE TABLE IF NOT EXISTS queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (track_id) REFERENCES tracks(id)
);

CREATE TABLE IF NOT EXISTS plays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id INTEGER NOT NULL,
  played_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reason TEXT,
  FOREIGN KEY (track_id) REFERENCES tracks(id)
);

CREATE TABLE IF NOT EXISTS ai_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tracks_identity
ON tracks (
  source,
  COALESCE(source_id, ''),
  COALESCE(songmid, ''),
  COALESCE(hash, ''),
  title,
  COALESCE(artist, '')
);
`);

const trackColumns = db.prepare("PRAGMA table_info(tracks)").all() as Array<{ name: string }>;
if (!trackColumns.some((column) => column.name === "removed_at")) {
  db.prepare("ALTER TABLE tracks ADD COLUMN removed_at TEXT").run();
}

const playlistRow = (row: Record<string, unknown>): Playlist => ({
  id: Number(row.id),
  name: String(row.name),
  source: String(row.source),
  externalId: row.external_id ? String(row.external_id) : undefined,
  createdAt: String(row.created_at)
});

const trackRow = (row: Record<string, unknown>): Track => ({
  id: Number(row.id),
  title: String(row.title),
  artist: row.artist ? String(row.artist) : undefined,
  album: row.album ? String(row.album) : undefined,
  source: row.source ? String(row.source) : "url",
  sourceId: row.source_id ? String(row.source_id) : undefined,
  songmid: row.songmid ? String(row.songmid) : undefined,
  hash: row.hash ? String(row.hash) : undefined,
  interval: row.interval ? String(row.interval) : undefined,
  duration: row.duration ? Number(row.duration) : undefined,
  artwork: row.artwork ? String(row.artwork) : undefined,
  lyric: row.lyric ? String(row.lyric) : undefined,
  directUrl: row.direct_url ? String(row.direct_url) : undefined,
  raw: row.raw_json ? JSON.parse(String(row.raw_json)) : undefined,
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at)
});

export function upsertPlaylist(name: string, source: string, externalId = ""): Playlist {
  db.prepare(
    `INSERT INTO playlists (name, source, external_id)
     VALUES (?, ?, ?)
     ON CONFLICT(source, external_id) DO UPDATE SET name=excluded.name`
  ).run(name, source, externalId);
  return playlistRow(
    db.prepare("SELECT * FROM playlists WHERE source = ? AND external_id = ?").get(source, externalId) as Record<string, unknown>
  );
}

export function upsertTrack(input: TrackInput): Track {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO tracks
      (title, artist, album, source, source_id, songmid, hash, interval, duration, artwork, lyric, direct_url, raw_json)
     VALUES
      (@title, @artist, @album, @source, @sourceId, @songmid, @hash, @interval, @duration, @artwork, @lyric, @directUrl, @rawJson)`
  );
  const params = {
    title: input.title.trim(),
    artist: input.artist?.trim() || null,
    album: input.album?.trim() || null,
    source: input.source || "url",
    sourceId: input.sourceId || null,
    songmid: input.songmid || null,
    hash: input.hash || null,
    interval: input.interval || null,
    duration: input.duration || null,
    artwork: input.artwork || null,
    lyric: input.lyric || null,
    directUrl: input.directUrl || null,
    rawJson: input.raw ? JSON.stringify(input.raw) : null
  };
  const info = insert.run(params);

  const row =
    info.lastInsertRowid && Number(info.lastInsertRowid) > 0
      ? db.prepare("SELECT * FROM tracks WHERE id = ?").get(info.lastInsertRowid)
      : db
          .prepare(
            `SELECT * FROM tracks
             WHERE source = @source
               AND COALESCE(source_id, '') = COALESCE(@sourceId, '')
               AND COALESCE(songmid, '') = COALESCE(@songmid, '')
               AND COALESCE(hash, '') = COALESCE(@hash, '')
               AND title = @title
               AND COALESCE(artist, '') = COALESCE(@artist, '')`
          )
          .get(params);
  const track = trackRow(row as Record<string, unknown>);
  db.prepare("UPDATE tracks SET removed_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(track.id);
  return getTrack(track.id) || track;
}

export function attachTrackToPlaylist(playlistId: number, trackId: number, position: number) {
  db.prepare("INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)").run(
    playlistId,
    trackId,
    position
  );
}

export function addTrackToPlaylist(playlistId: number, trackId: number) {
  const maxPos = Number(
    (db.prepare("SELECT COALESCE(MAX(position), -1) AS pos FROM playlist_tracks WHERE playlist_id = ?").get(playlistId) as { pos: number }).pos
  );
  attachTrackToPlaylist(playlistId, trackId, maxPos + 1);
}

export function getDefaultFavoritesPlaylist(): Playlist {
  return upsertPlaylist("我喜欢的歌", "local", "favorites");
}

export function listPlaylists(): Playlist[] {
  return (db.prepare("SELECT * FROM playlists ORDER BY created_at DESC").all() as Record<string, unknown>[]).map(playlistRow);
}

export function getPlaylist(id: number): Playlist | undefined {
  const row = db.prepare("SELECT * FROM playlists WHERE id = ?").get(id);
  return row ? playlistRow(row as Record<string, unknown>) : undefined;
}

export function listTracks(limit = 200): Track[] {
  return (db.prepare("SELECT * FROM tracks WHERE removed_at IS NULL ORDER BY created_at DESC LIMIT ?").all(limit) as Record<string, unknown>[]).map(trackRow);
}

export function getTrack(id: number): Track | undefined {
  const row = db.prepare("SELECT * FROM tracks WHERE id = ? AND removed_at IS NULL").get(id);
  return row ? trackRow(row as Record<string, unknown>) : undefined;
}

export function removeTrack(trackId: number): { trackId: number; queue: QueueItem[] } {
  const existing = db.prepare("SELECT id FROM tracks WHERE id = ? AND removed_at IS NULL").get(trackId);
  if (!existing) throw new Error("Track not found");
  const tx = db.transaction((id: number) => {
    db.prepare("UPDATE tracks SET removed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
    db.prepare("DELETE FROM playlist_tracks WHERE track_id = ?").run(id);
    db.prepare("UPDATE queue SET status = 'skipped' WHERE track_id = ? AND status = 'queued'").run(id);
  });
  tx(trackId);
  return { trackId, queue: listQueue() };
}

export function enqueueTracks(trackIds: number[]): QueueItem[] {
  const maxPos = Number((db.prepare("SELECT COALESCE(MAX(position), 0) AS pos FROM queue").get() as { pos: number }).pos);
  const insert = db.prepare("INSERT INTO queue (track_id, position) VALUES (?, ?)");
  const tx = db.transaction((ids: number[]) => ids.forEach((id, index) => insert.run(id, maxPos + index + 1)));
  tx(trackIds);
  return listQueue();
}

export function markQueueItem(queueId: number, status: "played" | "skipped"): QueueItem[] {
  const row = db.prepare("SELECT track_id FROM queue WHERE id = ?").get(queueId) as { track_id?: number } | undefined;
  db.prepare("UPDATE queue SET status = ? WHERE id = ?").run(status, queueId);
  if (status === "played" && row?.track_id) {
    db.prepare("INSERT INTO plays (track_id, reason) VALUES (?, ?)").run(row.track_id, "queue");
  }
  return listQueue();
}

export function listQueue(): QueueItem[] {
  const rows = db
    .prepare(
      `SELECT q.id AS queue_id, q.track_id, q.position, q.status, q.created_at AS queue_created_at, t.*
       FROM queue q JOIN tracks t ON t.id = q.track_id
       WHERE q.status = 'queued' AND t.removed_at IS NULL
       ORDER BY q.position ASC`
    )
    .all() as Record<string, unknown>[];

  return rows.map((row) => ({
    id: Number(row.queue_id),
    trackId: Number(row.track_id),
    position: Number(row.position),
    status: String(row.status) as QueueItem["status"],
    createdAt: String(row.queue_created_at),
    track: trackRow(row)
  }));
}

export function saveAiMessage(role: "user" | "assistant", content: string) {
  db.prepare("INSERT INTO ai_messages (role, content) VALUES (?, ?)").run(role, content);
}
