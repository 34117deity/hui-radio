export interface TrackInput {
  title: string;
  artist?: string;
  album?: string;
  source?: string;
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
  createdAt?: string;
  updatedAt?: string;
}

export type PlayableTrack = Track | TrackInput;

export interface Playlist {
  id: number;
  name: string;
  source: string;
  externalId?: string;
  createdAt: string;
}

export interface QueueItem {
  id: number;
  trackId: number;
  position: number;
  status: "queued" | "played" | "skipped";
  createdAt: string;
  track: Track;
}

export interface AiContext {
  city?: string;
  weather?: string;
  mood?: string;
  timeSlot?: string;
  currentTrack?: Pick<Track, "id" | "title" | "artist" | "source"> | null;
}

export interface AiAction {
  say: string;
  playTrackId?: number | null;
  reason?: string;
  queueTrackIds?: number[];
  externalSearchQuery?: string | null;
}

export interface ReplySegment {
  text: string;
  tone?: "primary" | "muted" | "highlight";
  timeLabel?: string;
}

export interface ChatEntry {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  time: string;
  loading?: boolean;
  segments?: ReplySegment[];
  candidates?: TrackInput[];
}
