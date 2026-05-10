import { describe, expect, it } from "vitest";
import { classifyAiIntent, isExplicitPlaybackRequest } from "../src/aiPlayback.js";
import { extractSongRequest, wantsExternalCandidateSearch } from "../shared/aiIntent.js";

describe("AI playback intent", () => {
  it("detects explicit playback requests", () => {
    expect(isExplicitPlaybackRequest("播放晴天")).toBe(true);
    expect(isExplicitPlaybackRequest("帮我放一首安静的歌")).toBe(true);
    expect(isExplicitPlaybackRequest("那你放啊")).toBe(true);
    expect(isExplicitPlaybackRequest("就这首，播吧")).toBe(true);
    expect(isExplicitPlaybackRequest("play Windy Hill")).toBe(true);
    expect(isExplicitPlaybackRequest("詹姆斯布朗特的youarebeautiful")).toBe(true);
  });

  it("keeps passive recommendations from auto-playing", () => {
    expect(isExplicitPlaybackRequest("推荐几首安静的歌")).toBe(false);
    expect(isExplicitPlaybackRequest("介绍一下适合深夜的歌单")).toBe(false);
  });

  it("classifies library, external, direct search, and current candidate intents", () => {
    expect(classifyAiIntent("来一首我没听过的中文歌")).toMatchObject({
      kind: "recommend_external",
      needsExternalSearch: true
    });
    expect(classifyAiIntent("放曲库里的歌")).toMatchObject({
      kind: "recommend_library",
      needsExternalSearch: false
    });
    expect(classifyAiIntent("詹姆斯布朗特的 you are beautiful")).toMatchObject({
      kind: "search_song",
      requestedTitle: "You're Beautiful",
      requestedArtist: "James Blunt"
    });
    expect(classifyAiIntent("那你倒是播放啊")).toMatchObject({
      kind: "play_current_candidate",
      shouldAutoplay: true
    });
  });

  it("treats current-song questions as chat, not a song search", () => {
    expect(classifyAiIntent("这首歌讲的是什么")).toMatchObject({
      kind: "chat_only",
      needsExternalSearch: false,
      shouldAutoplay: false
    });
    expect(isExplicitPlaybackRequest("这首歌讲的是什么")).toBe(false);
    expect(wantsExternalCandidateSearch("这首歌讲的是什么")).toBe(false);
    expect(extractSongRequest("这首歌讲的是什么")).toEqual({ title: "", artist: "" });
  });
});
