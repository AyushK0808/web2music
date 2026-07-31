/*
 * syllableCounter.js — the single shared English syllable heuristic.
 *
 * Feature A (data-extraction/Readability.js) and Feature B1
 * (mood-classification/feature_b/b1_contentUnderstanding.js) both need to
 * count syllables, and both document their Flesch scores as "numerically
 * compatible" with each other. They previously kept private copies of the
 * heuristic and drifted apart on degenerate input, which is exactly the bug
 * this module exists to make impossible.
 *
 * The implementation below is the canonical one — byte-for-byte the algorithm
 * B1's computeReadingComplexity() has always used. It is reproduced here
 * rather than replaced so that adopting the shared module changes *no*
 * existing score: any other heuristic, however defensible in isolation, would
 * silently move every `flesch` / `readingComplexity` value in Handoff 1.
 *
 * Note the `word.length <= 3` branch returns 1 even for the empty string.
 * That is deliberate and load-bearing for A/B agreement — do not "fix" it to
 * return 0 without changing B1 in the same commit.
 */

/**
 * countSyllables — naive English syllable approximation.
 * @param {string} word single word; non-letters are stripped
 * @returns {number} syllable count, always >= 1 for defined input
 */
function countSyllables(word) {
  if (typeof word !== 'string') return 1;
  word = word.toLowerCase().replace(/[^a-z]/g, '');
  if (word.length <= 3) return 1;
  word = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '');
  const match = word.match(/[aeiouy]{1,2}/g);
  return match ? match.length : 1;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { countSyllables };
} else if (typeof window !== 'undefined') {
  window.Web2MusicSyllableCounter = { countSyllables };
}
