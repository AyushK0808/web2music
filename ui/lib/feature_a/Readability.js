(function () {
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
 *
 * The syllable heuristic now lives in ./syllableCounter.js so that this file
 * and Feature B1 cannot drift apart again (see that file's header).
 */

// Bound as a module object rather than destructured: these files are also
// concatenated into a single content-script scope (see globals_test.js), where
// a top-level `const { countSyllables }` here would collide with
// syllableCounter.js's own `function countSyllables` declaration.
const syllableCounter = (typeof module !== 'undefined' && module.exports)
  ? require('./syllableCounter.js')
  : window.Web2MusicSyllableCounter;

/**
 * countSentences — sentence segmentation used by the Flesch denominator.
 * Falls back to "one sentence" for non-empty text with no terminal
 * punctuation, so a headline or a single unpunctuated paragraph still scores.
 * @param {string} text
 * @returns {number}
 */
function countSentences(text) {
  const sentences = text.match(/[^.!?]+[.!?]+/g);
  if (sentences && sentences.length) return sentences.length;
  return text.trim().length ? 1 : 0;
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

  const totalSyllables = words.reduce(
    (sum, w) => sum + syllableCounter.countSyllables(w), 0);
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
 * Flesch Reading Ease is an English-specific formula (syllable/sentence
 * heuristics tuned to English prose); scoring non-English text with it
 * produces a meaningless number, not just a noisy one. Return the neutral
 * midpoint for any non-English `lang` instead.
 * @param {string} text
 * @param {string} [lang='en'] BCP-47-ish language code, e.g. from <html lang>.
 * @returns {{ flesch: number, readingComplexity: number }}
 */
function scoreReadability(text, lang = 'en') {
  if (String(lang).toLowerCase().split(/[-_]/)[0] !== 'en') {
    return { flesch: 50, readingComplexity: 0.5 };
  }
  const flesch = fleschReadingEase(text);
  return {
    flesch,
    readingComplexity: parseFloat(((100 - flesch) / 100).toFixed(3)),
  };
}

/**
 * scoreReadingComplexity — [0..1] complexity for callers that want the single
 * scalar rather than the pair. Same direction as `readingComplexity`
 * (higher = harder) and the same non-English gate as `scoreReadability`.
 * @param {string} text
 * @param {string} [lang='en']
 * @returns {number}
 */
function scoreReadingComplexity(text, lang = 'en') {
  return scoreReadability(text, lang).readingComplexity;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    fleschReadingEase,
    readingComplexity,
    scoreReadability,
    scoreReadingComplexity,
    countSentences,
  };
} else if (typeof window !== 'undefined') {
  window.Web2MusicReadability = {
    fleschReadingEase,
    readingComplexity,
    scoreReadability,
    scoreReadingComplexity,
    countSentences,
  };
}
})();
