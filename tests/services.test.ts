import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addTrackToPlaylist, db, enqueueTracks, getDefaultFavoritesPlaylist, listQueue, markQueueItem, upsertTrack } from "../server/db.js";
import { askAi, aiActionSchema, setOpenAiClientForTests, ttsCachePath } from "../server/services/openai.js";

beforeEach(() => {
  db.exec(`
    DELETE FROM ai_messages;
    DELETE FROM plays;
    DELETE FROM queue;
    DELETE FROM playlist_tracks;
    DELETE FROM playlists;
    DELETE FROM tracks;
  `);
});

afterEach(() => {
  setOpenAiClientForTests(null);
});

describe("AI action schema", () => {
  it("accepts local and external recommendation actions", () => {
    expect(
      aiActionSchema.parse({
        say: "下一首给你放这首。",
        playTrackId: 1,
        externalSearchQuery: "Monday Night Exhale Bread"
      })
    ).toMatchObject({ playTrackId: 1, externalSearchQuery: "Monday Night Exhale Bread" });
  });
});

describe("askAi", () => {
  it("returns parsed JSON from OpenAI chat completions", async () => {
    setOpenAiClientForTests({
      chat: {
        completions: {
          create: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    say: "这首很适合现在。",
                    playTrackId: 7,
                    queueTrackIds: [7],
                    externalSearchQuery: null
                  })
                }
              }
            ]
          })
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
    expect(result).toMatchObject({ say: "这首很适合现在。", playTrackId: 7, queueTrackIds: [7], externalSearchQuery: null });
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
});

describe("queue and favorites", () => {
  it("marks the current queue item and exposes the next queued track", () => {
    const first = upsertTrack({ title: "First", artist: "DJ", source: "test" });
    const second = upsertTrack({ title: "Second", artist: "DJ", source: "test" });
    enqueueTracks([first.id, second.id]);

    const [current] = listQueue();
    const queue = markQueueItem(current.id, "played");

    expect(queue).toHaveLength(1);
    expect(queue[0].track.title).toBe("Second");
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
