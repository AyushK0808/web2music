function countSyllables(word) {
  if (!word || typeof word !== 'string') return 0;

  const normalized = word.toLowerCase().trim().replace(/[^a-z]/g, '');
  if (normalized.length === 0) return 0;

  const vowelGroups = normalized.match(/[aeiouy]+/g) || [];
  let count = vowelGroups.length;

  if (normalized.endsWith('e') && !normalized.endsWith('le') && count > 1) {
    count -= 1;
  }

  return Math.max(1, count);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { countSyllables };
} else if (typeof window !== 'undefined') {
  window.Web2MusicSyllableCounter = { countSyllables };
}