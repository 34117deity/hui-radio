import type { AiAction, AiContext, Playlist, QueueItem, Track, TrackInput } from "./types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data as T;
}

export const radioApi = {
  tracks: () => request<{ tracks: Track[] }>("/api/tracks"),
  playlists: () => request<{ playlists: Playlist[] }>("/api/playlists"),
  queue: () => request<{ queue: QueueItem[] }>("/api/queue"),
  enqueue: (trackIds: number[]) =>
    request<{ queue: QueueItem[] }>("/api/queue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trackIds })
    }),
  markQueue: (queueId: number, status: "played" | "skipped") =>
    request<{ queue: QueueItem[] }>(`/api/queue/${queueId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status })
    }),
  resolve: (payload: { trackId?: number; track?: TrackInput; quality?: string }) =>
    request<{ url: string; playbackUrl?: string; cached: boolean; sourceReady: boolean }>("/api/music/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quality: "128k", ...payload })
    }),
  searchMusic: (query: string, limit = 6) =>
    request<{ tracks: TrackInput[] }>("/api/music/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, limit })
    }),
  saveTrack: (track: TrackInput) =>
    request<{ track: Track }>("/api/tracks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(track)
    }),
  removeTrack: (trackId: number) =>
    request<{ trackId: number; queue: QueueItem[] }>(`/api/tracks/${trackId}`, {
      method: "DELETE"
    }),
  favorite: (payload: { trackId?: number; track?: TrackInput }) =>
    request<{ playlist: Playlist; track: Track }>("/api/playlists/default/tracks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    }),
  askAi: (message: string, context: AiContext, allowExternal = true) =>
    request<{ action: AiAction; queue: QueueItem[]; externalCandidates: TrackInput[]; externalSearchError?: string }>("/api/ai/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, context, allowExternal })
    }),
  welcome: (context: AiContext, trackCount: number) =>
    request<{ say: string }>("/api/ai/welcome", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ context, trackCount })
    }),
  tts: (text: string) =>
    request<{ url: string; cached: boolean }>("/api/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text })
    }),
  importQq: (link: string) =>
    request<{ imported: number }>("/api/import/qq-playlist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ link })
    }),
  importLx: (payload: unknown, name?: string) =>
    request<{ imported: number; warnings: string[] }>("/api/import/lx", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload, name })
    })
};
