/**
 * FEATURE B — B4: Prompt Engineering
 *
 * Receives MusicProfile from B3.
 * Responsibilities:
 *   - Convert MusicProfile → rich natural-language audio prompt
 *   - Add style, atmosphere, and genre guidance
 *   - Optimise prompt for audio LLM (MusicGen / Stable Audio / AudioCraft)
 *   - Produce the final Handoff 2 payload sent to Feature D
 *
 * Input:  MusicProfile (from B3)
 * Output: { musicProfile, prompt } (JSON) → Feature D
 */

"use strict";

// ─── Model-specific prompt formats ───────────────────────────────────────────

/**
 * MusicGen / AudioCraft prompt format.
 * These models respond best to comma-separated descriptors, ~60-120 words.
 * https://huggingface.co/facebook/musicgen-large
 */
function buildMusicGenPrompt(profile) {
  const {
    style, timbre, instruments, dynamics, key, bpm, reverb, ambience,
    mood, energy, listeningContext,
  } = profile;

  const reverbDesc  = reverb  > 0.6 ? "lush reverb, spacious hall"
                    : reverb  > 0.35 ? "moderate room reverb"
                    : "dry, close-mic sound";
  const energyDesc  = energy  > 0.7  ? "high energy, driving"
                    : energy  > 0.4  ? "moderate energy, steady flow"
                    : "low energy, gentle";
  const ambienceDesc = ambience > 0.6 ? "atmospheric, layered textures"
                     : ambience > 0.3  ? "subtle background warmth"
                     : "clean, minimal";

  return [
    `${style}.`,
    `Instruments: ${instruments.slice(0, 4).join(", ")}.`,
    `${timbre} timbre, ${dynamics}.`,
    `Key: ${key}, ${bpm} BPM.`,
    `${energyDesc}, ${reverbDesc}, ${ambienceDesc}.`,
    `Mood: ${mood}.`,
    `Context: ${listeningContext}.`,
    `No vocals. Seamlessly loopable. Instrumental only.`,
  ].join(" ");
}

/**
 * Stable Audio prompt format.
 * Stable Audio prefers structured "category, descriptors, negative" format.
 */
function buildStableAudioPrompt(profile) {
  const { style, timbre, instruments, bpm, key, mood, energy, reverb } = profile;

  const positivePrompt = [
    style,
    `${timbre} sound`,
    instruments.slice(0, 3).join(", "),
    `${bpm} BPM`,
    key,
    mood,
    reverb > 0.5 ? "reverberant" : "dry",
    "no vocals",
    "loopable",
    "instrumental",
    energy > 0.6 ? "energetic" : energy > 0.3 ? "moderate" : "calm and quiet",
  ].join(", ");

  const negativePrompt = "vocals, singing, lyrics, speech, noise, distortion, abrupt cuts, low quality";

  return { positive: positivePrompt, negative: negativePrompt };
}

/**
 * Generic LLM audio prompt — for APIs like Suno, Udio, or future models
 * that accept full sentences.
 */
function buildGenericAudioPrompt(profile) {
  const {
    style, timbre, instruments, dynamics, key, bpm, reverb,
    mood, energy, intensity, ambience, listeningContext,
    musicCategory, tempo, valence,
  } = profile;

  const valenceAdj = valence > 0.5 ? "bright and uplifting"
                   : valence > 0    ? "warm and pleasant"
                   : valence > -0.5 ? "slightly melancholic"
                   : "dark and heavy";

  return `Create a ${style} instrumental track with a ${timbre} sound.
Use ${instruments.slice(0, 4).join(", ")} as primary instruments.
The tempo is ${tempo} at ${bpm} BPM, in ${key}.
The piece should feel ${valenceAdj}, with ${dynamics} throughout.
Apply ${Math.round(reverb * 100)}% reverb and ${Math.round(ambience * 100)}% ambient layering.
Energy level: ${Math.round(energy * 100)}%. Intensity: ${Math.round(intensity * 100)}%.
Music category: ${musicCategory}.
Context: ${listeningContext}.
The track must be loopable, have no vocals or lyrics, and transition seamlessly at loop points.
Do not include any sudden volume jumps. Target duration: 60–90 seconds per loop.`;
}

// ─── Atmosphere enhancers ─────────────────────────────────────────────────────

const ATMOSPHERE_TAGS = {
  calm:      ["meditative", "zen", "peaceful", "unhurried"],
  focused:   ["concentration", "deep work", "cognitive clarity", "flow state"],
  joyful:    ["celebratory", "light-hearted", "playful", "sunny"],
  energetic: ["driving", "powerful", "motivational", "intense"],
  sad:       ["introspective", "tender", "bittersweet", "wistful"],
  dark:      ["ominous", "cinematic tension", "brooding", "mysterious shadow"],
  nostalgic: ["warm memories", "vintage warmth", "dreamy recall", "hazy afternoon"],
  curious:   ["exploratory", "wonder", "discovery", "open questions"],
  tense:     ["urgency", "anticipation", "suspense", "building pressure"],
  uplifting: ["hope", "renewal", "spiritual warmth", "transcendent"],
  neutral:   ["unobtrusive", "background", "balanced"],
};

export function selectAtmosphereTags(mood, count = 2) {
  const tags = ATMOSPHERE_TAGS[mood] ?? ATMOSPHERE_TAGS.neutral;
  // Shuffle slightly and take `count`
  return tags.slice(0, count).join(", ");
}

// ─── Prompt validation ────────────────────────────────────────────────────────

// The multi-sentence "generic" template (with its closing loop/no-vocals
// instructions) legitimately runs up to ~675 chars across every mood/page-type
// combination — a 500 cap silently truncated that closing sentence on every
// single prompt. Cap raised with headroom, and truncation (on the rare
// profile that still exceeds it) now falls back to the last full sentence
// instead of cutting mid-word.
const MAX_PROMPT_LENGTH = 700;

export function validatePrompt(prompt) {
  if (typeof prompt === "string") {
    if (prompt.length < 20) throw new Error("Prompt too short");
    if (prompt.length > MAX_PROMPT_LENGTH) {
      const truncated     = prompt.slice(0, MAX_PROMPT_LENGTH);
      const lastSentenceEnd = truncated.lastIndexOf(". ");
      return lastSentenceEnd > MAX_PROMPT_LENGTH * 0.5
        ? truncated.slice(0, lastSentenceEnd + 1)
        : truncated.slice(0, MAX_PROMPT_LENGTH - 3) + "...";
    }
  }
  return prompt;
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * runB4 — Prompt Engineering orchestrator.
 * Builds all prompt variants and assembles the Handoff 2 payload.
 *
 * @param {Object} musicProfile   Output of B3.runB3()
 * @param {Object} options
 *   @param {string} options.targetModel  "musicgen" | "stable-audio" | "generic"
 *   @param {boolean} options.includeAll  If true, all prompt variants are included
 * @returns {Object} Handoff2Payload — the complete output of Feature B
 */
export function runB4(musicProfile, options = {}) {
  const { targetModel = "musicgen", includeAll = false } = options;

  const atmosphereTags = selectAtmosphereTags(musicProfile.mood);

  // Enrich profile with atmosphere before prompt generation
  const enrichedProfile = {
    ...musicProfile,
    atmosphereTags,
  };

  // ── Build all prompt variants ─────────────────────────────────────────────
  const musicgenPrompt     = buildMusicGenPrompt(enrichedProfile);
  const stableAudioPrompts = buildStableAudioPrompt(enrichedProfile);
  const genericPrompt      = buildGenericAudioPrompt(enrichedProfile);

  // Select primary prompt based on target model
  let primaryPrompt;
  if (targetModel === "musicgen") {
    primaryPrompt = validatePrompt(musicgenPrompt);
  } else if (targetModel === "stable-audio") {
    primaryPrompt = stableAudioPrompts; // Object with .positive / .negative
  } else {
    primaryPrompt = validatePrompt(genericPrompt);
  }

  // ── Assemble Handoff 2 payload ────────────────────────────────────────────
  const handoff2 = {
    // ── Core music profile (sent to Feature D) ──────────────────────────────
    musicProfile: {
      mood:            musicProfile.mood,
      musicCategory:   musicProfile.musicCategory,
      bpm:             musicProfile.bpm,
      key:             musicProfile.key,
      energy:          musicProfile.energy,
      intensity:       musicProfile.intensity,
      valence:         musicProfile.valence,
      reverb:          musicProfile.reverb,
      ambience:        musicProfile.ambience,
      timbre:          musicProfile.timbre,
      instruments:     musicProfile.instruments,
      style:           musicProfile.style,
      dynamics:        musicProfile.dynamics,
      tempo:           musicProfile.tempo,
      atmosphereTags,
      listeningContext: musicProfile.listeningContext,
      timeOfDay:        musicProfile.timeOfDay,
      sensitiveOverride: musicProfile.sensitiveOverride,
    },

    // ── Prompts ──────────────────────────────────────────────────────────────
    prompt: primaryPrompt,
    targetModel,

    // Optional: all variants (useful for A/B testing or fallback chains)
    ...(includeAll && {
      promptVariants: {
        musicgen:    musicgenPrompt,
        stableAudio: stableAudioPrompts,
        generic:     genericPrompt,
      },
    }),

    // ── Metadata ─────────────────────────────────────────────────────────────
    handoffVersion: "2.0",
    generatedAt:    musicProfile.generatedAt ?? Date.now(),
    contentCategory: musicProfile.contentCategory,
    pageType:        musicProfile.pageType,
  };

  return handoff2;
}

/**
 * buildFallbackPrompt — used when B2/B3 fail or LLM is offline (edge case #13).
 * Returns a safe, generic calm ambient prompt.
 * @param {string} timeOfDay
 * @returns {Object}
 */
export function buildFallbackPrompt(timeOfDay = "day") {
  const nightVariant = timeOfDay === "late-night" || timeOfDay === "night";

  return {
    musicProfile: {
      mood:          "calm",
      musicCategory: "Chill Out / Lounge / Calm / Relaxing",
      bpm:           70,
      key:           "C major",
      energy:        0.25,
      intensity:     0.2,
      valence:       0.4,
      reverb:        0.6,
      ambience:      0.7,
      timbre:        "warm, soft",
      instruments:   nightVariant ? ["ambient pad", "soft piano"] : ["acoustic guitar", "piano", "ambient pad"],
      style:         "calm ambient",
      dynamics:      "gentle, unobtrusive",
      tempo:         "adagio",
      atmosphereTags: "peaceful, meditative",
      listeningContext: `fallback calm ${timeOfDay}`,
      timeOfDay,
      sensitiveOverride: false,
    },
    prompt: nightVariant
      ? "Late night ambient music. Soft piano, minimal pads, very quiet. 65 BPM, C major. No vocals. Loopable."
      : "Calm acoustic ambient music. Acoustic guitar, soft piano, light ambient pads. 70 BPM, C major. No vocals. Loopable.",
    targetModel:    "musicgen",
    handoffVersion: "2.0",
    generatedAt:    Date.now(),
    isFallback:     true,
  };
}
