/*
 * Readability.js — Flesch Reading Ease scoring for Feature A.
 *
 * Dense academic prose vs. a light blog post is a real mood signal. Feature A
 * is the natural owner of this computation (it already has the cleaned body
 * text in hand), so buildPageData() can stamp it into Handoff 1.
 *
 * NOTE (P3 / optional enrichment): Feature B's Handoff-1 schema does not yet
 * declare a `flesch` field — B computes its own `readingComplexity` internally.
 * We emit `flesch` (raw 0–100 score) AND `readingComplexity` (inverted 0–1,
 * higher = harder) using the *same* formula and normalisation as B1's
 * computeReadingComplexity(), so that if/when B chooses to consume A's value it
 * is already numerically compatible. Until then B simply ignores the extra
 * field — it is additive and safe.
 */

/**
 * Naive English syllable counter (matches Feature B1's approximation so the
 * two sides can't disagree on the score).
 */
function countSyllables(word) {
  word = word.toLowerCase().replace(/[^a-z]/g, '');
  if (word.length <= 3) return word.length ? 1 : 0;
  word = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '');
  const match = word.match(/[aeiouy]{1,2}/g);
  return match ? match.length : 1;
}

/**
 * fleschReadingEase — raw Flesch Reading Ease score.
 *   206.835 − 1.015·(words/sentence) − 84.6·(syllables/word)
 * Higher = easier to read. Clamped to [0, 100]. Empty text → 50 (neutral).
 * @param {string} text
 * @returns {number}
 */
function fleschReadingEase(text) {
  if (!text || !text.trim()) return 50;

  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  const words = text.match(/\b\w+\b/g) || [];
  if (words.length === 0) return 50;

  const totalSyllables = words.reduce((sum, w) => sum + countSyllables(w), 0);
  const wordsPerSentence = words.length / Math.max(sentences.length, 1);
  const syllablesPerWord = totalSyllables / words.length;

  const score = 206.835 - 1.015 * wordsPerSentence - 84.6 * syllablesPerWord;
  return parseFloat(Math.min(100, Math.max(0, score)).toFixed(1));
}

/**
 * readingComplexity — Flesch inverted & normalised to [0..1], higher = harder.
 * Identical mapping to Feature B1's computeReadingComplexity().
 * @param {string} text
 * @returns {number}
 */
function readingComplexity(text) {
  const flesch = fleschReadingEase(text);
  return parseFloat(((100 - flesch) / 100).toFixed(3));
}

/**
 * scoreReadability — convenience returning both representations at once.
 * @param {string} text
 * @returns {{ flesch: number, readingComplexity: number }}
 */
function scoreReadability(text) {
  const flesch = fleschReadingEase(text);
  return {
    flesch,
    readingComplexity: parseFloat(((100 - flesch) / 100).toFixed(3)),
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { fleschReadingEase, readingComplexity, scoreReadability };
} else if (typeof window !== 'undefined') {
  window.Web2MusicReadability = { fleschReadingEase, readingComplexity, scoreReadability };
}
