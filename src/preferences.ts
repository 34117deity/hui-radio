import type { Track } from "./types.js";

export type PreferenceBucket = "artist" | "language" | "genre" | "mood" | "scene" | "tempo";
export type PreferenceEvent = "completed" | "favorite" | "repeat" | "skipped";
export type PreferenceTrack = Partial<Record<PreferenceBucket, string | undefined>>;
export type PreferenceWeights = Record<string, number>;
export type Preferences = Record<PreferenceBucket, PreferenceWeights>;

export const PREFERENCES_STORAGE_KEY = "hui-radio-preferences-v1";

export const PREFERENCE_EVENT_DELTAS: Record<PreferenceEvent, number> = {
  completed: 1,
  favorite: 5,
  repeat: 3,
  skipped: -3
};

const preferenceBuckets: PreferenceBucket[] = ["artist", "language", "genre", "mood", "scene", "tempo"];

export function createEmptyPreferences(): Preferences {
  return {
    artist: {},
    language: {},
    genre: {},
    mood: {},
    scene: {},
    tempo: {}
  };
}

function normalizeTag(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function tagValues(track: PreferenceTrack, bucket: PreferenceBucket) {
  const value = track[bucket];
  if (!value) return [];
  return String(value)
    .split(/[\/,，、|]+/u)
    .map(normalizeTag)
    .filter(Boolean);
}

function sanitizePreferences(input: unknown): Preferences {
  const next = createEmptyPreferences();
  if (!input || typeof input !== "object") return next;
  const record = input as Partial<Record<PreferenceBucket, unknown>>;
  preferenceBuckets.forEach((bucket) => {
    const weights = record[bucket];
    if (!weights || typeof weights !== "object") return;
    Object.entries(weights as Record<string, unknown>).forEach(([key, value]) => {
      const normalizedKey = normalizeTag(key);
      const numericValue = Number(value);
      if (normalizedKey && Number.isFinite(numericValue) && numericValue !== 0) {
        next[bucket][normalizedKey] = numericValue;
      }
    });
  });
  return next;
}

export function loadPreferences(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): Preferences {
  if (!storage) return createEmptyPreferences();
  try {
    const raw = storage.getItem(PREFERENCES_STORAGE_KEY);
    return raw ? sanitizePreferences(JSON.parse(raw)) : createEmptyPreferences();
  } catch {
    return createEmptyPreferences();
  }
}

export function savePreferences(preferences: Preferences, storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage) {
  if (!storage) return;
  storage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(sanitizePreferences(preferences)));
}

export function applyPreferenceDelta(preferences: Preferences, track: PreferenceTrack, delta: number): Preferences {
  if (!Number.isFinite(delta) || delta === 0) return preferences;
  const next = sanitizePreferences(preferences);
  preferenceBuckets.forEach((bucket) => {
    tagValues(track, bucket).forEach((tag) => {
      const weight = (next[bucket][tag] || 0) + delta;
      if (weight === 0) delete next[bucket][tag];
      else next[bucket][tag] = weight;
    });
  });
  return next;
}

export function recordPreferenceEvent(preferences: Preferences, track: PreferenceTrack, event: PreferenceEvent): Preferences {
  return applyPreferenceDelta(preferences, track, PREFERENCE_EVENT_DELTAS[event]);
}

export function scoreTrackByPreferences(track: PreferenceTrack, preferences: Preferences) {
  const safePreferences = sanitizePreferences(preferences);
  return preferenceBuckets.reduce((score, bucket) => {
    return score + tagValues(track, bucket).reduce((bucketScore, tag) => bucketScore + (safePreferences[bucket][tag] || 0), 0);
  }, 0);
}

export function pickPreferenceWeightedTrack(
  tracks: Track[],
  currentTrackId: number | null,
  preferences: Preferences,
  random: () => number = Math.random
) {
  const candidates = tracks.filter((track) => tracks.length === 1 || track.id !== currentTrackId);
  if (!candidates.length) return undefined;

  const ranked = candidates
    .map((track) => ({
      track,
      score: scoreTrackByPreferences(track, preferences),
      jitteredScore: scoreTrackByPreferences(track, preferences) + random() * 3
    }))
    .sort((a, b) => b.jitteredScore - a.jitteredScore);

  const pool = ranked.slice(0, Math.min(5, ranked.length));
  const minScore = Math.min(...pool.map((item) => item.score));
  const weightedPool = pool.map((item) => ({ ...item, weight: Math.max(1, item.score - minScore + 1) }));
  const totalWeight = weightedPool.reduce((total, item) => total + item.weight, 0);
  let cursor = random() * totalWeight;
  for (const item of weightedPool) {
    cursor -= item.weight;
    if (cursor <= 0) return item.track;
  }
  return weightedPool[0]?.track;
}
