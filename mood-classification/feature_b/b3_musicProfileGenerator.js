/**
 * FEATURE B — B3: Music Profile Generation
 *
 * Receives MoodContext from B2.
 * Responsibilities:
 *   - Map mood + context → concrete music parameters
 *   - Determine BPM range, Timbre, Instruments
 *   - Set Reverb, Ambience, Style
 *   - Encode listening context (time of day, page type, complexity)
 *
 * Input:  MoodContext (from B2)
 * Output: MusicProfile (JSON) → passed to B4 + later to Feature D
 */

"use strict";

import { MUSIC_CATEGORY_MAP } from "./b2_moodClassifier.js";

// ─── Music parameter tables ───────────────────────────────────────────────────

/**
 * Per-mood base parameters.
 * All values are ranges or concrete values that B4 will interpolate
 * using the energyHint and valenceHint from B2.
 */
const MOOD_PARAMS = {
  calm: {
    bpmRange:    [55, 75],
    key:         ["C major", "G major", "F major", "D major"],
    timbre:      "warm, soft, rounded",
    instruments: ["acoustic guitar", "piano", "strings", "ambient pad", "light flute"],
    reverb:      0.6,
    ambience:    0.7,
    style:       "lo-fi ambient, acoustic chill",
    dynamics:    "very soft, gentle swells",
    tempo:       "adagio",
  },
  focused: {
    bpmRange:    [80, 100],
    key:         ["D minor", "A minor", "E minor", "C major"],
    timbre:      "clear, precise, minimal",
    instruments: ["piano", "minimalist synth", "light percussion", "bass drone"],
    reverb:      0.3,
    ambience:    0.4,
    style:       "lo-fi study, minimal electronic, deep focus",
    dynamics:    "steady pulse, no sudden peaks",
    tempo:       "andante moderato",
  },
  joyful: {
    bpmRange:    [110, 130],
    key:         ["G major", "D major", "A major", "E major"],
    timbre:      "bright, punchy, sparkling",
    instruments: ["acoustic guitar", "upright bass", "brass", "xylophone", "percussion"],
    reverb:      0.3,
    ambience:    0.3,
    style:       "indie pop, acoustic upbeat, jazz swing",
    dynamics:    "lively, bouncy",
    tempo:       "allegro",
  },
  energetic: {
    bpmRange:    [130, 160],
    key:         ["E minor", "A minor", "B minor"],
    timbre:      "distorted, driven, punchy",
    instruments: ["electric guitar", "bass", "drums", "synth lead", "brass stabs"],
    reverb:      0.2,
    ambience:    0.2,
    style:       "electronic, hip-hop beat, rock, EDM",
    dynamics:    "high energy, driving",
    tempo:       "presto",
  },
  sad: {
    bpmRange:    [45, 65],
    key:         ["D minor", "A minor", "E minor", "B minor"],
    timbre:      "breathy, melancholic, thin",
    instruments: ["solo piano", "cello", "violin", "ambient pad", "soft acoustic"],
    reverb:      0.75,
    ambience:    0.8,
    style:       "cinematic sad, neo-classical, lo-fi melancholy",
    dynamics:    "sparse, fragile, gentle crescendos",
    tempo:       "largo",
  },
  dark: {
    bpmRange:    [60, 90],
    key:         ["D minor", "C minor", "G minor"],
    timbre:      "dark, heavy, dense",
    instruments: ["orchestral strings", "bass brass", "timpani", "dark synth", "choir drones"],
    reverb:      0.8,
    ambience:    0.7,
    style:       "cinematic dark, thriller score, orchestral tension",
    dynamics:    "tense builds, dramatic swells",
    tempo:       "moderato sinistro",
  },
  nostalgic: {
    bpmRange:    [70, 95],
    key:         ["C major", "F major", "G major", "A minor"],
    timbre:      "warm, vintage, tape-saturated",
    instruments: ["piano", "acoustic guitar", "vintage synth", "vibraphone", "light strings"],
    reverb:      0.5,
    ambience:    0.6,
    style:       "lo-fi retro, vintage jazz, 80s synth-ambient",
    dynamics:    "warm swells, dreamy",
    tempo:       "andante",
  },
  curious: {
    bpmRange:    [85, 110],
    key:         ["E minor", "B minor", "A minor"],
    timbre:      "ethereal, textured, sparkling",
    instruments: ["marimba", "pizzicato strings", "electronic bells", "piano", "light synth arpeggios"],
    reverb:      0.55,
    ambience:    0.6,
    style:       "world-ambient, minimalist wonder, documentary score",
    dynamics:    "playful movement, evolving textures",
    tempo:       "andante mosso",
  },
  tense: {
    bpmRange:    [90, 130],
    key:         ["B minor", "E minor", "C minor"],
    timbre:      "staccato, percussive, urgent",
    instruments: ["strings tremolo", "percussion", "brass stabs", "pulse synth", "snare rolls"],
    reverb:      0.4,
    ambience:    0.3,
    style:       "thriller score, news tension, action underscore",
    dynamics:    "urgent, escalating",
    tempo:       "allegro agitato",
  },
  uplifting: {
    bpmRange:    [85, 110],
    key:         ["C major", "G major", "D major", "F major"],
    timbre:      "open, radiant, expansive",
    instruments: ["piano", "choir", "strings", "acoustic guitar", "gentle synth pads"],
    reverb:      0.6,
    ambience:    0.65,
    style:       "uplifting cinematic, spiritual ambient, inspirational",
    dynamics:    "gentle rises, warm resolution",
    tempo:       "moderato con grazia",
  },
  neutral: {
    bpmRange:    [70, 90],
    key:         ["C major", "G major"],
    timbre:      "balanced, unobtrusive",
    instruments: ["ambient pad", "light piano", "soft bass"],
    reverb:      0.5,
    ambience:    0.5,
    style:       "neutral ambient, background music",
    dynamics:    "flat, unobtrusive",
    tempo:       "andante",
  },
};

// ─── Page-type modifier (fine-tunes BPM and energy) ──────────────────────────
const PAGE_TYPE_MODIFIERS = {
  article:       { bpmDelta:  0,   energyScale: 0.9  },
  social:        { bpmDelta: +8,   energyScale: 1.1  },
  video:         { bpmDelta:  0,   energyScale: 1.0  },
  shopping:      { bpmDelta: +5,   energyScale: 1.0  },
  news:          { bpmDelta: +5,   energyScale: 1.05 },
  "work-tool":   { bpmDelta: -5,   energyScale: 0.85 },
  entertainment: { bpmDelta: +10,  energyScale: 1.15 },
  educational:   { bpmDelta: -8,   energyScale: 0.8  },
  other:         { bpmDelta:  0,   energyScale: 1.0  },
};

// ─── Time-of-day context ─────────────────────────────────────────────────────
// `hour` is injectable so callers (and tests) can pin a specific time bracket
// instead of depending on the wall clock at call time.
export function getTimeOfDayContext(hour = new Date().getHours()) {
  if (hour >= 5  && hour < 9)  return { label: "morning",   energyAdjust: +0.05, bpmAdjust: +3  };
  if (hour >= 9  && hour < 12) return { label: "mid-morning", energyAdjust: +0.1, bpmAdjust: +5  };
  if (hour >= 12 && hour < 14) return { label: "afternoon", energyAdjust:  0,    bpmAdjust:  0  };
  if (hour >= 14 && hour < 17) return { label: "late-afternoon", energyAdjust: -0.05, bpmAdjust: -3 };
  if (hour >= 17 && hour < 20) return { label: "evening",   energyAdjust: -0.1, bpmAdjust: -5  };
  if (hour >= 20 && hour < 23) return { label: "night",     energyAdjust: -0.2, bpmAdjust: -10 };
  return                              { label: "late-night", energyAdjust: -0.3, bpmAdjust: -15 };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function pickKey(keys, valenceHint = 0) {
  // More positive valence → pick earlier (usually major) keys in the list
  const idx = valenceHint > 0
    ? 0
    : Math.min(Math.floor((keys.length - 1) * (1 - (valenceHint + 1) / 2)), keys.length - 1);
  return keys[Math.max(0, idx)] ?? keys[0];
}

function interpolateBPM(range, energyHint, modifier = 0, timeAdjust = 0) {
  const [lo, hi] = range;
  const raw = lo + (hi - lo) * energyHint + modifier + timeAdjust;
  return Math.round(Math.min(hi + 20, Math.max(lo - 20, raw)));
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * runB3 — generates a full MusicProfile from the MoodContext produced by B2.
 *
 * @param {Object} moodContext  Output of B2.runB2()
 * @param {number} [moodContext.hour]  Optional 0-23 hour override, forwarded to
 *   getTimeOfDayContext() — that function already supported injecting an hour
 *   for deterministic testing, but runB3 never passed one through, so any
 *   caller (production or test) was always pinned to the real wall clock with
 *   no way to reach that injectability. Omit to use the real current hour.
 * @returns {Object}            MusicProfile — input to B4 and Feature D
 */
export function runB3(moodContext) {
  const {
    mood       = "neutral",
    pageType   = "other",
    energyHint = 0.5,
    valenceHint = 0,
    scrollSpeed = 0,
    cursorSpeed = 0,
    colors      = {},
    category    = {},
    hour,
  } = moodContext;

  const base       = MOOD_PARAMS[mood] ?? MOOD_PARAMS.neutral;
  const pageModifier = PAGE_TYPE_MODIFIERS[pageType] ?? PAGE_TYPE_MODIFIERS.other;
  const timeCtx    = getTimeOfDayContext(hour);

  // ── BPM ────────────────────────────────────────────────────────────────────
  const bpm = interpolateBPM(
    base.bpmRange,
    energyHint * pageModifier.energyScale,
    pageModifier.bpmDelta,
    timeCtx.bpmAdjust,
  );

  // ── Energy (final, clamped) ────────────────────────────────────────────────
  const energy = Math.max(0, Math.min(1, energyHint * pageModifier.energyScale + timeCtx.energyAdjust));

  // ── Key selection ─────────────────────────────────────────────────────────
  const key = pickKey(base.key, valenceHint);

  // ── Reverb / Ambience — scale slightly with colours (dark pages → more reverb) ──
  const darknessBoost = colors.lightness != null ? Math.max(0, (0.5 - colors.lightness) * 0.2) : 0;
  const reverb        = Math.min(1, base.reverb  + darknessBoost);
  const ambience      = Math.min(1, base.ambience + darknessBoost * 0.5);

  // ── Intensity — combines energy with scroll speed ─────────────────────────
  const scrollNorm = Math.min(1, (scrollSpeed || 0) / 1000);
  const intensity  = parseFloat(Math.min(1, energy * 0.7 + scrollNorm * 0.3).toFixed(3));

  // ── Music category label (from spec) ─────────────────────────────────────
  const musicCategory = MUSIC_CATEGORY_MAP[mood] ?? "Chill Out / Lounge / Calm / Relaxing";

  return {
    // Core classification
    mood,
    musicCategory,
    pageType,
    contentCategory: category.primary ?? "Entertainment",
    listeningContext: `${timeCtx.label} ${pageType} session`,

    // Audio parameters
    bpm,
    key,
    timbre:      base.timbre,
    instruments: base.instruments,
    style:       base.style,
    dynamics:    base.dynamics,
    tempo:       base.tempo,
    reverb:      parseFloat(reverb.toFixed(3)),
    ambience:    parseFloat(ambience.toFixed(3)),

    // Expressive values
    energy:    parseFloat(energy.toFixed(3)),
    intensity,
    valence:   valenceHint,

    // Context metadata
    timeOfDay: timeCtx.label,
    sensitiveOverride: moodContext.sensitiveOverride ?? false,
    generatedAt: Date.now(),
  };
}
