export type AiIntentKind =
  | "chat_only"
  | "recommend_external"
  | "recommend_library"
  | "search_song"
  | "play_current_candidate"
  | "play_local_track";

export type AiIntent = {
  kind: AiIntentKind;
  confidence: number;
  requestedTitle?: string;
  requestedArtist?: string;
  allowInstrumental: boolean;
  shouldAutoplay: boolean;
  needsExternalSearch: boolean;
};

const punctuationPattern = /[\u3001\u3002\u300a\u300b\u300c\u300d\u300e\u300f\u201c\u201d\u2018\u2019"'`()[\]\uff08\uff09\s]/g;
const commandPrefixPattern =
  /^(?:麻烦|请|请你|帮我|给我|你帮我)?\s*(?:搜索|搜一个|搜|找一个|找|播放|点播|播一首|播|放一首|放一歌|放一曲|放|来一首|想听)?\s*/u;
const passiveRecommendationPattern = /推荐|介绍|找几首|找几首歌|候选|歌单|歌荒/u;
const playbackPattern =
  /\b(play|start)\b|播放|点播|播一首|播吧|放一首|放吧|放啊|放一歌|来一首|想听|帮我放|给我放|就这首|就这个|那你倒是播放|那你放啊/i;
const recentCandidatePattern = /^(?:那你|那|就|你)?\s*(?:倒是)?\s*(?:播放|放啊|放吧|播吧|就这首|就这个|这个|这首)/u;
const externalRecommendationPattern = /推荐|来一首|想听|找一首|没听过|未听过|新的|新歌|陌生|随便|随机|换一首|适合.*歌/u;
const libraryRecommendationPattern = /曲库|库里|本地|收藏|我喜欢|喜欢的|已有/u;
const instrumentalPattern = /纯音乐|纯音|instrumental|bgm|BGM|伴奏|无人声|无人唱|无词|钢琴曲|轻音乐|piano cover|instrumental cover|lofi/i;
const searchPattern = /搜索|搜一个|搜|找一个|找|哪首|哪一首|叫什么|叫啥|谁唱|谁唱的/u;
const currentTrackReferencePattern = /这首歌|这首|这歌|当前这首|现在这首|刚才这首|正在放的|正在播的|现在播放的|当前播放的/u;
const currentTrackQuestionPattern =
  /讲的是什么|讲什么|什么意思|表达什么|表达了什么|唱的是什么|歌词意思|歌词讲|歌词大意|背景|故事|介绍一下|分析一下|好听在哪|为什么好听|什么风格|什么类型/u;

export function normalizeForMatch(value: string) {
  return value.toLowerCase().replace(punctuationPattern, "");
}

export function normalizeKnownMusicAliases(value: string) {
  return value
    .replace(/you\s*(?:are|'?re)?\s*beautiful|youarebeautiful/gi, "You're Beautiful")
    .replace(/詹姆斯\s*[·.\s-]*布朗特|詹姆斯布朗特|james\s*blunt/gi, "James Blunt")
    .replace(/\s+/g, " ")
    .trim();
}

export function isCurrentTrackQuestion(message: string) {
  return currentTrackReferencePattern.test(message) && currentTrackQuestionPattern.test(message);
}

export function stripSongCommandPrefix(value: string) {
  return value.replace(commandPrefixPattern, "").trim();
}

function cleanTitle(value: string) {
  return normalizeKnownMusicAliases(
    value
      .replace(/[《》「」『』“”"']/g, "")
      .replace(/(然后|但是|不过|给我|顺便).*$/u, "")
      .trim()
  );
}

function looksLikeDescriptiveRequest(value: string) {
  return /这首歌|这首|这歌|一首|几首|一点|一些|适合|安静|开心|难过|中文|英文|粤语|日语|韩语|歌$|歌曲$|音乐$/u.test(value);
}

export function extractSongRequest(message: string) {
  if (isCurrentTrackQuestion(message)) return { title: "", artist: "" };

  const aliased = normalizeKnownMusicAliases(message);
  const quoted = aliased.match(/[《「『“"]([^》」』”"]+)[》」』”"]/)?.[1] || "";
  const cleaned = stripSongCommandPrefix(aliased);
  const possessive = cleaned.match(
    /^([\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z0-9·.\s-]{1,38})的\s*([A-Za-z0-9][A-Za-z0-9'\s-]{1,60}|[《“"]?[^，。！？,.!?]{1,40}[》”"]?)/u
  );
  const commandTitle = aliased.match(/(?:播放|点播|播一首|播|放一首|放)\s*([^\s，。！？,.!?]{1,32})/u)?.[1] || "";
  const artist =
    possessive?.[1] ||
    aliased.match(/(?:by|歌手|唱的|版本|原唱)\s*([^\s，。！？,.!?]+)/i)?.[1] ||
    "";
  const rawTitle = possessive?.[2] || quoted || commandTitle;
  const title = cleanTitle(rawTitle);
  return {
    title: title && !looksLikeDescriptiveRequest(title) ? title : "",
    artist: normalizeKnownMusicAliases(artist.trim())
  };
}

export function wantsLibraryRecommendation(message: string) {
  return libraryRecommendationPattern.test(message);
}

export function wantsExternalRecommendation(message: string) {
  return externalRecommendationPattern.test(message) && !wantsLibraryRecommendation(message) && !isCurrentTrackQuestion(message);
}

export function wantsInstrumentalRecommendation(message: string) {
  return instrumentalPattern.test(message);
}

export function wantsExternalCandidateSearch(message: string) {
  if (isCurrentTrackQuestion(message)) return false;
  const requested = extractSongRequest(message);
  return Boolean(requested.title) || searchPattern.test(message) || /的\s*(?:[A-Za-z0-9]|[《“"])/u.test(message);
}

export function wantsPlayback(message: string) {
  return playbackPattern.test(message);
}

export function isExplicitPlaybackRequest(message: string) {
  const normalized = message.trim();
  if (!normalized || isCurrentTrackQuestion(normalized)) return false;
  const requested = extractSongRequest(normalized);
  if (requested.title && !passiveRecommendationPattern.test(normalized)) return true;
  if (!wantsPlayback(normalized)) return false;
  return !passiveRecommendationPattern.test(normalized) || /播放|点播|播一首|播吧|放一首|放吧|放啊|帮我放|给我放|就这首|就这个/u.test(normalized);
}

export function classifyAiIntent(message: string): AiIntent {
  const normalized = message.trim();
  const requested = extractSongRequest(normalized);
  const allowInstrumental = wantsInstrumentalRecommendation(normalized);
  const library = wantsLibraryRecommendation(normalized);
  const external = wantsExternalRecommendation(normalized);
  const playback = wantsPlayback(normalized);
  const search = wantsExternalCandidateSearch(normalized);
  const currentCandidate = recentCandidatePattern.test(normalized);

  if (!normalized) {
    return { kind: "chat_only", confidence: 0, allowInstrumental, shouldAutoplay: false, needsExternalSearch: false };
  }
  if (isCurrentTrackQuestion(normalized)) {
    return { kind: "chat_only", confidence: 0.94, allowInstrumental, shouldAutoplay: false, needsExternalSearch: false };
  }
  if (currentCandidate) {
    return { kind: "play_current_candidate", confidence: 0.92, allowInstrumental, shouldAutoplay: true, needsExternalSearch: false };
  }
  if (library) {
    return { kind: "recommend_library", confidence: 0.9, allowInstrumental, shouldAutoplay: playback, needsExternalSearch: false };
  }
  if (requested.title || search) {
    return {
      kind: playback ? "play_local_track" : "search_song",
      confidence: requested.title ? 0.9 : 0.74,
      requestedTitle: requested.title || undefined,
      requestedArtist: requested.artist || undefined,
      allowInstrumental,
      shouldAutoplay: playback,
      needsExternalSearch: true
    };
  }
  if (external) {
    return { kind: "recommend_external", confidence: 0.84, allowInstrumental, shouldAutoplay: playback, needsExternalSearch: true };
  }
  if (playback) {
    return { kind: "play_local_track", confidence: 0.68, allowInstrumental, shouldAutoplay: true, needsExternalSearch: true };
  }
  return { kind: "chat_only", confidence: 0.72, allowInstrumental, shouldAutoplay: false, needsExternalSearch: false };
}
