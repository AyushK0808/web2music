

const { countSyllables } = (typeof module !== 'undefined' && module.exports)
  ? require('./syllableCounter')
  : window.Web2MusicSyllableCounter;


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