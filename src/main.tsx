import React, { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Heart,
  ListMusic,
  Moon,
  Pause,
  Play,
  Radio,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Settings,
  SkipBack,
  SkipForward,
  Square,
  Sun,
  Trash2,
  Upload,
  Volume1,
  Volume2,
  X
} from "lucide-react";
import { radioApi } from "./api";
import { loadPreferences, pickPreferenceWeightedTrack, recordPreferenceEvent, savePreferences } from "./preferences";
import type { Preferences } from "./preferences";
import type { AiContext, ChatEntry, PlayableTrack, ReplySegment, Track, TrackInput } from "./types";
import "./styles.css";

type UiLogLevel = "info" | "warn" | "error";

type UiLog = {
  id: string;
  level: UiLogLevel;
  scope: string;
  message: string;
  time: string;
};

type PlayTrackOptions = {
  persist?: boolean;
  source?: string;
};

function isSavedTrack(track: PlayableTrack | null): track is Track {
  return Boolean(track && typeof (track as Track).id === "number" && (track as Track).id > 0);
}

function formatClock(date: Date) {
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).replace(":", " : ");
}

function formatDate(date: Date) {
  return date.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "2-digit", year: "numeric" });
}

function formatDuration(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0:00";
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60)
    .toString()
    .padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function makeChatId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function nowLabel() {
  return new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function normalizeText(value: string) {
  return value
    .toLowerCase()
    .replace(/[\u300a\u300b\u300c\u300d\u300e\u300f\u201c\u201d\u2018\u2019"'`()[\]\s]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function asErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function extractRequestSafe(input: string) {
  const trimmed = input.trim();
  if (!trimmed) return { title: "", artist: "" };
  const quoted = trimmed.match(/[\u300a\u300c\u300e\u201c\u2018"]([^\u300b\u300d\u300f\u201d\u2019"]+)[\u300b\u300d\u300f\u201d\u2019"]/)?.[1] || "";
  const titleFromCommand = trimmed.match(/(?:\u64ad\u653e|\u70b9\u64ad|\u6765\u4e00\u9996|\u60f3\u542c)\s*([^\s\uff0c\u3002\uff01\uff1f,.!?]{1,32})/)?.[1] || "";
  const artist = trimmed.match(/(?:by|\u6b4c\u624b|\u5531\u7684|\u7248\u672c|\u539f\u5531)\s*([^\s\uff0c\u3002\uff01\uff1f,.!?]+)/i)?.[1] || "";
  let title = (quoted || titleFromCommand).trim();
  title = title.replace(/(\u7136\u540e|\u4f46\u662f|\u4e0d\u8fc7|\u7ed9\u6211|\u987a\u4fbf).*$/u, "").trim();
  return { title, artist: artist.trim() };
}

function buildReplySegments(text: string): ReplySegment[] {
  const clean = text.trim();
  if (!clean) return [];
  const parts = clean
    .split(/(?<=[\u3002\uff01\uff1f!?])\s*|\n+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  const source = parts.length ? parts : [clean];
  const keywordPattern = /(Hui Radio|\u73b0\u5728|\u4eca\u665a|\u5f53\u524d|\u4e0b\u4e00\u9996|\u9002\u5408|\u63a8\u8350|\u64ad\u653e|\u5929\u6c14|\u5fc3\u60c5|\u57ce\u5e02|\u6b4c\u5355|\u66f2\u5e93|ON AIR|\u6b63\u5728\u8c03\u9891)/gi;
  return source.flatMap((part, sentenceIndex) => {
    const sentenceTone: ReplySegment["tone"] = sentenceIndex === 0 ? "primary" : "muted";
    const pieces: ReplySegment[] = [];
    let cursor = 0;
    for (const match of part.matchAll(keywordPattern)) {
      const index = match.index ?? 0;
      if (index > cursor) pieces.push({ text: part.slice(cursor, index), tone: sentenceTone });
      pieces.push({ text: match[0], tone: "highlight" });
      cursor = index + match[0].length;
    }
    if (cursor < part.length) pieces.push({ text: part.slice(cursor), tone: sentenceTone });
    if (sentenceIndex < source.length - 1) pieces.push({ text: "\n", tone: "muted" });
    return pieces;
  });
}

function RadioTranscriptBubble({ entry }: { entry: ChatEntry }) {
  if (entry.loading) {
    return (
      <div className="bubble transcript-bubble is-loading">
        <span>{"\u6b63\u5728\u8c03\u9891"}</span>
        <i />
        <i />
        <i />
      </div>
    );
  }

  const segments = entry.segments?.length ? entry.segments : buildReplySegments(entry.text);
  return (
    <div className="bubble transcript-bubble">
      {segments.map((segment, index) => (
        <span
          key={`${segment.text}-${index}`}
          className={`reply-segment ${segment.tone || "muted"} ${segment.timeLabel ? "with-time" : ""}`}
          data-time={segment.timeLabel}
        >
          {segment.text}
        </span>
      ))}
    </div>
  );
}

function scoreCandidate(track: TrackInput, requestedTitle: string, requestedArtist: string) {
  const title = normalizeText(track.title || "");
  const artist = normalizeText(track.artist || "");
  const reqTitle = normalizeText(requestedTitle);
  const reqArtist = normalizeText(requestedArtist);

  let score = 0;
  if (reqTitle) {
    if (title === reqTitle) score += 100;
    else if (title.includes(reqTitle) || reqTitle.includes(title)) score += 70;
  }
  if (reqArtist) {
    if (artist === reqArtist) score += 45;
    else if (artist.includes(reqArtist) || reqArtist.includes(artist)) score += 25;
  }
  return score;
}

function pickBestCandidate(candidates: TrackInput[], title: string, artist: string) {
  return [...candidates]
    .map((candidate) => ({ candidate, score: scoreCandidate(candidate, title, artist) }))
    .sort((a, b) => b.score - a.score)[0];
}

function pickBestLocalTrack(candidates: Track[], title: string, artist: string) {
  return [...candidates]
    .map((candidate) => ({ candidate, score: scoreCandidate(candidate, title, artist) }))
    .sort((a, b) => b.score - a.score)[0];
}

const waveBars = Array.from({ length: 36 }, (_, index) => 18 + Math.round(Math.abs(Math.sin(index * 0.72)) * 26 + Math.abs(Math.cos(index * 0.27)) * 18));

function App() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [favorites, setFavorites] = useState<Set<number>>(new Set());
  const [preferences, setPreferences] = useState(() => loadPreferences());
  const [current, setCurrent] = useState<PlayableTrack | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [status, setStatus] = useState("Hui Radio backend online");
  const [theme, setTheme] = useState<"theme-dark" | "theme-light">("theme-dark");
  const [collapsed, setCollapsed] = useState(false);
  const [backendOpen, setBackendOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [city, setCity] = useState("");
  const [weather, setWeather] = useState("");
  const [mood, setMood] = useState("");
  const [timeSlot, setTimeSlot] = useState("");
  const [qqLink, setQqLink] = useState("");
  const [lxPayload, setLxPayload] = useState("");
  const [removingTrackIds, setRemovingTrackIds] = useState<number[]>([]);
  const [chat, setChat] = useState<ChatEntry[]>([
    {
      id: "welcome",
      role: "assistant",
      text: "",
      time: nowLabel(),
      loading: true
    }
  ]);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.72);
  const [ttsVolume, setTtsVolume] = useState(1);
  const [clock, setClock] = useState(new Date());
  const [logs, setLogs] = useState<UiLog[]>([]);
  const [logOpen, setLogOpen] = useState(false);

  const audioRef = useRef<HTMLAudioElement>(null);
  const voiceAudioRef = useRef<HTMLAudioElement>(null);
  const playbackTokenRef = useRef(0);

  const currentTitle = current?.title || "No song selected";
  const currentArtist = current?.artist || current?.source || "Hui Radio";
  const currentSavedTrackId = isSavedTrack(current) ? current.id : null;
  const currentIsFavorited = currentSavedTrackId !== null && favorites.has(currentSavedTrackId);
  const currentMotionKey = `${currentTitle}-${currentArtist}-${currentSavedTrackId || "external"}`;

  const aiContext: AiContext = useMemo(
    () => ({
      city: city.trim() || undefined,
      weather: weather.trim() || undefined,
      mood: mood.trim() || undefined,
      timeSlot: timeSlot.trim() || undefined,
      currentTrack: isSavedTrack(current)
        ? { id: current.id, title: current.title, artist: current.artist, source: current.source }
        : null
    }),
    [city, current, mood, timeSlot, weather]
  );

  const pushStatus = (next: string, level: UiLogLevel = "info", scope = "system") => {
    setStatus(next);
    const item: UiLog = {
      id: makeChatId(),
      level,
      scope,
      message: next,
      time: nowLabel()
    };
    setLogs((prev) => [item, ...prev].slice(0, 60));
  };

  const reportError = (scope: string, error: unknown) => {
    pushStatus(asErrorMessage(error), "error", scope);
    setLogOpen(true);
  };

  const recordUserPreference = (track: PlayableTrack | null, event: Parameters<typeof recordPreferenceEvent>[2]): Preferences | null => {
    if (!track) return null;
    const next = recordPreferenceEvent(preferences, track, event);
    savePreferences(next);
    setPreferences(next);
    return next;
  };

  const refresh = async () => {
    const [tracksData, playlistsData] = await Promise.all([
      radioApi.tracks(),
      radioApi.playlists()
    ]);
    setTracks(tracksData.tracks);
    const defaultPlaylist = playlistsData.playlists.find((p) => p.name === "default");
    if (defaultPlaylist?.trackIds) {
      setFavorites(new Set(defaultPlaylist.trackIds));
    }
  };

  useEffect(() => {
    refresh().catch((error) => reportError("refresh", error));
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, []);

  useEffect(() => {
    let cancelled = false;
    radioApi
      .welcome(aiContext, tracks.length)
      .then((data) => {
        if (cancelled) return;
        setChat((prev) =>
          prev.map((entry) =>
            entry.id === "welcome"
              ? { ...entry, text: data.say, loading: false, segments: buildReplySegments(data.say), time: nowLabel() }
              : entry
          )
        );
      })
      .catch(() => {
        if (cancelled) return;
        const fallback = "这里是 Hui Radio。正在把今晚的歌单调到柔和一点，你可以告诉我城市、天气或心情，我来接住下一首。";
        setChat((prev) =>
          prev.map((entry) =>
            entry.id === "welcome" ? { ...entry, text: fallback, loading: false, segments: buildReplySegments(fallback), time: nowLabel() } : entry
          )
        );
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  useEffect(() => {
    if (voiceAudioRef.current) voiceAudioRef.current.volume = ttsVolume;
  }, [ttsVolume]);

  useEffect(() => {
    if (!backendOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setBackendOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [backendOpen]);

  const resolvePlayable = async (track: PlayableTrack) => {
    if (isSavedTrack(track)) return radioApi.resolve({ trackId: track.id });
    return radioApi.resolve({ track });
  };

  const cacheBustPlaybackUrl = (url: string) => {
    if (!url.startsWith("/api/music/stream")) return url;
    return `${url}${url.includes("?") ? "&" : "?"}play=${Date.now()}`;
  };

  const saveTrackIfNeeded = async (track: PlayableTrack) => {
    if (isSavedTrack(track)) return track;
    const data = await radioApi.saveTrack(track);
    setTracks((prev) => [data.track, ...prev.filter((item) => item.id !== data.track.id)]);
    await refresh();
    return data.track;
  };

  const playTrack = async (track: PlayableTrack, options?: PlayTrackOptions) => {
    const token = ++playbackTokenRef.current;
    const persist = options?.persist !== false;
    pushStatus(`Resolving ${track.title}`, "info", options?.source || "player");

    let targetTrack = track;
    if (!isSavedTrack(track) && persist) {
      targetTrack = await saveTrackIfNeeded(track);
    }
    let data: Awaited<ReturnType<typeof resolvePlayable>>;
    try {
      data = await resolvePlayable(targetTrack);
    } catch (error) {
      if (isSavedTrack(targetTrack)) {
        const query = `${targetTrack.title} ${targetTrack.artist || ""}`.trim();
        const external = await radioApi.searchMusic(query, 6);
        const best = pickBestCandidate(external.tracks, targetTrack.title, targetTrack.artist || "");
        if (best && best.score >= 70) {
          targetTrack = best.candidate;
          data = await resolvePlayable(targetTrack);
          pushStatus(`Local source failed, switched to external match: ${targetTrack.title}`, "warn", "player");
        } else {
          throw error;
        }
      } else {
        throw error;
      }
    }
    if (token !== playbackTokenRef.current) return;
    const isRepeatPlayback = isSavedTrack(targetTrack) && currentSavedTrackId === targetTrack.id && options?.source !== "auto";

    const nextUrl = cacheBustPlaybackUrl(data.playbackUrl || data.url);
    const audio = audioRef.current;
    setCurrent(targetTrack);
    setCurrentTime(0);
    setDuration(0);
    if (isRepeatPlayback) recordUserPreference(targetTrack, "repeat");
    pushStatus(data.cached ? "Using cached stream" : "Stream ready", "info", "player");

    if (audio) {
      audio.pause();
      audio.src = nextUrl;
      audio.currentTime = 0;
      audio.load();
      try {
        await audio.play();
      } catch (error) {
        const playbackError = asErrorMessage(error);
        const interrupted = /interrupted by a new load request|AbortError|The play\(\) request was interrupted/i.test(playbackError);
        if (interrupted) {
          await delay(80);
          try {
            await audio.play();
            pushStatus("Stream ready", "info", "player");
            return;
          } catch (retryError) {
            reportError("player", `Playback blocked: ${asErrorMessage(retryError)}. Press Play once.`);
            return;
          }
        }
        reportError("player", `Playback blocked: ${playbackError}. Press Play once.`);
      }
    }
  };

  const favoriteTrack = async (track: PlayableTrack | null = current) => {
    if (!track) return;
    const isCurrentTrack = track === current;
    const saved = await saveTrackIfNeeded(track);
    await radioApi.favorite({ trackId: saved.id });
    setFavorites((prev) => new Set([...prev, saved.id]));
    if (isCurrentTrack) setCurrent(saved);
    recordUserPreference(saved, "favorite");
    await refresh();
    pushStatus(`${saved.title} added to favorites`, "info", "favorite");
  };

  const removeLibraryTrack = async (track: Track) => {
    if (removingTrackIds.includes(track.id)) return;
    setRemovingTrackIds((prev) => [...prev, track.id]);
    if (currentSavedTrackId === track.id) {
      audioRef.current?.pause();
      if (audioRef.current) audioRef.current.removeAttribute("src");
      setCurrent(null);
      setCurrentTime(0);
      setDuration(0);
    }
    await delay(180);
    const previousTracks = tracks;
    setTracks((prev) => prev.filter((item) => item.id !== track.id));
    try {
      await radioApi.removeTrack(track.id);
      await refresh();
      pushStatus(`${track.title} removed from library`, "info", "library");
    } catch (error) {
      setTracks(previousTracks);
      await refresh().catch(() => undefined);
      reportError("library", error);
    } finally {
      setRemovingTrackIds((prev) => prev.filter((id) => id !== track.id));
    }
  };

  const findTrackIndex = (trackId: number | null) => {
    if (!trackId) return -1;
    return tracks.findIndex((track) => track.id === trackId);
  };

  const advance = async (statusForCurrent: "played" | "skipped") => {
    const currentTrackId = currentSavedTrackId;
    const nextPreferences = recordUserPreference(current, statusForCurrent === "played" ? "completed" : "skipped") || preferences;
    if (!tracks.length) {
      pushStatus("Library is empty, import songs first", "warn", "player");
      return;
    }
    const fallback = pickPreferenceWeightedTrack(tracks, currentTrackId, nextPreferences);
    if (fallback) await playTrack(fallback, { source: "auto" });
  };

  const previousTrack = async () => {
    if (!tracks.length) {
      pushStatus("Library is empty, import songs first", "warn", "player");
      return;
    }
    if (!currentSavedTrackId) {
      await playTrack(tracks[tracks.length - 1], { source: "player" });
      return;
    }
    const index = findTrackIndex(currentSavedTrackId);
    const previous = tracks[(index - 1 + tracks.length) % tracks.length];
    if (previous) await playTrack(previous, { source: "player" });
  };

  const stopTrack = () => {
    audioRef.current?.pause();
    if (audioRef.current) audioRef.current.currentTime = 0;
    setCurrentTime(0);
    setIsPlaying(false);
    pushStatus("Stopped", "info", "player");
  };

  const speakText = async (text: string) => {
    pushStatus("Hui Radio is speaking", "info", "tts");
    try {
      const speech = await radioApi.tts(text);
      const voice = voiceAudioRef.current;
      if (!voice) return;
      voice.src = speech.url;
      voice.load();
      await voice.play();
      return;
    } catch (cloudError) {
      throw cloudError;
    }
  };

  const replayLast = async () => {
    const last = [...chat].reverse().find((entry) => entry.role === "assistant");
    if (!last) return;
    await speakText(last.text);
  };

  const askDj = async (event?: FormEvent) => {
    event?.preventDefault();
    const text = message.trim();
    if (!text) return;
    const userEntry: ChatEntry = { id: makeChatId(), role: "user", text, time: nowLabel() };
    setChat((prev) => [...prev, userEntry]);
    setMessage("");
    pushStatus("Hui Radio is thinking", "info", "ai");

    const data = await radioApi.askAi(text, aiContext, true);
    const assistantText = data.externalSearchError ? `${data.action.say}\n（外部搜索失败：${data.externalSearchError}）` : data.action.say;
    setChat((prev) => [
      ...prev,
      {
        id: makeChatId(),
        role: "assistant",
        text: assistantText,
        time: nowLabel(),
        segments: buildReplySegments(assistantText),
        candidates: data.externalCandidates
      }
    ]);

    if (data.action.reason?.startsWith("openai-fallback")) {
      pushStatus(`Cloud AI unavailable, switched to local DJ: ${data.action.reason}`, "warn", "ai");
    } else {
      pushStatus("Hui Radio replied", "info", "ai");
    }

    speakText(data.action.say).catch((error) => reportError("tts", error));
  };

  const importQq = async () => {
    if (!qqLink.trim()) return;
    pushStatus("Importing QQ playlist", "info", "import");
    const data = await radioApi.importQq(qqLink.trim());
    setQqLink("");
    pushStatus(`Imported ${data.imported} tracks`, "info", "import");
    await refresh();
  };

  const importLx = async () => {
    if (!lxPayload.trim()) return;
    pushStatus("Importing LX list", "info", "import");
    const data = await radioApi.importLx(lxPayload);
    setLxPayload("");
    pushStatus(data.warnings[0] || `Imported ${data.imported} tracks`, data.warnings[0] ? "warn" : "info", "import");
    await refresh();
  };

  const importLxFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    pushStatus(`Reading ${file.name}`, "info", "import");
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    bytes.forEach((byte) => {
      binary += String.fromCharCode(byte);
    });
    const base64 = btoa(binary);
    const data = await radioApi.importLx({ fileName: file.name, base64 }, file.name.replace(/\.(lxmc|csv|json)$/i, ""));
    pushStatus(data.warnings[0] || `Imported ${data.imported} tracks`, data.warnings[0] ? "warn" : "info", "import");
    event.currentTarget.value = "";
    await refresh();
  };

  return (
    <main className={`radio-page ${theme} ${collapsed ? "is-collapsed" : ""} ${backendOpen ? "backend-is-open" : ""}`}>
      <section className="radio-shell">
        <header className="radio-topbar">
          <div className="brand-lockup">
            <div className="avatar">{current?.artwork ? <img src={current.artwork} alt="" /> : <Radio size={18} />}</div>
            <div>
              <div className="pixel-logo">Hui Radio</div>
              <div className="speaking-dot">Speaking...</div>
            </div>
          </div>
          <div className="top-actions">
            <button className="ghost-pill backend-trigger" type="button" onClick={() => setBackendOpen(true)} title="Import & Settings">
              <Settings size={13} />
              <span>IMPORT</span>
            </button>
            <div className="theme-toggle" aria-label="Theme">
              <button type="button" className={theme === "theme-dark" ? "active" : ""} onClick={() => setTheme("theme-dark")} title="Dark">
                <Moon size={14} />
              </button>
              <button type="button" className={theme === "theme-light" ? "active" : ""} onClick={() => setTheme("theme-light")} title="Light">
                <Sun size={14} />
              </button>
            </div>
          </div>
        </header>

        <section className="clock-stage">
          <div className="clock-wave" aria-hidden="true">
            {waveBars.slice(0, 18).map((height, index) => <i key={index} style={{ height: `${height * 0.58}px`, animationDelay: `${index * 120}ms` }} />)}
          </div>
          <div className="pixel-time">{formatClock(clock)}</div>
          <div className="clock-date">{formatDate(clock)}</div>
          <div className="on-air"><span />ON AIR</div>
        </section>

        <section className="transport-panel">
          <div className="now-playing" key={currentMotionKey}>
            <div className={`mini-bars ${isPlaying ? "is-playing" : ""}`}>
              {waveBars.slice(0, 5).map((height, index) => <i key={index} style={{ height: `${height * 0.42}px`, animationDelay: `${index * 68}ms` }} />)}
            </div>
            <div className="now-playing-copy">
              <strong>{currentTitle}</strong>
              <span>{currentArtist}</span>
            </div>
          </div>
          <div className="transport-buttons">
            <div className="primary-controls">
              <button type="button" onClick={() => previousTrack().catch((error) => reportError("player", error))} title="Previous"><SkipBack size={16} /></button>
              <button
                type="button"
                className="round-primary"
                onClick={() => {
                  if (isPlaying) {
                    audioRef.current?.pause();
                    return;
                  }
                  if (audioRef.current?.src) {
                    audioRef.current.play().catch((error) => reportError("player", error));
                    return;
                  }
                  if (current) {
                    playTrack(current, { source: "player", persist: isSavedTrack(current) }).catch((error) => reportError("player", error));
                  }
                }}
                title={isPlaying ? "Pause" : "Play"}
              >
                {isPlaying ? <Pause size={17} /> : <Play size={17} />}
              </button>
              <button type="button" onClick={() => advance("skipped").catch((error) => reportError("player", error))} title="Next"><SkipForward size={16} /></button>
            </div>
            <div className="secondary-controls">
              <button
                type="button"
                className={currentIsFavorited ? "is-favorited" : ""}
                onClick={() => favoriteTrack().catch((error) => reportError("favorite", error))}
                aria-pressed={currentIsFavorited}
                title="Favorite"
              >
                <Heart size={16} />
              </button>
              <button type="button" className="text-chip" onClick={() => setCollapsed((value) => !value)}>
                {collapsed ? "SHOW" : "HIDE"}
              </button>
            </div>
          </div>
          <div className="volume-control">
            <Volume2 size={15} />
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={volume}
              style={{ "--range-progress": `${volume * 100}%` } as React.CSSProperties}
              onChange={(event) => setVolume(Number(event.target.value))}
            />
          </div>
          <div className="volume-control tts-volume-control">
            <button
              type="button"
              className="tts-volume-button"
              onClick={() => setTtsVolume((value) => (value >= 0.95 ? 0.7 : Math.min(1, value + 0.15)))}
              title={`TTS volume ${Math.round(ttsVolume * 100)}%`}
            >
              <Volume1 size={14} />
            </button>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={ttsVolume}
              style={{ "--range-progress": `${ttsVolume * 100}%` } as React.CSSProperties}
              aria-label="TTS volume"
              onChange={(event) => setTtsVolume(Number(event.target.value))}
            />
          </div>
          <div className="progress-line">
            <span>{formatDuration(currentTime)}</span>
            <input
              type="range"
              min="0"
              max={duration || 0}
              step="1"
              value={Math.min(currentTime, duration || 0)}
              style={{ "--range-progress": `${duration ? (Math.min(currentTime, duration) / duration) * 100 : 0}%` } as React.CSSProperties}
              onChange={(event) => {
                const next = Number(event.target.value);
                if (audioRef.current) audioRef.current.currentTime = next;
                setCurrentTime(next);
              }}
            />
            <span>{formatDuration(duration)}</span>
          </div>
        </section>

        {!collapsed && (
          <>
            <section className="chat-panel">
              <div className="server-note">Hui Radio · Live Broadcast</div>
              {chat.map((entry) => (
                <article className={`chat-message ${entry.role}`} key={entry.id}>
                  <div className="chat-avatar">{entry.role === "assistant" ? <Radio size={14} /> : "你"}</div>
                  <div className="bubble-wrap">
                    <div className="chat-meta">{entry.role === "assistant" ? "HUI RADIO" : "YOU"} · {entry.time}</div>
                    {entry.role === "assistant" ? <RadioTranscriptBubble entry={entry} /> : <div className="bubble">{entry.text}</div>}
                    {entry.candidates && entry.candidates.length > 0 && (
                      <div className="candidate-list">
                        {entry.candidates.map((candidate, index) => (
                          <div className="candidate-card" key={`${candidate.title}-${candidate.artist}-${index}`}>
                            <button
                              type="button"
                              className="tiny-play"
                              onClick={(event) => {
                                event.stopPropagation();
                                playTrack(candidate, { persist: false, source: "candidate-preview" }).catch((error) => reportError("player", error));
                              }}
                              title="Preview"
                            >
                              <Play size={14} />
                            </button>
                            <div>
                              <strong>{candidate.title}</strong>
                              <span>{candidate.artist || candidate.album || "Unknown artist"}</span>
                            </div>
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                favoriteTrack(candidate).catch((error) => reportError("favorite", error));
                              }}
                              title="Add to favorites"
                            >
                              <Heart size={15} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </article>
              ))}
            </section>

            <form className="composer" onSubmit={(event) => askDj(event).catch((error) => reportError("ai", error))}>
              <input value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Tell Hui Radio what you want to hear..." />
              <button type="button" onClick={() => replayLast().catch((error) => reportError("tts", error))} title="Replay"><RotateCcw size={17} /></button>
              <button type="submit" className="send-button" title="Send"><Send size={17} /></button>
            </form>

            <section className="context-panel">
              <input value={city} onChange={(event) => setCity(event.target.value)} placeholder="City" />
              <input value={weather} onChange={(event) => setWeather(event.target.value)} placeholder="Weather" />
              <input value={mood} onChange={(event) => setMood(event.target.value)} placeholder="Mood" />
              <input value={timeSlot} onChange={(event) => setTimeSlot(event.target.value)} placeholder="Time" />
            </section>

            <section className="library-panel">
              <div className="panel-heading">
                <span><ListMusic size={15} /> LIBRARY</span>
                <button type="button" onClick={() => refresh().catch((error) => reportError("refresh", error))} title="Refresh"><RefreshCw size={14} /></button>
              </div>
              <div className="track-grid">
                {tracks.map((track, index) => (
                  <article className={`track-row ${removingTrackIds.includes(track.id) ? "is-removing" : ""}`} key={track.id} style={{ "--item-index": index } as React.CSSProperties}>
                    <button type="button" className="track-play" onClick={() => playTrack(track, { source: "library" }).catch((error) => reportError("player", error))}>
                      <span>{track.title}</span>
                      <small>{track.artist || track.source || "Unknown"}</small>
                    </button>
                    <button type="button" className="track-remove" onClick={() => removeLibraryTrack(track).catch((error) => reportError("library", error))} title="Remove song">
                      <Trash2 size={14} />
                    </button>
                  </article>
                ))}
              </div>
            </section>
          </>
        )}

        <section className={`error-drawer ${logOpen ? "open" : ""}`}>
          <div className="error-drawer-head">
            <button type="button" className="error-toggle" onClick={() => setLogOpen((value) => !value)} title="Toggle logs">
              <AlertCircle size={14} />
              <span>Logs</span>
            </button>
            <div className="error-actions">
              <button type="button" onClick={() => setLogs([])} title="Clear">
                <X size={13} />
              </button>
            </div>
          </div>
          {logOpen && (
            <div className="error-list">
              {logs.length === 0 && <div className="error-item info">No logs yet.</div>}
              {logs.map((item) => (
                <div key={item.id} className={`error-item ${item.level}`}>
                  <div className="error-meta">{item.time} · {item.scope}</div>
                  <div className="error-message">{item.message}</div>
                </div>
              ))}
            </div>
          )}
        </section>

        <footer className="radio-footer">
          <span>HUI FM</span>
          <span>{status}</span>
          <button type="button" onClick={() => setCollapsed((value) => !value)} title={collapsed ? "Expand" : "Collapse"}>
            {collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </footer>
      </section>

      {backendOpen && (
        <div className="backend-backdrop" role="presentation" onClick={() => setBackendOpen(false)}>
          <aside className="backend-drawer" role="dialog" aria-modal="true" aria-label="Hui Radio backend" onClick={(event) => event.stopPropagation()}>
            <div className="backend-head">
              <div>
                <span>HUI RADIO</span>
                <strong>Import & Settings</strong>
              </div>
              <button type="button" onClick={() => setBackendOpen(false)} title="Close">
                <X size={16} />
              </button>
            </div>
            <div className="backend-section">
              <label htmlFor="qq-link">QQ playlist</label>
              <div className="import-grid">
                <input id="qq-link" value={qqLink} onChange={(event) => setQqLink(event.target.value)} placeholder="Paste QQ playlist link" />
                <button type="button" onClick={() => importQq().catch((error) => reportError("import", error))} title="Import QQ"><Search size={15} /></button>
              </div>
            </div>
            <div className="backend-section">
              <label htmlFor="lx-file">LX file</label>
              <div className="import-grid">
                <input id="lx-file" type="file" accept=".lxmc,.csv,.json,application/json,text/csv" onChange={(event) => importLxFile(event).catch((error) => reportError("import", error))} />
                <button type="button" onClick={() => importLx().catch((error) => reportError("import", error))} title="Import LX"><Upload size={15} /></button>
              </div>
            </div>
            <div className="backend-section">
              <label htmlFor="lx-json">LX JSON</label>
              <textarea id="lx-json" value={lxPayload} onChange={(event) => setLxPayload(event.target.value)} placeholder="Paste LX JSON data here" />
            </div>
          </aside>
        </div>
      )}

      <audio
        ref={audioRef}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onError={() => reportError("player", "Audio playback failed: source unavailable or blocked")}
        onEnded={() => advance("played").catch((error) => reportError("player", error))}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
      />
      <audio
        ref={voiceAudioRef}
        onEnded={() => pushStatus("Hui Radio replied", "info", "tts")}
        onError={() => reportError("tts", "TTS playback failed")}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
