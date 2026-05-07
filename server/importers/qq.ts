import type { TrackInput } from "../types.js";

export function extractQqPlaylistId(input: string): string | null {
  const decoded = decodeURIComponent(input);
  const patterns = [/disstid=(\d+)/i, /playlist\/(\d+)/i, /taoge\/(\d+)/i, /id=(\d+)/i, /\/(\d{5,})(?:\D|$)/];
  for (const pattern of patterns) {
    const match = decoded.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

function stripJsonp(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const start = trimmed.indexOf("(");
  const end = trimmed.lastIndexOf(")");
  if (start === -1 || end === -1 || end <= start) throw new Error("QQ 音乐返回内容不是 JSON");
  return JSON.parse(trimmed.slice(start + 1, end));
}

export function mapQqSong(song: Record<string, unknown>): TrackInput | null {
  const title = typeof song.songname === "string" ? song.songname : typeof song.name === "string" ? song.name : undefined;
  if (!title) return null;
  const singer = Array.isArray(song.singer)
    ? song.singer
        .map((entry) => (entry && typeof entry === "object" ? (entry as Record<string, unknown>).name : entry))
        .filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
        .join(" / ")
    : undefined;
  const album = song.albumname || (song.album && typeof song.album === "object" ? (song.album as Record<string, unknown>).name : undefined);
  const songmid = typeof song.songmid === "string" ? song.songmid : typeof song.mid === "string" ? song.mid : undefined;
  return {
    title,
    artist: singer,
    album: typeof album === "string" ? album : undefined,
    source: "tx",
    sourceId: songmid || String(song.songid || song.id || ""),
    songmid,
    interval: typeof song.interval === "number" ? String(song.interval) : undefined,
    duration: typeof song.interval === "number" ? song.interval : undefined,
    artwork:
      song.albummid && typeof song.albummid === "string"
        ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${song.albummid}.jpg`
        : undefined,
    raw: song
  };
}

export async function searchQqSongs(keyword: string, limit = 6): Promise<TrackInput[]> {
  const response = await fetch("https://u.y.qq.com/cgi-bin/musicu.fcg", {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: {
      "content-type": "application/json",
      referer: "https://y.qq.com/",
      origin: "https://y.qq.com",
      "user-agent": "Mozilla/5.0 HuiMusicRadio/1.0"
    },
    body: JSON.stringify({
      req_1: {
        method: "DoSearchForQQMusicDesktop",
        module: "music.search.SearchCgiService",
        param: {
          query: keyword,
          page_num: 1,
          num_per_page: Math.max(1, Math.min(limit, 20)),
          search_type: 0
        }
      }
    })
  });
  if (!response.ok) throw new Error(`QQ Music search failed: ${response.status}`);
  const payload = (await response.json()) as Record<string, unknown>;
  const req = payload.req_1 && typeof payload.req_1 === "object" ? (payload.req_1 as Record<string, unknown>) : {};
  const data = req.data && typeof req.data === "object" ? (req.data as Record<string, unknown>) : {};
  const body = data.body && typeof data.body === "object" ? (data.body as Record<string, unknown>) : data;
  const song = body.song && typeof body.song === "object" ? (body.song as Record<string, unknown>) : {};
  const list = Array.isArray(song.list) ? song.list : [];
  return list
    .map((entry) => (entry && typeof entry === "object" ? mapQqSong(entry as Record<string, unknown>) : null))
    .filter((track): track is TrackInput => Boolean(track))
    .slice(0, limit);
}

async function fetchQqPlaylistPayload(id: string): Promise<Record<string, unknown>> {
  const bases = [
    "https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg",
    "https://i.y.qq.com/qzone-music/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg"
  ];
  let lastError: Error | null = null;

  for (const base of bases) {
    try {
      const api = new URL(base);
      api.search = new URLSearchParams({
        type: "1",
        json: "1",
        utf8: "1",
        onlysong: "0",
        disstid: id,
        format: "jsonp",
        jsonpCallback: "playlistinfoCallback",
        g_tk: "5381",
        loginUin: "0",
        hostUin: "0",
        inCharset: "utf8",
        outCharset: "utf-8",
        notice: "0",
        platform: "yqq",
        needNewCode: "0"
      }).toString();

      const response = await fetch(api, {
        signal: AbortSignal.timeout(12_000),
        headers: {
          referer: "https://y.qq.com/",
          origin: "https://y.qq.com",
          "user-agent": "Mozilla/5.0 HuiMusicRadio/1.0"
        }
      });
      if (!response.ok) throw new Error(`QQ Music request failed: ${response.status}`);
      const payload = stripJsonp(await response.text()) as Record<string, unknown>;
      const cdlist = Array.isArray(payload.cdlist) ? payload.cdlist : [];
      if (cdlist.length > 0) return payload;
      lastError = new Error("QQ Music returned an empty playlist payload");
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError || new Error("QQ Music playlist request failed");
}

export async function importQqPlaylist(link: string): Promise<{ name: string; externalId: string; tracks: TrackInput[] }> {
  const id = extractQqPlaylistId(link);
  if (!id) throw new Error("无法从链接中识别 QQ 音乐歌单 ID");

  const payload = await fetchQqPlaylistPayload(id);
  const cdlist = Array.isArray(payload.cdlist) ? (payload.cdlist as Record<string, unknown>[]) : [];
  const playlist = cdlist[0];
  if (!playlist) throw new Error("QQ 音乐没有返回歌单内容，可能需要登录、公开歌单链接，或平台接口已变化");
  const tracks = (Array.isArray(playlist.songlist) ? playlist.songlist : [])
    .map((song) => (song && typeof song === "object" ? mapQqSong(song as Record<string, unknown>) : null))
    .filter((song): song is TrackInput => Boolean(song));

  return {
    name: typeof playlist.dissname === "string" ? playlist.dissname : `QQ 歌单 ${id}`,
    externalId: id,
    tracks
  };
}
