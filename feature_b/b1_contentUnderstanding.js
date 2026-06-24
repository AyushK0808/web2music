/**
 * FEATURE B — B1: Content Understanding
 *
 * Receives raw page data from Feature A (Handoff 1).
 * Responsibilities:
 *   - Text cleaning & preprocessing
 *   - Keyword & topic extraction
 *   - Metadata analysis
 *   - Content summarization
 *
 * Input:  PageData (JSON) from Feature A
 * Output: CleanedContent (JSON) → passed to B2
 */

"use strict";

// ─── Stopword list (English) ──────────────────────────────────────────────────
const STOPWORDS = new Set([
  "the","a","an","is","it","in","of","and","or","to","for","on","at","by",
  "with","as","that","this","from","was","are","be","been","has","have",
  "had","will","would","could","should","may","might","do","does","did",
  "not","but","so","if","its","their","they","we","you","he","she","i",
  "me","my","our","your","his","her","them","us","what","which","who",
  "when","where","how","all","no","more","also","just","can","up","out",
]);

// ─── Sensitive content signals (edge case #2 from spec) ─────────────────────
const SENSITIVE_PATTERNS = [
  /\b(suicide|self.harm|self-harm|eating disorder|anorexia|bulimia)\b/i,
  /\b(mental health crisis|grief|bereavement|depression|trauma)\b/i,
  /\b(rape|sexual assault|domestic violence|abuse)\b/i,
  /\b(terrorism|mass shooting|genocide)\b/i,
];

// ─── Keyword → content category map (maps to CONTENT CATEGORIES from spec) ──
const CATEGORY_KEYWORDS = {
  Educational:       ["learn","course","study","tutorial","explain","definition","science","math","history","biology"],
  News:              ["breaking","report","election","government","policy","president","minister","economy","war","conflict"],
  Horror:            ["horror","thriller","suspense","scary","fear","monster","haunted","death","murder","mystery"],
  Food:              ["recipe","food","eat","cook","restaurant","cuisine","diet","ingredient","meal","taste"],
  Entertainment:     ["movie","music","celebrity","actor","singer","film","show","tv","game","anime"],
  Sports:            ["sports","football","cricket","tennis","basketball","match","tournament","player","score","team"],
  Finance:           ["stock","invest","crypto","market","bank","finance","fund","economy","trading","portfolio"],
  Legal:             ["law","court","legal","attorney","case","judgment","rights","contract","regulation","compliance"],
  Health:            ["health","medical","doctor","disease","symptom","treatment","hospital","mental","wellness","therapy"],
  Comedy:            ["funny","humor","laugh","joke","meme","comedy","hilarious","satire","parody"],
  Emotional:         ["love","heart","emotion","feeling","relationship","breakup","family","nostalgia","memory"],
  Mythological:      ["myth","history","ancient","spiritual","religion","god","temple","tradition","culture","heritage"],
  Travel:            ["travel","nature","destination","beach","mountain","hotel","explore","adventure","hiking","park"],
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Naive syllable counter (English approximation).
 * Used for Flesch Reading Ease score in B1.
 */
function countSyllables(word) {
  word = word.toLowerCase().replace(/[^a-z]/g, "");
  if (word.length <= 3) return 1;
  word = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "");
  const match = word.match(/[aeiouy]{1,2}/g);
  return match ? match.length : 1;
}

/**
 * Flesch Reading Ease → complexity score [0..1].
 * 206.835 – 1.015(words/sentences) – 84.6(syllables/words)
 * Higher Flesch = easier to read = lower complexity score.
 */
function computeReadingComplexity(text) {
  if (!text || text.trim().length === 0) return 0.5;

  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  const words     = text.match(/\b\w+\b/g) || [];

  if (words.length === 0) return 0.5;

  const totalSyllables = words.reduce((sum, w) => sum + countSyllables(w), 0);
  const wordsPerSentence  = words.length / Math.max(sentences.length, 1);
  const syllablesPerWord  = totalSyllables / words.length;

  const fleschScore = 206.835 - 1.015 * wordsPerSentence - 84.6 * syllablesPerWord;
  // Clamp to [0,100] then invert & normalise to [0,1] (harder = higher value)
  const clamped = Math.min(100, Math.max(0, fleschScore));
  return parseFloat(((100 - clamped) / 100).toFixed(3));
}

// ─── Main exports ─────────────────────────────────────────────────────────────

/**
 * cleanText — strip HTML entities, collapse whitespace, remove boilerplate.
 * @param {string} rawText
 * @returns {string}
 */
export function cleanText(rawText) {
  if (!rawText) return "";

  return rawText
    .replace(/&amp;/gi, "&")             // decode common entities first
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&(#39|apos);/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&[a-z]+;/gi, " ")          // strip any other/unknown entities
    .replace(/<[^>]+>/g, " ")            // any residual tags
    .replace(/https?:\/\/\S+/g, " ")    // URLs
    .replace(/[^\w\s.,!?'&-]/g, " ")    // non-meaningful punctuation (now keeps &)
    .replace(/\s{2,}/g, " ")            // collapsed whitespace
    .trim();
}

/**
 * extractKeywords — TF-style top-N keywords from cleaned text.
 * Falls back gracefully if text is empty.
 * @param {string} cleanedText
 * @param {number} topN
 * @returns {string[]}
 */
export function extractKeywords(cleanedText, topN = 15) {
  if (!cleanedText) return [];

  const freq = {};
  const words = cleanedText.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];

  for (const word of words) {
    if (STOPWORDS.has(word)) continue;
    freq[word] = (freq[word] || 0) + 1;
  }

  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([word]) => word);
}

/**
 * classifyContentCategory — maps keywords to the 13 content categories in spec.
 * Returns top-2 matching categories with confidence scores.
 * @param {string[]} keywords
 * @param {string}   title
 * @returns {{ primary: string, secondary: string|null, scores: Object }}
 */
export function classifyContentCategory(keywords, title = "") {
  const scores = {};
  const allTokens = [...keywords, ...title.toLowerCase().split(/\s+/)];

  for (const [category, categoryKeywords] of Object.entries(CATEGORY_KEYWORDS)) {
    let hits = 0;
    for (const token of allTokens) {
      if (categoryKeywords.some(kw => token.startsWith(kw))) hits++;
    }
    scores[category] = hits;
  }

  const sorted = Object.entries(scores)
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1]);

  return {
    primary:   sorted[0]?.[0] ?? "Entertainment",
    secondary: sorted[1]?.[0] ?? null,
    scores,
  };
}

/**
 * checkSensitiveContent — edge case #2: detect crisis / harm pages.
 * If matched, downstream modules force-override to Uplifting/Spiritual.
 * @param {string} text
 * @returns {boolean}
 */
export function checkSensitiveContent(text) {
  if (!text) return false;
  return SENSITIVE_PATTERNS.some(re => re.test(text));
}

/**
 * analyseMetadata — extract signals from page metadata object (from Feature A).
 * @param {Object} meta  { title, description, ogImage, url, lang }
 * @returns {Object}     enriched metadata signals
 */
export function analyseMetadata(meta = {}) {
  const url   = meta.url || "";
  const title = meta.title || "";
  const desc  = meta.description || "";

  // Detect payment / banking pages (edge case #16)
  const isPaymentPage = /pay|checkout|bank|wallet|invoice|billing/i.test(url + title);
  // Detect chrome-internal pages (edge case #21)
  const isChromeInternal = /^chrome(?:-extension)?:\/\//i.test(url);
  // Detect image-only pages (edge case #15) — no meaningful text
  const isImageOnly = (desc + title).length < 20;

  return {
    title,
    description: desc,
    isPaymentPage,
    isChromeInternal,
    isImageOnly,
    language: meta.lang || "en",
  };
}

/**
 * summariseContent — produce a short summary string for the LLM prompt later.
 * Simple extractive summary: first 2 sentences of cleaned body.
 * @param {string} cleanedText
 * @returns {string}
 */
export function summariseContent(cleanedText) {
  if (!cleanedText) return "";
  const sentences = cleanedText.match(/[^.!?]+[.!?]+/g) || [];
  return sentences.slice(0, 2).join(" ").trim().slice(0, 400);
}

/**
 * runB1 — orchestrates the full B1 Content Understanding pipeline.
 *
 * @param {Object} pageData   Handoff 1 payload from Feature A:
 *   {
 *     rawText:     string,   // first 400-500 words from content_script
 *     title:       string,
 *     description: string,   // meta description
 *     url:         string,
 *     lang:        string,
 *     colors:      Object,   // from Feature A colour extraction
 *     scrollSpeed: number,
 *     cursorSpeed: number,
 *     embedding:   number[], // vector from Feature A
 *   }
 *
 * @returns {Object} CleanedContent — input to B2
 */
export function runB1(pageData) {
  const meta = analyseMetadata({
    title:       pageData.title,
    description: pageData.description,
    url:         pageData.url,
    lang:        pageData.lang,
  });

  // Short-circuit for special page types
  if (meta.isChromeInternal) {
    return { _bypass: "chrome_internal", meta };
  }
  if (meta.isPaymentPage) {
    return { _bypass: "payment_page", meta };
  }

  const cleaned     = cleanText(pageData.rawText || "");
  const isSensitive = checkSensitiveContent(cleaned + " " + meta.title);
  const keywords    = extractKeywords(cleaned);
  const category    = classifyContentCategory(keywords, meta.title);
  const summary     = summariseContent(cleaned);
  const complexity  = computeReadingComplexity(cleaned);

  return {
    // Pass-through signals
    scrollSpeed:  pageData.scrollSpeed  ?? 0,
    cursorSpeed:  pageData.cursorSpeed  ?? 0,
    colors:       pageData.colors       ?? {},
    embedding:    pageData.embedding    ?? [],

    // B1 outputs
    meta,
    cleanedText:       cleaned,
    keywords,
    category,          // { primary, secondary, scores }
    summary,           // short extractive summary for LLM
    readingComplexity: complexity,    // [0..1], higher = harder
    isSensitive,       // boolean — triggers override in B2

    // Image-only flag — B2 will skip LLM text call if true
    isImageOnly: meta.isImageOnly,
  };
}
