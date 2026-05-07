import { describe, expect, it } from "vitest";
import {
  applyPreferenceDelta,
  createEmptyPreferences,
  loadPreferences,
  pickPreferenceWeightedTrack,
  recordPreferenceEvent,
  savePreferences,
  scoreTrackByPreferences
} from "../src/preferences.js";
import type { Track } from "../src/types.js";

function track(patch: Partial<Track>): Track {
  return {
    id: patch.id || 1,
    title: patch.title || "Song",
    artist: patch.artist,
    language: patch.language,
    genre: patch.genre,
    mood: patch.mood,
    scene: patch.scene,
    tempo: patch.tempo,
    source: patch.source || "test"
  };
}

describe("preferences", () => {
  it("updates all matching tag buckets for behavior events", () => {
    const preferences = recordPreferenceEvent(
      createEmptyPreferences(),
      track({
        artist: "Hui",
        language: "Mandarin",
        genre: "ambient / pop",
        mood: "calm",
        scene: "late night",
        tempo: "slow"
      }),
      "favorite"
    );

    expect(preferences.artist.Hui).toBe(5);
    expect(preferences.language.Mandarin).toBe(5);
    expect(preferences.genre.ambient).toBe(5);
    expect(preferences.genre.pop).toBe(5);
    expect(preferences.mood.calm).toBe(5);
    expect(preferences.scene["late night"]).toBe(5);
    expect(preferences.tempo.slow).toBe(5);
  });

  it("scores tracks from stored preferences", () => {
    const preferences = applyPreferenceDelta(createEmptyPreferences(), track({ artist: "Hui", mood: "calm" }), 3);

    expect(scoreTrackByPreferences(track({ artist: "Hui", mood: "calm" }), preferences)).toBe(6);
    expect(scoreTrackByPreferences(track({ artist: "Other", mood: "calm" }), preferences)).toBe(3);
  });

  it("persists preferences through localStorage-compatible storage", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) || null,
      setItem: (key: string, value: string) => store.set(key, value)
    };
    const preferences = recordPreferenceEvent(createEmptyPreferences(), track({ artist: "Hui" }), "completed");

    savePreferences(preferences, storage);

    expect(loadPreferences(storage).artist.Hui).toBe(1);
  });

  it("prefers high scoring tracks while excluding the current track", () => {
    const current = track({ id: 1, artist: "Current" });
    const preferred = track({ id: 2, artist: "Hui", mood: "calm" });
    const other = track({ id: 3, artist: "Other" });
    const preferences = applyPreferenceDelta(createEmptyPreferences(), preferred, 5);

    expect(pickPreferenceWeightedTrack([current, preferred, other], current.id, preferences, () => 0)).toBe(preferred);
  });
});
