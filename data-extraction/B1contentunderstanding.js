// NOTE: this is a minimal stub — only the piece the review flagged for
// cross-file consistency (syllable counting). The rest of Feature B's B1
// (content understanding: keyword extraction, summarization, metadata
// analysis) is out of scope here and should be built separately.

const { countSyllables } = (typeof module !== 'undefined' && module.exports)
  ? require('../data-extraction/syllableCounter')
  : window.Web2MusicSyllableCounter;

/**
 * Previously this file had its own local syllable-counting logic that
 * returned 1 for an empty word, while Feature A's Readability.js returned
 * 0 for the same input — despite both being documented as "identical
 * mapping." Both now import the same shared implementation, so an empty
 * word returns 0 in both places, and any future change to the syllable
 * heuristic only has to happen once.
 */
function averageSyllablesPerWord(words) {
  if (!words || words.length === 0) return 0;
  const total = words.reduce((sum, w) => sum + countSyllables(w), 0);
  return total / words.length;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { averageSyllablesPerWord, countSyllables };
} else if (typeof window !== 'undefined') {
  window.Web2MusicB1ContentUnderstanding = { averageSyllablesPerWord };
}