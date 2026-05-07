import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { z } from "zod";
import { config } from "../config.js";
import { getAiMemoryState, listAiMessagesSince, listQueue, listRecentAiMessages, listTracks, saveAiMessage, updateAiMemoryState } from "../db.js";
import { DEFAULT_AUTO_MEMORY, ensureAgentsMemoryFile, readAutoMemory, writeAutoMemory } from "./memory.js";
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

export interface AiRequestContext {
  city?: string;
  weather?: string;
  mood?: string;
  timeSlot?: string;
  currentTrack?: Pick<Track, "id" | "title" | "artist" | "source"> | null;
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

function resolveClaudeMessagesUrl() {
  const baseUrl = config.OPENAI_BASE_URL || "https://www.right.codes/claude/v1";
  const claudePath = config.OPENAI_TEXT_MODEL.startsWith("claude-haiku-") ? "/claude-aws/v1/messages" : "/claude/v1/messages";
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
  queueTrackIds: z.array(z.number().int()).optional(),
  externalSearchQuery: z.string().nullable().optional()
});

export type AiAction = z.infer<typeof aiActionSchema>;

const radioSystemPrompt = [
  "\u4f60\u662f Hui Radio \u7684\u4e2d\u6587 AI \u7535\u53f0\u4e3b\u64ad\uff0c\u50cf\u771f\u4eba DJ \u4e00\u6837\u81ea\u7136\u8bf4\u8bdd\uff0c\u77ed\u53e5\u3001\u6e29\u67d4\u3001\u6709\u753b\u9762\u611f\u3002",
  "\u4f18\u5148\u4ece provided library \u548c queue \u91cc\u9009\u6b4c\uff0c\u53ea\u80fd\u4f7f\u7528\u4e0a\u4e0b\u6587\u4e2d\u771f\u5b9e\u5b58\u5728\u7684 track id\u3002",
  "\u5982\u679c allowExternal \u4e3a true\uff0c\u4e14\u4f60\u60f3\u63a8\u8350\u66f2\u5e93\u5916\u6b4c\u66f2\uff0c\u8bf7\u628a externalSearchQuery \u5199\u6210\u660e\u786e\u7684\u201c\u6b4c\u540d \u827a\u4eba\u201d\u641c\u7d22\u8bcd\uff0c\u4e0d\u8981\u7ed9\u66f2\u5e93\u5916\u6b4c\u66f2\u7f16\u9020 id\u3002",
  '\u53ea\u8fd4\u56de\u4e25\u683c JSON\uff1a{"say":"\u4e3b\u64ad\u53e3\u64ad\uff0c\u4e2d\u6587\uff0c80\u5b57\u4ee5\u5185","playTrackId":number|null,"reason":"optional","queueTrackIds":[number],"externalSearchQuery":string|null}\u3002',
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

function normalize(value: string) {
  return value.toLowerCase().replace(/[\u3001\u3002\u300a\u300b\u300c\u300d\u300e\u300f\u201c\u201d\u2018\u2019"'`()[\]\uff08\uff09\s]/g, "");
}

function extractSongRequest(message: string) {
  const quoted = message.match(/[\u300a\u300c\u300e\u201c"]([^\u300b\u300d\u300f\u201d"]+)[\u300b\u300d\u300f\u201d"]/)?.[1] || "";
  const titleFromCommand = message.match(/(?:\u64ad\u653e|\u70b9\u64ad|\u6765\u4e00\u9996|\u60f3\u542c)\s*([^\s\uff0c\u3002\uff01\uff1f,.!?]{1,32})/)?.[1] || "";
  const artist = message.match(/(?:by|\u6b4c\u624b|\u5531\u7684|\u7248\u672c|\u539f\u5531)\s*([^\s\uff0c\u3002\uff01\uff1f,.!?]+)/i)?.[1] || "";
  const title = (quoted || titleFromCommand).replace(/(\u7136\u540e|\u4f46\u662f|\u4e0d\u8fc7|\u7ed9\u6211|\u987a\u4fbf).*$/u, "").trim();
  return { title, artist: artist.trim() };
}

function localFallbackV2(message: string, allowExternal = false): AiAction {
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

  const picked = bestRequested && bestRequested.score >= 95 ? bestRequested.track : tracks[0];
  const externalSearchQuery =
    allowExternal && requested.title
      ? `${requested.title}${requested.artist ? ` ${requested.artist}` : ""}`
      : allowExternal && !picked
        ? message.slice(0, 80)
        : undefined;

  return {
    say: picked
      ? `\u6211\u5148\u7ed9\u4f60\u653e ${picked.title}${picked.artist ? ` - ${picked.artist}` : ""}\u3002\u5982\u679c\u4e91\u7aef AI \u6682\u65f6\u4e0d\u53ef\u7528\uff0c\u6211\u4f1a\u5148\u7528\u672c\u5730\u89c4\u5219\u7ee7\u7eed\u966a\u4f60\u542c\u3002`
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
  systemPrompt: string,
  context: unknown,
  messages: ChatMessageParam[],
  maxTokens: number,
  requestOptions: RequestOptions
) {
  if (!config.OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  const response = await rightCodesFetch(resolveClaudeMessagesUrl(), {
    method: "POST",
    signal: requestOptions.signal,
    headers: {
      "content-type": "application/json",
      "x-api-key": config.OPENAI_API_KEY,
      authorization: `Bearer ${config.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: config.OPENAI_TEXT_MODEL,
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
  return createClaudeTextCompletion(radioSystemPrompt, context, messages, 220, requestOptions);
}

async function createClaudeWelcome(context: unknown, requestOptions: RequestOptions) {
  return createClaudeTextCompletion(welcomePrompt, context, [], 100, requestOptions);
}

async function createClaudeMemorySummary(context: unknown, messages: ChatMessageParam[], requestOptions: RequestOptions) {
  return createClaudeTextCompletion(memorySummaryPrompt, context, messages, 220, requestOptions);
}

async function createOpenAiCompatibleMessage(context: unknown, messages: ChatMessageParam[], requestOptions: RequestOptions) {
  const response = await client!.chat.completions.create(
    {
      model: config.OPENAI_TEXT_MODEL,
      max_tokens: 220,
      messages: [
        { role: "system", content: radioSystemPrompt },
        { role: "user", content: `Context: ${JSON.stringify(context)}` },
        ...messages
      ]
    } as never,
    requestOptions as never
  );
  return response.choices?.[0]?.message?.content || "{}";
}

async function createOpenAiCompatibleWelcome(context: unknown, requestOptions: RequestOptions) {
  const response = await client!.chat.completions.create(
    {
      model: config.OPENAI_TEXT_MODEL,
      max_tokens: 100,
      messages: [
        { role: "system", content: welcomePrompt },
        { role: "user", content: `Context: ${JSON.stringify(context)}` }
      ]
    } as never,
    requestOptions as never
  );
  const text = response.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("OpenAI welcome response is empty");
  return text.replace(/^["\u201c\u201d]|["\u201c\u201d]$/g, "");
}

async function createOpenAiCompatibleMemorySummary(context: unknown, messages: ChatMessageParam[], requestOptions: RequestOptions) {
  const response = await client!.chat.completions.create(
    {
      model: config.OPENAI_TEXT_MODEL,
      max_tokens: 220,
      messages: [
        { role: "system", content: memorySummaryPrompt },
        { role: "user", content: `Context: ${JSON.stringify(context)}` },
        ...messages
      ]
    } as never,
    requestOptions as never
  );
  const text = response.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("OpenAI memory summary response is empty");
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
  const sessionId = options?.sessionId?.trim() || "default";
  saveAiMessage(sessionId, "user", message);
  const recentMessages = listRecentAiMessages(sessionId, RECENT_MESSAGE_LIMIT);
  const history = toChatMessageParams(recentMessages);

  if (!client) {
    const fallback = localFallbackV2(message, options?.allowExternal);
    saveAiMessage(sessionId, "assistant", fallback.say);
    void refreshGlobalMemoryFromMessages().catch(() => undefined);
    return fallback;
  }

  const context = {
    tracks: listTracks(12).map((track) => ({ id: track.id, title: track.title, artist: track.artist, source: track.source })),
    queue: listQueue().slice(0, 6).map((item) => ({ id: item.track.id, title: item.track.title, artist: item.track.artist })),
    recentConversation: recentMessages.map((entry) => ({ role: entry.role, content: entry.content })),
    listener: options?.context || {},
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
        const parsed = parseAiJson(text);
        saveAiMessage(sessionId, "assistant", parsed.say);
        void refreshGlobalMemoryFromMessages().catch(() => undefined);
        return parsed;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  } catch (error) {
    const fallback = localFallbackV2(message, options?.allowExternal);
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
    now: new Date().toISOString(),
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
