import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { z } from "zod";
import { config } from "../config.js";
import { getAiMemoryState, getTrack, listAiMessagesSince, listRecentAiMessages, listTracks, saveAiMessage, updateAiMemoryState } from "../db.js";
import { DEFAULT_AUTO_MEMORY, ensureAgentsMemoryFile, readAutoMemory, writeAutoMemory } from "./memory.js";
import {
  classifyAiIntent,
  extractSongRequest as extractSharedSongRequest,
  normalizeKnownMusicAliases as normalizeSharedKnownMusicAliases,
  stripSongCommandPrefix as stripSharedSongCommandPrefix,
  wantsExternalCandidateSearch as wantsSharedExternalCandidateSearch,
  wantsExternalRecommendation as wantsSharedExternalRecommendation,
  wantsInstrumentalRecommendation as wantsSharedInstrumentalRecommendation,
  wantsLibraryRecommendation as wantsSharedLibraryRecommendation,
  wantsPlayback as wantsSharedPlayback
} from "../../shared/aiIntent.js";
import type { AiMessage, Track } from "../types.js";

type RequestOptions = { signal: AbortSignal; timeout: number; maxRetries: number };

type OpenAIClientLike = {
  chat: {
    completions: {
      create: (...args: any[]) => Promise<{ choices?: Array<{ message?: { content?: string | null } }> }>;
    };
  };
  audio: {
    speech: {
      create: (...args: any[]) => Promise<Response>;
    };
  };
};

type ClaudeMessageResponse = {
  content?: Array<{ type?: string; text?: string }>;
  error?: { message?: string };
};

type ChatMessageParam = { role: "user" | "assistant"; content: string };
type PreferenceBucket = "artist" | "language" | "genre" | "mood" | "scene" | "tempo";
type AiPreferences = Partial<Record<PreferenceBucket, Record<string, number>>>;

export interface AiRequestContext {
  city?: string;
  weather?: string;
  mood?: string;
  timeSlot?: string;
  currentTrack?: Pick<Track, "id" | "title" | "artist" | "source"> | null;
  preferences?: AiPreferences;
}

function resolveProxyUrl() {
  return config.OPENAI_PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
}

function createClient(): OpenAIClientLike | null {
  if (!config.OPENAI_API_KEY) return null;
  const proxyUrl = resolveProxyUrl();
  if (!proxyUrl) return new OpenAI({ apiKey: config.OPENAI_API_KEY, baseURL: config.OPENAI_BASE_URL });

  const dispatcher = new ProxyAgent(proxyUrl);
  return new OpenAI({
    apiKey: config.OPENAI_API_KEY,
    baseURL: config.OPENAI_BASE_URL,
    fetch: ((url: unknown, init: unknown) =>
      undiciFetch(url as never, { ...((init as Record<string, unknown>) || {}), dispatcher } as never)) as never
  });
}

let client: OpenAIClientLike | null = createClient();
let hasOpenAiClientOverrideForTests = false;

function isClaudeTextModel() {
  return config.OPENAI_TEXT_MODEL.startsWith("claude-") && !hasOpenAiClientOverrideForTests;
}

function isClaudeModel(model: string) {
  return model.startsWith("claude-");
}

function resolveClaudeMessagesUrl(model: string) {
  const baseUrl = config.OPENAI_BASE_URL || "https://www.right.codes/claude/v1";
  const claudePath = model.startsWith("claude-haiku-") ? "/claude-aws/v1/messages" : "/claude/v1/messages";
  try {
    const url = new URL(baseUrl);
    url.pathname = url.pathname.replace(/\/codex\/v1\/?$/, claudePath);
    url.pathname = url.pathname.replace(/\/claude\/v1\/?$/, claudePath);
    if (!url.pathname.endsWith("/messages")) {
      url.pathname = `${url.pathname.replace(/\/$/, "")}/messages`;
    }
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "https://www.right.codes/claude/v1/messages";
  }
}

async function fetchWithOptionalProxy(url: string, init: Parameters<typeof undiciFetch>[1]) {
  const proxyUrl = resolveProxyUrl();
  if (!proxyUrl) return undiciFetch(url, init);
  return undiciFetch(url, { ...(init || {}), dispatcher: new ProxyAgent(proxyUrl) } as never);
}

async function rightCodesFetch(url: string, init: Parameters<typeof undiciFetch>[1]): Promise<any> {
  return undiciFetch(url, init);
}

async function readAnthropicStreamText(response: Response) {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";

  const consumeLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payloadText = trimmed.slice(5).trim();
    if (!payloadText || payloadText === "[DONE]") return;
    try {
      const event = JSON.parse(payloadText) as {
        type?: string;
        delta?: { type?: string; text?: string };
        content_block?: { type?: string; text?: string };
        message?: { content?: Array<{ type?: string; text?: string }> };
      };

      if (event.type === "content_block_delta") {
        const deltaText = event.delta?.text;
        if (typeof deltaText === "string") text += deltaText;
      } else if (event.type === "message_start") {
        const messageText = event.message?.content
          ?.map((item) => item.text || "")
          .join("")
          .trim();
        if (messageText) text += messageText;
      }
    } catch {
      // Ignore non-JSON SSE lines.
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    let lineBreak = buffer.indexOf("\n");
    while (lineBreak >= 0) {
      const line = buffer.slice(0, lineBreak).replace(/\r$/, "");
      consumeLine(line);
      buffer = buffer.slice(lineBreak + 1);
      lineBreak = buffer.indexOf("\n");
    }
    if (done) break;
  }

  if (buffer.trim()) consumeLine(buffer.replace(/\r$/, ""));
  return text.trim();
}

export const aiActionSchema = z.object({
  say: z.string(),
  playTrackId: z.number().int().nullable().optional(),
  reason: z.string().optional(),
  externalSearchQuery: z.string().nullable().optional()
});

export type AiAction = z.infer<typeof aiActionSchema>;

const radioSystemPrompt = [
  "\u4f60\u662f Hui Radio \u7684\u4e2d\u6587 AI \u7535\u53f0\u4e3b\u64ad\uff0c\u50cf\u771f\u4eba DJ \u4e00\u6837\u81ea\u7136\u8bf4\u8bdd\uff0c\u77ed\u53e5\u3001\u6e29\u67d4\u3001\u6709\u753b\u9762\u611f\u3002",
  "\u53ef\u4ee5\u4ece provided library \u91cc\u9009\u6b4c\uff0c\u53ea\u80fd\u4f7f\u7528\u4e0a\u4e0b\u6587\u4e2d\u771f\u5b9e\u5b58\u5728\u7684 track id\u3002",
  "\u7528\u6237\u7684 preferences \u6765\u81ea\u64ad\u653e\u5b8c\u6210\u3001\u6536\u85cf\u3001\u91cd\u590d\u64ad\u653e\u548c\u8df3\u8fc7\u884c\u4e3a\uff1b\u63a8\u8350\u65f6\u8981\u4f18\u5148\u53c2\u8003 preferenceScore \u548c preferenceHints\u3002",
  "\u5982\u679c allowExternal \u4e3a true\uff0c\u4e14\u7528\u6237\u8bf4\u201c\u63a8\u8350\u201d\u3001\u201c\u6765\u4e00\u9996\u201d\u3001\u201c\u60f3\u542c\u65b0\u7684\u201d\u3001\u201c\u6ca1\u542c\u8fc7\u7684\u201d\uff0c\u4f18\u5148\u63a8\u8350\u66f2\u5e93\u5916\u6b4c\u66f2\uff1aplayTrackId \u8bbe\u4e3a null\uff0cexternalSearchQuery \u5199\u6210\u660e\u786e\u7684\u201c\u6b4c\u540d \u827a\u4eba\u201d\u641c\u7d22\u8bcd\u3002",
  "\u5982\u679c\u7528\u6237\u5728\u70b9\u6b4c\u3001\u627e\u6b4c\uff0c\u6216\u8bf4\u201c\u67d0\u6b4c\u624b\u7684\u67d0\u9996\u6b4c/\u67d0\u82f1\u6587\u6b4c\u540d/\u8fd9\u9996\u53eb\u4ec0\u4e48\u201d\uff0c\u5fc5\u987b\u5148\u63d0\u53d6\u5e76\u7ea0\u9519\u6210\u6807\u51c6\u201c\u6b4c\u540d \u827a\u4eba\u201d\u641c\u7d22\u8bcd\uff1b\u4e0d\u8981\u53ea\u53e3\u64ad\u4e0d\u641c\u7d22\u3002",
  "\u66f2\u5e93\u5916\u70b9\u6b4c\u9ed8\u8ba4\u53ea\u5c55\u793a\u5019\u9009\uff0c\u4e0d\u8981\u8bf4\u201c\u6b63\u5728\u64ad\u653e\u201d\u6216\u201c\u5c31\u7ed9\u4f60\u653e\u8d77\u6765\u201d\uff1b\u53e3\u64ad\u5e94\u8868\u8fbe\u201c\u6211\u5148\u628a\u5019\u9009\u627e\u51fa\u6765\uff0c\u4f60\u70b9\u60f3\u542c\u7684\u7248\u672c\u201d\u3002",
  "\u63a8\u8350\u6b4c\u66f2\u65f6\u9ed8\u8ba4\u539f\u7248\u4f18\u5148\u3001\u6709\u4eba\u58f0\u4f18\u5148\uff1a\u539f\u5531/\u539f\u7248 > \u6b63\u5f0f\u5f55\u97f3\u5ba4\u7248/\u5b98\u65b9\u73b0\u573a\u7248 > \u7ffb\u5531/\u6539\u7f16/\u4f34\u594f/\u7eaf\u97f3\u4e50\u3002",
  "\u9664\u975e\u7528\u6237\u660e\u786e\u8bf4\u8981\u7eaf\u97f3\u4e50\u3001instrumental\u3001BGM\u3001\u4f34\u594f\u3001\u65e0\u4eba\u58f0\u6216\u7c7b\u4f3c\u610f\u56fe\uff0c\u4e0d\u8981\u628a\u7eaf\u97f3\u4e50\u3001\u4f34\u594f\u3001lofi\u3001piano cover\u3001instrumental cover \u4f5c\u4e3a\u5e38\u89c4\u63a8\u8350\u3002",
  "\u53ea\u6709\u7528\u6237\u660e\u786e\u8bf4\u8981\u64ad\u653e\u672c\u5730\u3001\u6536\u85cf\u3001\u66f2\u5e93\u91cc\u7684\u6b4c\u65f6\uff0c\u624d\u4ece provided library \u9009\u6b4c\u3002\u4e0d\u8981\u7ed9\u66f2\u5e93\u5916\u6b4c\u66f2\u7f16\u9020 id\u3002",
  '\u53ea\u8fd4\u56de\u4e25\u683c JSON\uff1a{"say":"\u4e3b\u64ad\u53e3\u64ad\uff0c\u4e2d\u6587\uff0c80\u5b57\u4ee5\u5185","playTrackId":number|null,"reason":"optional","externalSearchQuery":string|null}\u3002',
  "\u4e0d\u8981\u8f93\u51fa Markdown\uff0c\u4e0d\u8981\u89e3\u91ca JSON\u3002"
].join("\n");

const welcomePrompt = [
  "\u4f60\u662f Hui Radio \u7684\u4e2d\u6587 AI \u7535\u53f0\u4e3b\u64ad\u3002",
  "\u8bf7\u751f\u6210\u4e00\u6761\u9996\u6b21\u8fdb\u5165\u9875\u9762\u7684\u968f\u673a\u6b22\u8fce\u53e3\u64ad\uff0c\u4e2d\u6587\uff0c40 \u5230 90 \u5b57\u3002",
  "\u8bed\u6c14\u8981\u50cf\u771f\u6b63\u7684\u6df1\u591c\u65e5\u5e38\u7535\u53f0\u4e3b\u64ad\uff0c\u6e29\u67d4\u3001\u677e\u5f1b\u3001\u6709\u753b\u9762\u611f\u3002",
  "\u53ef\u4ee5\u53c2\u8003\u5f53\u524d\u65f6\u95f4\u3001\u66f2\u5e93\u6570\u91cf\u3001\u5f53\u524d\u6b4c\u66f2\u3001\u57ce\u5e02\u3001\u5929\u6c14\u3001\u5fc3\u60c5\u3001\u65f6\u95f4\u6bb5\uff0c\u4ee5\u53ca AGENTS \u8bb0\u5fd8\u4e2d\u7684\u957f\u671f\u504f\u597d\u3002",
  "\u4e0d\u8981 Markdown\uff0c\u4e0d\u8981\u5f15\u53f7\uff0c\u4e0d\u8981\u5217\u8868\uff0c\u53ea\u8f93\u51fa\u6b22\u8fce\u8bed\u6b63\u6587\u3002"
].join("\n");

const memorySummaryPrompt = [
  "You maintain Hui Radio's long-term listener memory.",
  "Summarize only durable preferences and recurring habits from the new conversation snippets.",
  "Keep stable facts only: music tastes, preferred tone, language style, recurring goals, repeated constraints.",
  "Do not include one-off requests, transient moods, timestamps, or implementation details.",
  "Return 3 to 8 short Markdown bullet points in English or Chinese.",
  `If nothing durable is learned, return exactly: ${DEFAULT_AUTO_MEMORY}`
].join("\n");

const RECENT_MESSAGE_LIMIT = 8;
const SUMMARY_BATCH_SIZE = 6;
const SUMMARY_MIN_INTERVAL_MS = 5 * 60 * 1000;
const BEIJING_TIME_ZONE = "Asia/Shanghai";
const preferenceBuckets: PreferenceBucket[] = ["artist", "language", "genre", "mood", "scene", "tempo"];

function normalizeTag(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function sanitizePreferences(input?: AiPreferences): AiPreferences {
  const next: AiPreferences = {};
  if (!input || typeof input !== "object") return next;
  preferenceBuckets.forEach((bucket) => {
    const weights = input[bucket];
    if (!weights || typeof weights !== "object") return;
    Object.entries(weights).forEach(([tag, value]) => {
      const normalizedTag = normalizeTag(tag);
      const numericValue = Number(value);
      if (!normalizedTag || !Number.isFinite(numericValue) || numericValue === 0) return;
      next[bucket] = { ...(next[bucket] || {}), [normalizedTag]: numericValue };
    });
  });
  return next;
}

function tagValues(track: Partial<Record<PreferenceBucket, string | undefined>>, bucket: PreferenceBucket) {
  const value = track[bucket];
  if (!value) return [];
  return String(value)
    .split(/[\/,\u3001]+/u)
    .map(normalizeTag)
    .filter(Boolean);
}

function scoreTrackByPreferences(track: Partial<Record<PreferenceBucket, string | undefined>>, preferences?: AiPreferences) {
  const safePreferences = sanitizePreferences(preferences);
  return preferenceBuckets.reduce((score, bucket) => {
    return score + tagValues(track, bucket).reduce((bucketScore, tag) => bucketScore + (safePreferences[bucket]?.[tag] || 0), 0);
  }, 0);
}

function topPreferenceTerms(preferences?: AiPreferences, limit = 6) {
  const safePreferences = sanitizePreferences(preferences);
  return preferenceBuckets
    .flatMap((bucket) => Object.entries(safePreferences[bucket] || {}).map(([tag, weight]) => ({ bucket, tag, weight })))
    .filter((entry) => entry.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit)
    .map((entry) => `${entry.bucket}:${entry.tag}`);
}

function pickPreferenceWeightedLocalTrack(tracks: Track[], preferences?: AiPreferences, allowInstrumental = false) {
  return [...tracks]
    .map((track, index) => ({ track, index, score: scoreTrackByPreferences(track, preferences) + scoreSongVersionPreference(track, allowInstrumental) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)[0]?.track;
}

function normalize(value: string) {
  return value.toLowerCase().replace(/[\u3001\u3002\u300a\u300b\u300c\u300d\u300e\u300f\u201c\u201d\u2018\u2019"'`()[\]\uff08\uff09\s]/g, "");
}

function normalizeKnownMusicAliases(value: string) {
  return normalizeSharedKnownMusicAliases(value);
}

function stripSongCommandPrefix(value: string) {
  return stripSharedSongCommandPrefix(value);
}

function extractSongRequest(message: string) {
  return extractSharedSongRequest(message);
}

function wantsExternalRecommendation(message: string) {
  return wantsSharedExternalRecommendation(message);
}

function wantsLibraryRecommendation(message: string) {
  return wantsSharedLibraryRecommendation(message);
}

export function wantsExternalCandidateSearch(message: string) {
  return wantsSharedExternalCandidateSearch(message);
}

export function wantsInstrumentalRecommendation(message: string) {
  return wantsSharedInstrumentalRecommendation(message);
}

function wantsPlayback(message: string) {
  return wantsSharedPlayback(message);
}

function formatBeijingNow() {
  return new Date().toLocaleString("zh-CN", { timeZone: BEIJING_TIME_ZONE, hour12: false });
}

function buildExternalSearchQuery(message: string, requested: ReturnType<typeof extractSongRequest>, context?: AiRequestContext) {
  if (requested.title) return biasExternalSearchQuery(`${requested.title}${requested.artist ? ` ${requested.artist}` : ""}`, message);
  const preferenceHints = topPreferenceTerms(context?.preferences, 4).map((hint) => hint.split(":").slice(1).join(":"));
  const hints = [...preferenceHints, context?.mood, context?.weather, context?.timeSlot, context?.city]
    .filter((value): value is string => Boolean(value?.trim()))
    .slice(0, 3);
  const cleaned = message.replace(/[，。！？,.!?]/g, " ").replace(/\s+/g, " ").trim();
  const keepRequestHint = wantsInstrumentalRecommendation(message) || !/^推荐|推薦|来一首|來一首|放歌|歌$/i.test(cleaned);
  const requestHint = cleaned && keepRequestHint ? cleaned.slice(0, 40) : "";
  const defaultHint = wantsInstrumentalRecommendation(message) ? "纯音乐" : "华语 流行 治愈";
  return biasExternalSearchQuery([...hints, requestHint || defaultHint].join(" "), message);
}

export function isLikelyInstrumentalCandidate(track: Pick<Track, "title" | "artist" | "album" | "genre" | "mood">) {
  const searchable = [track.title, track.album, track.genre, track.mood].filter(Boolean).join(" ");
  return /纯音乐|纯音|instrumental|伴奏|无人声|无人唱|无词|piano cover|instrumental cover|lofi|karaoke|off vocal/i.test(searchable);
}

export function scoreSongVersionPreference(track: Pick<Track, "title" | "artist" | "album" | "genre" | "mood">, allowInstrumental: boolean) {
  const searchable = [track.title, track.album, track.genre, track.mood].filter(Boolean).join(" ");
  let score = 0;
  if (/原唱|原版|original|official|录音室/i.test(searchable)) score += 8;
  if (/live|现场/i.test(searchable)) score += 3;
  if (/翻唱|cover|改编|remix|remaster|钢琴版|吉他版/i.test(searchable)) score -= 8;
  if (!allowInstrumental && isLikelyInstrumentalCandidate(track)) score -= 40;
  return score;
}

export function biasExternalSearchQuery(query: string, message: string) {
  const cleaned = normalizeKnownMusicAliases(query);
  if (!cleaned || wantsInstrumentalRecommendation(message)) return cleaned;
  const needsOriginal = !/原唱|原版|original|official/i.test(cleaned);
  const needsVocal = !/人声|vocal/i.test(cleaned);
  return [cleaned, needsOriginal ? "原唱" : "", needsVocal ? "人声" : ""].filter(Boolean).join(" ");
}

export function ensureExternalCandidateSearchForRequest(action: AiAction, message: string, context?: AiRequestContext, allowExternal = false): AiAction {
  if (!allowExternal || wantsLibraryRecommendation(message) || !wantsExternalCandidateSearch(message)) return action;

  const requested = extractSongRequest(message);
  const assistantRequested = requested.title ? requested : extractSongRequest(action.say);
  const rawSearchQuery = action.externalSearchQuery?.trim()
    ? action.externalSearchQuery
    : buildExternalSearchQuery(message, assistantRequested, context);
  const shouldRestoreRequestedArtist =
    requested.artist && !normalize(rawSearchQuery).includes(normalize(requested.artist));
  const shouldRestoreRequestedTitle =
    requested.title && !normalize(rawSearchQuery).includes(normalize(requested.title));
  let externalSearchQuery = biasExternalSearchQuery(
    [
      shouldRestoreRequestedTitle ? requested.title : "",
      shouldRestoreRequestedArtist ? requested.artist : "",
      rawSearchQuery
    ].filter(Boolean).join(" "),
    message
  );
  if (/詹姆斯[·\s-]*布朗特|布朗特|james\s*blunt/i.test(message) && !/james\s*blunt/i.test(externalSearchQuery)) {
    externalSearchQuery = `${externalSearchQuery} James Blunt`;
  }
  if (/you\s*(?:are|'?re)?\s*beautiful/i.test(message) && !/you'?re\s*beautiful/i.test(externalSearchQuery)) {
    externalSearchQuery = `You're Beautiful ${externalSearchQuery}`;
  }
  externalSearchQuery = biasExternalSearchQuery(externalSearchQuery, message);

  return {
    ...action,
    playTrackId: null,
    externalSearchQuery,
    say: requested.title
      ? `我先把 ${requested.title}${requested.artist ? ` - ${requested.artist}` : ""} 的候选找出来，你点想听的版本。`
      : action.say.replace(/(现在|馬上|马上)?就?给你放起来|正在播放|开始播放/g, "我先把候选找出来")
  };
}

const actionReviewPrompt = [
  "You are the second-pass auditor for Hui Radio.",
  "Your job is to verify that the proposed action matches the user's intent and the available tracks.",
  "Return strict JSON only with keys say, playTrackId, reason, externalSearchQuery.",
  "Do not invent a track id that is not in the provided tracks list.",
  "If the intent is chat_only, clear playTrackId and externalSearchQuery.",
  "If the intent is recommend_library, keep playback inside the library and clear externalSearchQuery.",
  "If the intent asks for a search or external recommendation, prefer externalSearchQuery and keep playTrackId null.",
  "If the assistant says it is playing but no valid local track exists, correct it into a candidate search or a clarification.",
  "Keep the reply concise, natural, and in Chinese when possible."
].join("\n");

function reviewAiActionRules(action: AiAction, message: string, context?: AiRequestContext, allowExternal = false): AiAction {
  const intent = classifyAiIntent(message);
  const localTrack = action.playTrackId ? getTrack(action.playTrackId) : null;
  let reviewed: AiAction = {
    ...action,
    playTrackId: localTrack ? action.playTrackId ?? null : null,
    reason: [action.reason, `intent:${intent.kind}:${intent.confidence.toFixed(2)}`].filter(Boolean).join("; ")
  };

  if (intent.kind === "chat_only") {
    return intent.confidence < 0.7 ? { ...reviewed, playTrackId: null } : { ...reviewed, playTrackId: null, externalSearchQuery: null };
  }

  if (intent.kind === "recommend_library") {
    const playable = reviewed.playTrackId ? getTrack(reviewed.playTrackId) : null;
    if (playable && (intent.allowInstrumental || !isLikelyInstrumentalCandidate(playable))) {
      return { ...reviewed, externalSearchQuery: null };
    }
    const fallback = pickPreferenceWeightedLocalTrack(listTracks(20), sanitizePreferences(context?.preferences), intent.allowInstrumental);
    return { ...reviewed, playTrackId: fallback?.id ?? null, externalSearchQuery: null };
  }

  if (intent.kind === "play_current_candidate") {
    const assistantRequested = extractSongRequest(action.say);
    if (allowExternal && assistantRequested.title && !reviewed.playTrackId) {
      return {
        ...reviewed,
        playTrackId: null,
        externalSearchQuery: biasExternalSearchQuery(
          reviewed.externalSearchQuery || buildExternalSearchQuery(message, assistantRequested, context),
          message
        ),
        say: reviewed.say.replace(/(现在|马上)?就?给你放起来|正在播放|开始播放/g, "我先把候选找出来")
      };
    }
    return { ...reviewed, playTrackId: null, externalSearchQuery: null };
  }

  reviewed = ensurePlayableActionForRequest(reviewed, message, context, allowExternal);
  reviewed = ensureExternalCandidateSearchForRequest(reviewed, message, context, allowExternal);

  if (intent.confidence < 0.7 && reviewed.playTrackId && !intent.shouldAutoplay) {
    reviewed = { ...reviewed, playTrackId: null };
  }

  return reviewed;
}

function buildReviewModelContext(action: AiAction, message: string, context?: AiRequestContext, allowExternal = false) {
  const preferences = sanitizePreferences(context?.preferences);
  const tracks = listTracks(18)
    .map((track, index) => ({
      id: track.id,
      title: track.title,
      artist: track.artist,
      language: track.language,
      genre: track.genre,
      mood: track.mood,
      scene: track.scene,
      tempo: track.tempo,
      source: track.source,
      preferenceScore: scoreTrackByPreferences(track, preferences),
      index
    }))
    .sort((a, b) => b.preferenceScore - a.preferenceScore || a.index - b.index)
    .slice(0, 10);

  return {
    message,
    allowExternal,
    intent: classifyAiIntent(message),
    context,
    action,
    tracks
  };
}

async function reviewAiActionWithModel(action: AiAction, message: string, context?: AiRequestContext, allowExternal = false): Promise<AiAction> {
  const deterministic = reviewAiActionRules(action, message, context, allowExternal);
  if (!config.OPENAI_REVIEW_MODEL || hasOpenAiClientOverrideForTests || !config.OPENAI_API_KEY) return deterministic;

  const model = config.OPENAI_REVIEW_MODEL;
  const modelContext = buildReviewModelContext(deterministic, message, context, allowExternal);

  try {
    const timeoutMs = 6_000;
    const text = await withAbortableTimeout(
      (requestOptions) =>
        isClaudeModel(model)
          ? createClaudeTextCompletion(model, actionReviewPrompt, modelContext, [], 220, requestOptions)
          : createOpenAiCompatibleTextCompletion(model, actionReviewPrompt, modelContext, [], 220, requestOptions),
      timeoutMs,
      "AI action review"
    );
    const parsed = aiActionSchema.parse(JSON.parse(text));
    return reviewAiActionRules(parsed, message, context, allowExternal);
  } catch {
    return deterministic;
  }
}

function ensurePlayableActionForRequest(action: AiAction, message: string, context?: AiRequestContext, allowExternal = false): AiAction {
  if (!wantsPlayback(message)) return action;

  const localTrack = action.playTrackId ? getTrack(action.playTrackId) : null;
  if (localTrack && (wantsInstrumentalRecommendation(message) || !isLikelyInstrumentalCandidate(localTrack))) return action;

  if (!allowExternal) {
    const fallback = pickPreferenceWeightedLocalTrack(listTracks(20), sanitizePreferences(context?.preferences), wantsInstrumentalRecommendation(message));
    return { ...action, playTrackId: fallback?.id ?? null };
  }

  const requested = extractSongRequest(message);
  const assistantRequested = requested.title ? requested : extractSongRequest(action.say);
  return {
    ...action,
    playTrackId: null,
    externalSearchQuery: action.externalSearchQuery
      ? biasExternalSearchQuery(action.externalSearchQuery, message)
      : buildExternalSearchQuery(message, assistantRequested, context)
  };
}

function localFallbackV2(message: string, allowExternal = false, context?: AiRequestContext): AiAction {
  const intent = classifyAiIntent(message);
  const tracks = listTracks(20);
  const requested = extractSongRequest(message);
  const reqTitle = normalize(requested.title);
  const reqArtist = normalize(requested.artist);

  const bestRequested =
    reqTitle &&
    [...tracks]
      .map((track) => {
        const title = normalize(track.title || "");
        const artist = normalize(track.artist || "");
        let score = 0;
        if (title === reqTitle) score += 100;
        else if (title.includes(reqTitle) || reqTitle.includes(title)) score += 70;
        if (reqArtist) {
          if (artist === reqArtist) score += 45;
          else if (artist.includes(reqArtist) || reqArtist.includes(artist)) score += 25;
        }
        return { track, score };
      })
      .sort((a, b) => b.score - a.score)[0];

  const preferences = sanitizePreferences(context?.preferences);
  const shouldUseExternal =
    allowExternal && intent.needsExternalSearch && intent.kind !== "recommend_library" && !wantsLibraryRecommendation(message);
  const preferredTrack = pickPreferenceWeightedLocalTrack(tracks, preferences, wantsInstrumentalRecommendation(message));
  const picked = shouldUseExternal ? null : bestRequested && bestRequested.score >= 95 ? bestRequested.track : preferredTrack || tracks[0];
  const externalSearchQuery = allowExternal && (shouldUseExternal || requested.title || !picked) ? buildExternalSearchQuery(message, requested, context) : undefined;

  return {
    say: externalSearchQuery && shouldUseExternal
      ? `\u6211\u7ed9\u4f60\u5f80\u66f2\u5e93\u5916\u627e\u4e00\u9996\uff1a${externalSearchQuery}\u3002\u5019\u9009\u5361\u7247\u51fa\u6765\u540e\uff0c\u4f60\u53ef\u4ee5\u76f4\u63a5\u70b9\u64ad\u653e\u8bd5\u542c\u3002`
      : picked
      ? `\u6211\u5148\u63a8\u8350 ${picked.title}${picked.artist ? ` - ${picked.artist}` : ""}\u3002\u5982\u679c\u4e91\u7aef AI \u6682\u65f6\u4e0d\u53ef\u7528\uff0c\u6211\u4f1a\u5148\u7528\u672c\u5730\u89c4\u5219\u7ee7\u7eed\u966a\u4f60\u542c\u3002`
      : `\u6211\u542c\u5230\u4e86\uff1a${message}\u3002\u5148\u5bfc\u5165\u4e00\u4e9b\u6b4c\u66f2\uff0c\u6216\u8005\u8ba9\u6211\u53bb\u66f2\u5e93\u5916\u627e\u4e00\u9996\u9002\u5408\u6b64\u523b\u7684\u6b4c\u3002`,
    playTrackId: picked ? picked.id : null,
    externalSearchQuery,
    reason: "local-fallback"
  };
}

function localWelcome(context?: AiRequestContext, trackCount = 0) {
  const current = context?.currentTrack;
  const scene = [context?.city, context?.weather, context?.mood, context?.timeSlot].filter(Boolean).join("\u3001");
  const lines = [
    "\u8fd9\u91cc\u662f Hui Radio\uff0c\u4eca\u665a\u6211\u4f1a\u628a\u6b4c\u5355\u653e\u8f7b\u4e00\u70b9\uff0c\u8ba9\u6bcf\u4e00\u9996\u6b4c\u90fd\u50cf\u521a\u597d\u8def\u8fc7\u4f60\u7684\u623f\u95f4\u3002",
    trackCount > 0
      ? `Hui Radio \u5df2\u7ecf\u63a5\u4e0a\u4f60\u7684 ${trackCount} \u9996\u6b4c\u3002\u4f60\u53ea\u7ba1\u8bf4\u73b0\u5728\u7684\u5fc3\u60c5\uff0c\u6211\u6765\u628a\u4e0b\u4e00\u9996\u653e\u5230\u521a\u521a\u597d\u3002`
      : "Hui Radio \u5df2\u7ecf\u5f00\u53f0\u3002\u5148\u628a\u6b4c\u5355\u5bfc\u8fdb\u6765\uff0c\u6216\u8005\u544a\u8bc9\u6211\u4e00\u4e2a\u5fc3\u60c5\uff0c\u6211\u4f1a\u66ff\u4f60\u627e\u4e00\u9996\u5408\u9002\u7684\u3002",
    current
      ? `\u73b0\u5728\u6211\u4eec\u505c\u5728 ${current.title}${current.artist ? ` - ${current.artist}` : ""} \u9644\u8fd1\u3002Hui Radio \u4f1a\u987a\u7740\u8fd9\u70b9\u6c14\u6c1b\u7ee7\u7eed\u5f80\u4e0b\u653e\u3002`
      : "\u8fd9\u91cc\u662f Hui Radio\u3002\u7ed9\u6211\u4e00\u70b9\u57ce\u5e02\u3001\u5929\u6c14\u6216\u5fc3\u60c5\uff0c\u6211\u4f1a\u50cf\u7535\u53f0\u4e3b\u64ad\u4e00\u6837\u66ff\u4f60\u63a5\u4f4f\u8fd9\u4e00\u523b\u3002",
    scene ? `\u6211\u770b\u5230\u6b64\u523b\u7684\u7ebf\u7d22\u662f ${scene}\u3002Hui Radio \u4f1a\u628a\u58f0\u97f3\u6536\u5f97\u67d4\u4e00\u70b9\uff0c\u966a\u4f60\u6162\u6162\u542c\u3002` : ""
  ].filter(Boolean);
  return lines[Math.floor(Math.random() * lines.length)];
}

function parseAiJson(text: string): AiAction {
  try {
    return aiActionSchema.parse(JSON.parse(text));
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return aiActionSchema.parse(JSON.parse(match[0]));
    throw new Error("AI response is not valid JSON");
  }
}

function getAbortMessage(reason: unknown, label: string, ms: number) {
  if (reason instanceof Error && reason.message) return reason.message;
  if (typeof reason === "string" && reason) return reason;
  return `${label} timed out after ${ms}ms`;
}

async function withAbortableTimeout<T>(
  run: (options: RequestOptions) => Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`${label} timed out after ${ms}ms`)), ms);

  try {
    return await run({ signal: controller.signal, timeout: ms, maxRetries: 0 });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(getAbortMessage(controller.signal.reason, label, ms));
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function setOpenAiClientForTests(nextClient: OpenAIClientLike | null) {
  client = nextClient;
  hasOpenAiClientOverrideForTests = Boolean(nextClient);
}

function toChatMessageParams(messages: AiMessage[]): ChatMessageParam[] {
  return messages.map((entry) => ({ role: entry.role, content: entry.content }));
}

function sanitizeMemorySummary(text: string) {
  const cleaned = text
    .trim()
    .replace(/^```[a-z]*\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  return cleaned || DEFAULT_AUTO_MEMORY;
}

function shouldRefreshMemory(pendingCount: number, lastSummaryAt?: string) {
  if (pendingCount >= SUMMARY_BATCH_SIZE) return true;
  if (!pendingCount) return false;
  if (!lastSummaryAt) return false;
  const elapsed = Date.now() - new Date(lastSummaryAt).getTime();
  return Number.isFinite(elapsed) && elapsed >= SUMMARY_MIN_INTERVAL_MS;
}

async function createClaudeTextCompletion(
  model: string,
  systemPrompt: string,
  context: unknown,
  messages: ChatMessageParam[],
  maxTokens: number,
  requestOptions: RequestOptions
) {
  if (!config.OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  const response = await rightCodesFetch(resolveClaudeMessagesUrl(model), {
    method: "POST",
    signal: requestOptions.signal,
    headers: {
      "content-type": "application/json",
      "x-api-key": config.OPENAI_API_KEY,
      authorization: `Bearer ${config.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: `Context: ${JSON.stringify(context)}`, cache_control: { type: "ephemeral" } }]
        },
        ...messages.map((message) => ({
          role: message.role,
          content: [{ type: "text", text: message.content }]
        }))
      ],
      stream: true
    })
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as ClaudeMessageResponse;
    throw new Error(`${response.status} ${payload.error?.message || response.statusText}`);
  }

  const text = await readAnthropicStreamText(response);
  if (!text) throw new Error("Claude response is empty");
  return text;
}

async function createClaudeMessage(context: unknown, messages: ChatMessageParam[], requestOptions: RequestOptions) {
  return createClaudeTextCompletion(config.OPENAI_TEXT_MODEL, radioSystemPrompt, context, messages, 220, requestOptions);
}

async function createClaudeWelcome(context: unknown, requestOptions: RequestOptions) {
  return createClaudeTextCompletion(config.OPENAI_TEXT_MODEL, welcomePrompt, context, [], 100, requestOptions);
}

async function createClaudeMemorySummary(context: unknown, messages: ChatMessageParam[], requestOptions: RequestOptions) {
  return createClaudeTextCompletion(config.OPENAI_TEXT_MODEL, memorySummaryPrompt, context, messages, 220, requestOptions);
}

async function createOpenAiCompatibleMessage(context: unknown, messages: ChatMessageParam[], requestOptions: RequestOptions) {
  return createOpenAiCompatibleTextCompletion(config.OPENAI_TEXT_MODEL, radioSystemPrompt, context, messages, 220, requestOptions);
}

async function createOpenAiCompatibleWelcome(context: unknown, requestOptions: RequestOptions) {
  const text = await createOpenAiCompatibleTextCompletion(config.OPENAI_TEXT_MODEL, welcomePrompt, context, [], 100, requestOptions);
  if (!text) throw new Error("OpenAI welcome response is empty");
  return text.replace(/^["\u201c\u201d]|["\u201c\u201d]$/g, "");
}

async function createOpenAiCompatibleMemorySummary(context: unknown, messages: ChatMessageParam[], requestOptions: RequestOptions) {
  return createOpenAiCompatibleTextCompletion(config.OPENAI_TEXT_MODEL, memorySummaryPrompt, context, messages, 220, requestOptions);
}

async function createOpenAiCompatibleTextCompletion(
  model: string,
  systemPrompt: string,
  context: unknown,
  messages: ChatMessageParam[],
  maxTokens: number,
  requestOptions: RequestOptions
) {
  const response = await client!.chat.completions.create(
    {
      model,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Context: ${JSON.stringify(context)}` },
        ...messages
      ]
    } as never,
    requestOptions as never
  );
  const text = response.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("OpenAI response is empty");
  return text;
}

export async function refreshGlobalMemoryFromMessages(options?: { timeoutMs?: number }) {
  await ensureAgentsMemoryFile();

  const state = getAiMemoryState();
  const pending = listAiMessagesSince(state.lastSummaryMessageId, 40);
  if (!shouldRefreshMemory(pending.length, state.lastSummaryAt)) return;

  const currentMemory = await readAutoMemory();
  const context = {
    currentMemory,
    objective: "Extract only durable listener preferences for future welcome messages."
  };
  const messages = toChatMessageParams(pending);
  const latestId = pending[pending.length - 1]?.id ?? state.lastSummaryMessageId;

  if (!messages.length) return;
  if (!client) {
    updateAiMemoryState({ lastSummaryMessageId: latestId, lastSummaryAt: new Date().toISOString() });
    return;
  }

  const timeoutMs = options?.timeoutMs ?? 8_000;
  const summary = await withAbortableTimeout(
    (requestOptions) =>
      isClaudeTextModel()
        ? createClaudeMemorySummary(context, messages, requestOptions)
        : createOpenAiCompatibleMemorySummary(context, messages, requestOptions),
    timeoutMs,
    "Global memory summary"
  );

  await writeAutoMemory(sanitizeMemorySummary(summary));
  updateAiMemoryState({
    lastSummaryMessageId: latestId,
    lastSummaryAt: new Date().toISOString()
  });
}

export async function askAi(
  message: string,
  options?: { timeoutMs?: number; context?: AiRequestContext; allowExternal?: boolean; sessionId?: string }
): Promise<AiAction> {
  const intent = classifyAiIntent(message);
  const sessionId = options?.sessionId?.trim() || "default";
  saveAiMessage(sessionId, "user", message);
  const recentMessages = listRecentAiMessages(sessionId, RECENT_MESSAGE_LIMIT);
  const history = toChatMessageParams(recentMessages);

  if (!client) {
    const fallback = localFallbackV2(message, options?.allowExternal, options?.context);
    saveAiMessage(sessionId, "assistant", fallback.say);
    void refreshGlobalMemoryFromMessages().catch(() => undefined);
    return fallback;
  }

  const preferences = sanitizePreferences(options?.context?.preferences);
  const tracks = listTracks(50)
    .map((track, index) => ({ track, index, preferenceScore: scoreTrackByPreferences(track, preferences) }))
    .sort((a, b) => b.preferenceScore - a.preferenceScore || a.index - b.index)
    .slice(0, 12)
    .map(({ track, preferenceScore }) => ({
      id: track.id,
      title: track.title,
      artist: track.artist,
      language: track.language,
      genre: track.genre,
      mood: track.mood,
      scene: track.scene,
      tempo: track.tempo,
      source: track.source,
      preferenceScore
    }));
  const context = {
    now: formatBeijingNow(),
    tracks,
    intent,
    recentConversation: recentMessages.map((entry) => ({ role: entry.role, content: entry.content })),
    listener: { ...(options?.context || {}), preferenceHints: topPreferenceTerms(preferences) },
    allowExternal: Boolean(options?.allowExternal)
  };

  try {
    const timeoutMs = options?.timeoutMs ?? 20_000;
    let lastError: unknown;
    const attempts = isClaudeTextModel() ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const text = await withAbortableTimeout(
          (requestOptions) =>
            attempt === 0
              ? createOpenAiCompatibleMessage(context, history, requestOptions)
              : createClaudeMessage(context, history, requestOptions),
          timeoutMs,
          attempt === 0 ? "OpenAI response" : "Claude response"
        );
        const parsed = await reviewAiActionWithModel(parseAiJson(text), message, options?.context, options?.allowExternal);
        saveAiMessage(sessionId, "assistant", parsed.say);
        void refreshGlobalMemoryFromMessages().catch(() => undefined);
        return parsed;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  } catch (error) {
    const fallback = localFallbackV2(message, options?.allowExternal, options?.context);
    fallback.reason = `openai-fallback: ${error instanceof Error ? error.message : String(error)}`;
    saveAiMessage(sessionId, "assistant", fallback.say);
    void refreshGlobalMemoryFromMessages().catch(() => undefined);
    return fallback;
  }
}

export async function createWelcome(
  options?: { timeoutMs?: number; context?: AiRequestContext; trackCount?: number; sessionId?: string }
): Promise<{ say: string }> {
  await ensureAgentsMemoryFile();
  const globalMemory = await readAutoMemory();
  const context = {
    now: formatBeijingNow(),
    trackCount: options?.trackCount ?? listTracks().length,
    listener: options?.context || {},
    globalMemory
  };

  if (!client) return { say: localWelcome(options?.context, context.trackCount) };

  try {
    const timeoutMs = options?.timeoutMs ?? 8_000;
    let lastError: unknown;
    const attempts = isClaudeTextModel() ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const say = await withAbortableTimeout(
          (requestOptions) =>
            attempt === 0 ? createOpenAiCompatibleWelcome(context, requestOptions) : createClaudeWelcome(context, requestOptions),
          timeoutMs,
          attempt === 0 ? "OpenAI welcome" : "Claude welcome"
        );
        return { say: say.slice(0, 180) };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  } catch {
    return { say: localWelcome(options?.context, context.trackCount) };
  }
}

export function ttsCachePath(text: string) {
  const hash = crypto.createHash("sha256").update(`${config.OPENAI_TTS_MODEL}|${config.OPENAI_TTS_VOICE}|${text}`).digest("hex");
  return {
    hash,
    filePath: path.join(config.ttsCacheDir, `${hash}.mp3`),
    publicUrl: `/cache/tts/${hash}.mp3`
  };
}

export function formatSiliconFlowTtsInput(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (/^\[S\d+\]/i.test(trimmed)) return trimmed;
  return `[S1] ${trimmed}`;
}

export function buildSiliconFlowSpeechRequest(params: { text: string; model: string; voice: string; baseUrl: string }) {
  return {
    url: new URL("audio/speech", `${params.baseUrl.replace(/\/$/, "")}/`).toString(),
    body: {
      model: params.model,
      voice: params.voice,
      input: formatSiliconFlowTtsInput(params.text),
      response_format: "mp3",
      stream: false
    }
  };
}

export async function synthesizeSpeech(text: string): Promise<{ url: string; cached: boolean }> {
  const cache = ttsCachePath(text);
  try {
    await fs.access(cache.filePath);
    return { url: cache.publicUrl, cached: true };
  } catch {
    // Cache miss.
  }

  if (!config.SILICONFLOW_API_KEY) throw new Error("Missing SILICONFLOW_API_KEY; cannot generate cloud TTS");
  const request = buildSiliconFlowSpeechRequest({
    text,
    model: config.OPENAI_TTS_MODEL,
    voice: config.OPENAI_TTS_VOICE,
    baseUrl: config.SILICONFLOW_BASE_URL
  });
  const speech = await withAbortableTimeout(
    (requestOptions) =>
      fetchWithOptionalProxy(request.url, {
        method: "POST",
        signal: requestOptions.signal,
        headers: {
          "content-type": "application/json",
          accept: "audio/mpeg",
          authorization: `Bearer ${config.SILICONFLOW_API_KEY}`
        },
        body: JSON.stringify(request.body)
      }),
    20_000,
    "SiliconFlow TTS"
  );
  if (!speech.ok) {
    const detail = await speech.text().catch(() => "");
    throw new Error(`SiliconFlow TTS failed: ${speech.status} ${detail || speech.statusText}`);
  }
  const bytes = Buffer.from(await speech.arrayBuffer());
  await fs.writeFile(cache.filePath, bytes);
  return { url: cache.publicUrl, cached: false };
}
