import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import { config } from "../server/config.js";
import {
  addTrackToPlaylist,
  db,
  getAiMemoryState,
  getDefaultFavoritesPlaylist,
  getTrack,
  listRecentAiMessages,
  upsertTrack
} from "../server/db.js";
import { askAi, aiActionSchema, refreshGlobalMemoryFromMessages, setOpenAiClientForTests, ttsCachePath } from "../server/services/openai.js";
import { DEFAULT_AUTO_MEMORY, ensureAgentsMemoryFile, readAutoMemory } from "../server/services/memory.js";

beforeEach(async () => {
  db.exec(`
    DELETE FROM ai_messages;
    UPDATE ai_memory_state SET active_session_id = NULL, last_summary_message_id = 0, last_summary_at = NULL WHERE id = 1;
    DELETE FROM plays;
    DELETE FROM queue;
    DELETE FROM playlist_tracks;
    DELETE FROM playlists;
    DELETE FROM tracks;
  `);

  await ensureAgentsMemoryFile();
  await fs.writeFile(
    config.agentsMemoryPath,
    `# Hui Radio Memory

This file stores long-term listener preferences distilled from prior conversations.
Only the auto memory section is rewritten by the app. You can edit Manual Notes freely.

## Auto Memory
<!-- AUTO_MEMORY_START -->
${DEFAULT_AUTO_MEMORY}
<!-- AUTO_MEMORY_END -->

## Manual Notes
- keep me
`,
    "utf8"
  );
});

afterEach(() => {
  setOpenAiClientForTests(null);
});

describe("AI action schema", () => {
  it("accepts local and external recommendation actions", () => {
    expect(
      aiActionSchema.parse({
        say: "这首很适合现在。",
        playTrackId: 1,
        externalSearchQuery: "Monday Night Exhale Bread"
      })
    ).toMatchObject({ playTrackId: 1, externalSearchQuery: "Monday Night Exhale Bread" });
  });
});

describe("askAi", () => {
  it("returns parsed JSON from OpenAI chat completions and includes recent conversation context", async () => {
    const capturedBodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    setOpenAiClientForTests({
      chat: {
        completions: {
          create: async (body: { messages: Array<{ role: string; content: string }> }) => {
            capturedBodies.push(body);
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      say: "这首很适合现在。",
                      playTrackId: 7,
                      externalSearchQuery: null
                    })
                  }
                }
              ]
            };
          }
        }
      },
      audio: {
        speech: {
          create: async () => new Response()
        }
      }
    });

    const result = await askAi("来一首", {
      allowExternal: true,
      context: { city: "深圳", weather: "下雨", mood: "有点累", timeSlot: "晚上" }
    });

    expect(result).toMatchObject({ say: "这首很适合现在。", playTrackId: 7, externalSearchQuery: null });
    expect(capturedBodies[0]?.messages.some((entry) => typeof entry.content === "string" && entry.content.includes(`"recentConversation"`))).toBe(
      true
    );
  });

  it("falls back quickly when the OpenAI request hangs", async () => {
    upsertTrack({ title: "Timeout Song", artist: "Test Artist", source: "test" });
    setOpenAiClientForTests({
      chat: {
        completions: {
          create: async (_body: unknown, options?: { signal?: AbortSignal }) =>
            new Promise((_, reject) => {
              options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
            })
        }
      },
      audio: {
        speech: {
          create: async () => new Response()
        }
      }
    });

    const startedAt = Date.now();
    const result = await askAi("别卡住", { timeoutMs: 50 });
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(500);
    expect(result.playTrackId).not.toBeNull();
    expect(result.say).toContain("如果云端 AI 暂时不可用");
    expect(result.reason).toContain("openai-fallback");
    expect(result.reason).toContain("timed out after 50ms");
  });

  it("prefers external candidates for generic recommendation fallback when allowed", async () => {
    upsertTrack({ title: "Library Song", artist: "Known Artist", source: "test" });

    const result = await askAi("推荐一首我没听过的安静中文歌", {
      allowExternal: true,
      context: { mood: "安静", timeSlot: "深夜" }
    });

    expect(result.playTrackId).toBeNull();
    expect(result.externalSearchQuery).toContain("安静");
    expect(result.say).toContain("曲库外");
  });

  it("stores and isolates recent messages by session id", async () => {
    setOpenAiClientForTests({
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: JSON.stringify({ say: "ok", playTrackId: null, externalSearchQuery: null }) } }]
          })
        }
      },
      audio: { speech: { create: async () => new Response() } }
    });

    await askAi("first session", { sessionId: "alpha" });
    await askAi("second session", { sessionId: "beta" });

    expect(listRecentAiMessages("alpha", 10).map((item) => item.content)).toEqual(["first session", "ok"]);
    expect(listRecentAiMessages("beta", 10).map((item) => item.content)).toEqual(["second session", "ok"]);
    expect(getAiMemoryState().activeSessionId).toBe("beta");
  });
});

describe("global memory summary", () => {
  it("updates only the auto memory block and preserves manual notes", async () => {
    const rows: Array<[string, "user" | "assistant", string]> = [
      ["default", "user", "我总想听夜晚、安静一点、中文流行情绪歌。"],
      ["default", "assistant", "好，我会偏温柔一点。"],
      ["default", "user", "说话可以像深夜电台，短句一点。"],
      ["default", "assistant", "记住了。"],
      ["default", "user", "多推荐中文女声。"],
      ["default", "assistant", "好的。"]
    ];
    rows.forEach(([sessionId, role, content]) => {
      db.prepare("INSERT INTO ai_messages (session_id, role, content) VALUES (?, ?, ?)").run(sessionId, role, content);
    });

    setOpenAiClientForTests({
      chat: {
        completions: {
          create: async (body: { messages: Array<{ role: string; content: string }> }) => {
            const system = body.messages[0]?.content || "";
            if (typeof system === "string" && system.includes("long-term listener memory")) {
              return {
                choices: [
                  {
                    message: {
                      content:
                        "- 偏好夜晚、安静一点的中文流行情绪歌\n- 喜欢深夜电台式、短句、温柔的表达\n- 经常想听中文女声"
                    }
                  }
                ]
              };
            }
            return { choices: [{ message: { content: "{}" } }] };
          }
        }
      },
      audio: { speech: { create: async () => new Response() } }
    });

    await refreshGlobalMemoryFromMessages({ timeoutMs: 1000 });

    const autoMemory = await readAutoMemory();
    const file = await fs.readFile(config.agentsMemoryPath, "utf8");
    expect(autoMemory).toContain("偏好夜晚");
    expect(file).toContain("- keep me");
    expect(getAiMemoryState().lastSummaryMessageId).toBeGreaterThan(0);
  });
});

describe("library and favorites", () => {
  it("persists listener preference track tags", () => {
    const track = upsertTrack({
      title: "Tagged Song",
      artist: "Hui",
      language: "Mandarin",
      genre: "dream pop",
      mood: "calm",
      scene: "late night",
      tempo: "slow",
      energy: 4,
      source: "test"
    });

    expect(getTrack(track.id)).toMatchObject({
      title: "Tagged Song",
      artist: "Hui",
      language: "Mandarin",
      genre: "dream pop",
      mood: "calm",
      scene: "late night",
      tempo: "slow",
      energy: 4
    });
  });

  it("adds a track to the default favorites playlist", () => {
    const track = upsertTrack({ title: "Keeper", artist: "Hui", source: "test" });
    const playlist = getDefaultFavoritesPlaylist();
    addTrackToPlaylist(playlist.id, track.id);

    const row = db
      .prepare("SELECT COUNT(*) AS count FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?")
      .get(playlist.id, track.id) as { count: number };
    expect(row.count).toBe(1);
  });
});

describe("TTS cache", () => {
  it("is stable for the same text", () => {
    expect(ttsCachePath("你好").hash).toBe(ttsCachePath("你好").hash);
  });
});
