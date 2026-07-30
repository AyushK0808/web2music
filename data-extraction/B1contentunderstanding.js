// NOTE: this is a minimal stub — only the piece the review flagged for
// cross-file consistency (syllable counting). The rest of Feature B's B1
// (content understanding: keyword extraction, summarization, metadata
// analysis) already lives in mood-classification/feature_b/b1_contentUnderstanding.js
// and is NOT duplicated here.

// Module object rather than a destructured binding — see Readability.js for
// why (shared single-scope concatenation would redeclare `countSyllables`).
const syllableCounter = (typeof module !== 'undefined' && module.exports)
  ? require('./syllableCounter.js')
  : window.Web2MusicSyllableCounter;

/**
 * Feature A's Readability.js and Feature B1's computeReadingComplexity() both
 * used to carry private copies of the syllable heuristic and drifted apart on
 * degenerate input, despite both being documented as an "identical mapping".
 * Both now import ./syllableCounter.js, so the heuristic only has to change
 * in one place.
 *
 * That shared module preserves B1's long-standing behaviour of returning 1
 * (not 0) for an empty/degenerate word — see its header for why that branch
 * is load-bearing for A/B numerical agreement.
 */
function averageSyllablesPerWord(words) {
  if (!words || words.length === 0) return 0;
  const total = words.reduce(
    (sum, w) => sum + syllableCounter.countSyllables(w), 0);
  return total / words.length;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    averageSyllablesPerWord,
    countSyllables: syllableCounter.countSyllables,
  };
} else if (typeof window !== 'undefined') {
  window.Web2MusicB1ContentUnderstanding = { averageSyllablesPerWord };
}
