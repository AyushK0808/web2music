/**
 * liveSites.js — the real, public web pages livePlayback.e2e.mjs browses.
 *
 * The synthetic corpus in moodSites.js exists to pin down *which* mood Feature
 * B picks: every page there is written so tier-1 keyword scoring can only land
 * on one answer. These pages are the opposite — ordinary pages nobody wrote for
 * us, used to check that the whole extension survives contact with the real
 * web: real markup, real stylesheets, real Readability output, real HTTPS
 * origins, and real audio coming out the other end.
 *
 * So the live harness asserts *structure*, not vocabulary: that a mood was
 * committed at all, that Feature D was handed that same mood, that the offscreen
 * document decoded and started the clip, and that the analyser at the end of the
 * audio graph sees signal. `observedMood` below is recorded diagnostically, not
 * asserted — Wikipedia is free to edit its prose without breaking this suite.
 * The one exception is `sensitive`, where "silence" is the whole point of the
 * page being in the list.
 *
 * Why these particular pages:
 *   - all are stable, high-traffic, text-heavy, and cheap to fetch (a handful
 *     of page views per run);
 *   - `calm` and `energetic` are far apart in vocabulary, so the mood-change
 *     phase gets a genuine transition rather than a coin flip;
 *   - `curious` is deliberately not Wikipedia — a different DOM shape, so the
 *     suite isn't quietly a test of one site's markup;
 *   - `sensitive` is an encyclopaedia article *about* suicide prevention rather
 *     than an actual crisis line, so the safety path gets exercised without
 *     pointing automated traffic at a support service.
 */

export const LIVE_SITES = {
  calm: {
    url: "https://en.wikipedia.org/wiki/Ambient_music",
    label: "Wikipedia — Ambient music",
    observedMood: "calm", // tier-1, confidence 0.73 (2026-08-03)
  },

  energetic: {
    url: "https://en.wikipedia.org/wiki/High-intensity_interval_training",
    label: "Wikipedia — High-intensity interval training",
    observedMood: "energetic", // tier-1, confidence 0.95 (2026-08-03)
  },

  curious: {
    url: "https://news.ycombinator.com/",
    label: "Hacker News front page",
    observedMood: "curious", // tier-1, confidence 0.67 (2026-08-03)
  },

  sensitive: {
    url: "https://en.wikipedia.org/wiki/Suicide_prevention",
    label: "Wikipedia — Suicide prevention",
    // Asserted, not just observed: B1's sensitive detector must fire here and
    // Feature D must never be called for this page.
    expectSilence: true,
  },

  /**
   * A real media site, used only for its URL: background.js's isMediaTab()
   * matches on "youtube.com", so opening this tab is what makes the production
   * ducking path fire. Nothing is played on it — the assertion is that the
   * extension's own music drops ~20 dB while it is in front.
   */
  media: {
    url: "https://www.youtube.com/",
    label: "YouTube home",
  },
};
