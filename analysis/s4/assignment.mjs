/**
 * C-13 (core) — condition assignment for the S4 controlled study.
 *
 * Pure functions, no I/O, so the part of the study that decides what each
 * participant experiences can be tested rather than trusted. Every threat
 * mitigation the plan's §10 states as prose is implemented here as code:
 *
 *  - **Latin square** over the four conditions, so order and fatigue effects
 *    are balanced rather than hoped away.
 *  - **The SHUFFLED draw is forced ≥2 steps away in valence–arousal space**,
 *    and near-misses are counted. Without the constraint a shuffled `calm` can
 *    land on a calm page, the condition accidentally becomes ADAPTIVE, and the
 *    contrast C1 rests on is diluted by an amount nobody measured.
 *  - **Conditions are never named to the participant.** `displayName` returns
 *    "Setting A".."Setting D", assigned per participant, because a participant
 *    who can tell which one is "the system" gives you demand characteristics
 *    instead of preferences.
 *  - **A generation nonce per (participant, page)**, so a cache hit cannot
 *    replay one participant's clip to the next and quietly turn a
 *    between-participant comparison into a within-clip one.
 */

/** Valence per mood — the same table b2_moodClassifier.computeValenceHint uses. */
export const VALENCE = {
  calm: 0.5, focused: 0.4, joyful: 0.9, energetic: 0.8, sad: -0.7,
  dark: -0.8, nostalgic: 0.2, curious: 0.5, tense: -0.5, uplifting: 0.9, neutral: 0.0,
};

/**
 * Arousal per mood. Feature B derives energy from page signals rather than
 * from the mood name, so there is no shipped table to mirror; these are the
 * canonical positions of the eleven moods on the arousal axis and they exist
 * *only* to define the shuffle-distance constraint. They never reach the
 * generator.
 */
export const AROUSAL = {
  calm: 0.15, focused: 0.35, joyful: 0.75, energetic: 0.95, sad: 0.20,
  dark: 0.40, nostalgic: 0.30, curious: 0.55, tense: 0.80, uplifting: 0.65, neutral: 0.50,
};

export const MOODS = Object.keys(VALENCE);
export const CONDITIONS = ["SILENCE", "PLAYLIST", "SHUFFLED", "ADAPTIVE"];

/**
 * Distance in valence–arousal space, with valence rescaled to [0,1] first so
 * the two axes contribute comparably. Valence is natively [-1,1] and arousal
 * [0,1]; without the rescale, valence would dominate the metric by 2x and
 * "two steps away" would mean "two steps away in valence".
 */
export function vaDistance(moodA, moodB) {
  const va = (m) => [((VALENCE[m] ?? 0) + 1) / 2, AROUSAL[m] ?? 0.5];
  const [x1, y1] = va(moodA);
  const [x2, y2] = va(moodB);
  return Math.hypot(x1 - x2, y1 - y2);
}

/**
 * The plan says "at least 2 steps away in valence–arousal space". A "step" is
 * not defined there, so it is defined here and stated in the paper: one step
 * is the median nearest-neighbour distance among the eleven moods, i.e. how
 * far apart two adjacent moods typically are. Two steps is twice that.
 */
export function stepSize(moods = MOODS) {
  const nearest = moods.map((m) => Math.min(
    ...moods.filter((o) => o !== m).map((o) => vaDistance(m, o)),
  ));
  const sorted = nearest.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export const MIN_SHUFFLE_DISTANCE = () => 2 * stepSize();

/** Deterministic RNG, so a participant's assignment is reproducible from their id. */
export function rngFor(seedStr) {
  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i++) { h ^= seedStr.charCodeAt(i); h = Math.imul(h, 16777619); }
  let a = h >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Balanced Latin square row for a participant.
 *
 * Uses the Williams construction rather than a plain cyclic square: a cyclic
 * square balances position but not *immediate sequence*, so condition B would
 * follow condition A in every single participant and any carry-over effect
 * would be perfectly confounded with the condition. Williams balances first-
 * order carry-over too, which is the whole reason to counterbalance a 4-level
 * within-subjects design.
 */
export function williamsSquare(n = CONDITIONS.length) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const row = [];
    for (let j = 0; j < n; j++) {
      const k = j % 2 === 0 ? j / 2 : n - (j + 1) / 2;
      row.push((i + k) % n);
    }
    rows.push(row);
  }
  // For even n the Williams square is complete as constructed; for odd n it
  // needs its mirror appended. Guarding both keeps this correct if a fifth
  // condition is ever added rather than silently degrading.
  if (n % 2 === 1) rows.push(...rows.map((r) => r.slice().reverse()));
  return rows;
}

export function conditionOrder(participantIndex) {
  const square = williamsSquare(CONDITIONS.length);
  return square[participantIndex % square.length].map((i) => CONDITIONS[i]);
}

/**
 * Draw a mood for the SHUFFLED condition: far from the page's true mood, and
 * flagged when the constraint could not be satisfied.
 *
 * Returns the draw plus its distance, because the *rate* at which draws land
 * near the true mood is a number §10 asks to report, and it can only be
 * reported if every draw records its distance rather than only the failures.
 */
export function drawShuffledMood(trueMood, rand, { minDistance = null, moods = MOODS } = {}) {
  const min = minDistance ?? MIN_SHUFFLE_DISTANCE();
  const eligible = moods.filter((m) => m !== trueMood && vaDistance(m, trueMood) >= min);

  if (eligible.length === 0) {
    // Some moods have few distant neighbours. Falling back to "the furthest
    // available" is better than failing the trial, but it is a near-miss by
    // definition and must be counted as one — silently relaxing the constraint
    // is how a diluted contrast becomes invisible.
    const ranked = moods.filter((m) => m !== trueMood)
      .sort((a, b) => vaDistance(b, trueMood) - vaDistance(a, trueMood));
    const pick = ranked[0];
    return { mood: pick, distance: vaDistance(pick, trueMood), nearMiss: true,
             reason: "no mood met the minimum distance; used the furthest available" };
  }

  const pick = eligible[Math.floor(rand() * eligible.length)];
  return { mood: pick, distance: vaDistance(pick, trueMood), nearMiss: false, reason: null };
}

/**
 * Build one participant's full session.
 *
 * @param {Object} p
 * @param {string} p.participantId
 * @param {number} p.participantIndex  position in the recruitment order
 * @param {Array}  p.pages             [{ id, url, trueMood, comprehension: [...] }]
 */
export function buildSession({ participantId, participantIndex, pages, pagesPerBlock = 8 }) {
  const rand = rngFor(participantId);
  const order = conditionOrder(participantIndex);

  // Participant-specific labels, so "Setting A" is not the same condition for
  // two participants who talk to each other afterwards.
  const labels = ["Setting A", "Setting B", "Setting C", "Setting D"];
  const displayName = Object.fromEntries(order.map((c, i) => [c, labels[i]]));

  const blocks = order.map((condition, blockIndex) => {
    // Page order is reshuffled per block so that page and block position are
    // not confounded; the same 8 pages appear in every block by design (the
    // comparison is within page).
    const blockPages = pages.slice(0, pagesPerBlock)
      .map((pg) => ({ pg, k: rand() }))
      .sort((a, b) => a.k - b.k)
      .map(({ pg }) => {
        const trial = {
          pageId: pg.id,
          url: pg.url,
          trueMood: pg.trueMood,
          condition,
          // Forcing a nonce means every trial generates fresh audio. It costs
          // latency, and §10 says to note that cost: without it a cache hit
          // replays an earlier participant's clip and the "same condition"
          // stops meaning the same thing.
          nonce: `s4-${participantId}-${pg.id}-${condition}`,
        };
        if (condition === "SHUFFLED") {
          const draw = drawShuffledMood(pg.trueMood, rand);
          trial.playedMood = draw.mood;
          trial.shuffleDistance = draw.distance;
          trial.shuffleNearMiss = draw.nearMiss;
          trial.shuffleFallbackReason = draw.reason;
        } else if (condition === "ADAPTIVE") {
          trial.playedMood = pg.trueMood;
        } else if (condition === "PLAYLIST") {
          trial.playedMood = null;   // one fixed loop, identical on every page
        } else {
          trial.playedMood = null;   // SILENCE
        }
        return trial;
      });
    return { blockIndex, condition, displayName: displayName[condition], trials: blockPages };
  });

  const shuffled = blocks.find((b) => b.condition === "SHUFFLED");
  const nearMisses = shuffled ? shuffled.trials.filter((t) => t.shuffleNearMiss).length : 0;

  return {
    participantId,
    participantIndex,
    conditionOrder: order,
    displayName,
    blocks,
    diagnostics: {
      min_shuffle_distance: MIN_SHUFFLE_DISTANCE(),
      step_size: stepSize(),
      shuffle_near_misses: nearMisses,
      shuffle_near_miss_rate: shuffled ? nearMisses / shuffled.trials.length : null,
      mean_shuffle_distance: shuffled
        ? shuffled.trials.reduce((a, t) => a + t.shuffleDistance, 0) / shuffled.trials.length
        : null,
    },
  };
}

/** Aggregate the near-miss rate across a whole recruitment — the §10 number. */
export function shuffleNearMissRate(sessions) {
  let near = 0, total = 0;
  const distances = [];
  for (const s of sessions) {
    for (const b of s.blocks) {
      if (b.condition !== "SHUFFLED") continue;
      for (const t of b.trials) {
        total++;
        if (t.shuffleNearMiss) near++;
        distances.push(t.shuffleDistance);
      }
    }
  }
  distances.sort((a, b) => a - b);
  return {
    n_trials: total,
    near_miss_rate: total ? near / total : null,
    min_distance: distances[0] ?? null,
    median_distance: distances[Math.floor(distances.length / 2)] ?? null,
  };
}
