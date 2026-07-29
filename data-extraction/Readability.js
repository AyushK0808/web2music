const { countSyllables } = (typeof module !== 'undefined' && module.exports)
  ? require('./syllableCounter')
  : window.Web2MusicSyllableCounter;

const NEUTRAL_SCORE = 0.5;

function countSentences(text) {
  const matches = text.match(/[.!?]+(?:\s|$)/g);
  return matches ? matches.length : (text.trim().length ? 1 : 0);
}

function fleschReadingEase(text) {
  const words = text.match(/[A-Za-z'-]+/g) || [];
  const wordCount = words.length;
  const sentenceCount = countSentences(text);

  if (wordCount === 0 || sentenceCount === 0) return NEUTRAL_SCORE;

  const syllableCount = words.reduce((sum, w) => sum + countSyllables(w), 0);

  const rawScore = 206.835
    - 1.015 * (wordCount / sentenceCount)
    - 84.6 * (syllableCount / wordCount);

  // Normalize the typical 0-100 Flesch range into [0,1] for the feature vector
  return Math.max(0, Math.min(1, rawScore / 100));
}

/**
 * Public entry point. Flesch-Kincaid is an English-specific formula (built
 * on English syllable/sentence patterns) — scoring non-English text with it
 * produces meaningless numbers. Gate on `lang` and return the neutral
 * default for anything that isn't English.
 *
 * @param {string} text - cleaned article text (post textExtractor.js)
 * @param {string} lang - BCP-47-ish language code, e.g. from extractMetadata().lang
 * @returns {number} 0-1, higher = easier to read. 0.5 = neutral/undefined.
 */
function scoreReadingComplexity(text, lang = 'en') {
  if (!text || !text.trim()) return NEUTRAL_SCORE;
  if (lang !== 'en') return NEUTRAL_SCORE;
  return fleschReadingEase(text);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { scoreReadingComplexity, fleschReadingEase, countSentences };
} else if (typeof window !== 'undefined') {
  window.Web2MusicReadability = { scoreReadingComplexity };
}