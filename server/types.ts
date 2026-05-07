export type MusicSource = "tx" | "wy" | "kw" | "kg" | "mg" | "url" | string;

export interface TrackInput {
  title: string;
  artist?: string;
  album?: string;
  source?: MusicSource;
  sourceId?: string;
  songmid?: string;
  hash?: string;
  interval?: string;
  duration?: number;
  artwork?: string;
  lyric?: string;
  raw?: unknown;
  directUrl?: string;
}

export interface Track extends TrackInput {
  id: number;
  createdAt: string;
  updatedAt: string;
}

export interface Playlist {
  id: number;
  name: string;
  source: string;
  externalId?: string;
  createdAt: string;
}

export interface ImportResult {
  playlist: Playlist;
  imported: number;
  skipped: number;
  tracks: Track[];
  warnings: string[];
}

export interface QueueItem {
  id: number;
  trackId: number;
  position: number;
  status: "queued" | "played" | "skipped";
  createdAt: string;
  track: Track;
}

export interface AiMessage {
  id: number;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface AiMemoryState {
  activeSessionId?: string;
  lastSummaryMessageId: number;
  lastSummaryAt?: string;
}
