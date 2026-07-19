const BOILERPLATE_TAGS = new Set([
  'NAV', 'FOOTER', 'HEADER', 'ASIDE', 'FORM', 'SCRIPT', 'STYLE',
  'NOSCRIPT', 'IFRAME', 'BUTTON', 'SVG'
]);

const BOILERPLATE_CLASS_HINTS = [
  'nav', 'footer', 'header', 'sidebar', 'ad', 'ads', 'advert',
  'banner', 'cookie', 'popup', 'modal', 'menu', 'breadcrumb',
  'social', 'share', 'comment', 'related', 'newsletter'
];

function classOrIdTokens(el) {
  const classAttr = typeof el.className === 'string'
    ? el.className
    : (el.getAttribute && el.getAttribute('class')) || '';
  const idAttr = el.id || '';
  return `${idAttr} ${classAttr}`.toLowerCase().split(/\s+/).filter(Boolean);
}

function looksLikeBoilerplate(el) {
  if (BOILERPLATE_TAGS.has(el.tagName)) return true;
  const tokens = classOrIdTokens(el);
  return tokens.some(token => BOILERPLATE_CLASS_HINTS.includes(token));
}

function textDensityScore(el) {
  const text = el.innerText || el.textContent || '';
  const textLength = text.trim().length;
  if (textLength === 0) return 0;

  const tagCount = el.getElementsByTagName('*').length || 1;
  const linkTextLength = Array.from(el.getElementsByTagName('a'))
    .reduce((sum, a) => sum + (a.innerText || a.textContent || '').length, 0);

  const linkDensity = linkTextLength / textLength;
  const density = textLength / tagCount;

  return density * (1 - linkDensity);
}

function findMainContentElement(root = document.body) {
  const candidates = [];

  const semanticSelectors = ['article', 'main', '[role="main"]'];
  for (const sel of semanticSelectors) {
    const el = root.querySelector(sel);
    if (el) candidates.push(el);
  }

  const blockTags = root.querySelectorAll('div, section');
  blockTags.forEach(el => {
    if (!looksLikeBoilerplate(el)) candidates.push(el);
  });

  if (candidates.length === 0) return root;

  let best = candidates[0];
  let bestScore = -Infinity;

  for (const el of candidates) {
    if (looksLikeBoilerplate(el)) continue;
    const score = textDensityScore(el);
    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }

  return best;
}

function stripHintedElements(root) {
  const hints = new Set(BOILERPLATE_CLASS_HINTS);
  Array.from(root.querySelectorAll('*')).forEach(el => {
    const tokens = classOrIdTokens(el);
    if (tokens.some(token => hints.has(token))) {
      el.remove();
    }
  });
}

function normalizeWhitespace(text) {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\u00A0/g, ' ')
    .trim();
}

/**
 * extractMetadata — cheap DOM reads Feature A owns: the meta description
 * (with og:description / twitter:description fallbacks) and the document
 * language. Both are required inputs for Feature B's B1 (analyseMetadata).
 * @param {Document} doc
 * @returns {{ description: string, lang: string }}
 */
function extractMetadata(doc = document) {
  const pick = (selector, attr = 'content') => {
    const el = doc.querySelector(selector);
    const val = el && el.getAttribute(attr);
    return val ? normalizeWhitespace(val) : '';
  };

  const description =
    pick('meta[name="description"]') ||
    pick('meta[property="og:description"]') ||
    pick('meta[name="twitter:description"]') ||
    '';

  // documentElement.lang → <html lang> ; fall back to a content-language meta
  // tag, then default to English.
  const htmlLang =
    (doc.documentElement && doc.documentElement.getAttribute('lang')) || '';
  const metaLang = pick('meta[http-equiv="content-language"]');
  const lang = normalizeWhitespace(htmlLang || metaLang || 'en')
    .toLowerCase()
    .split(/[,\s]/)[0] || 'en';

  return { description, lang };
}

function extractPageText(doc = document) {
  const title = normalizeWhitespace(doc.title || '');
  const { description, lang } = extractMetadata(doc);

  if (!doc.body) {
    return {
      title,
      mainText: '',
      description,
      lang,
      wordCount: 0,
      url: doc.location ? doc.location.href : ''
    };
  }

  const clone = doc.body.cloneNode(true);
  BOILERPLATE_TAGS.forEach(tag => {
    clone.querySelectorAll(tag.toLowerCase()).forEach(el => el.remove());
  });
  stripHintedElements(clone);

  const mainEl = findMainContentElement(clone);
  const rawText = mainEl.innerText || mainEl.textContent || '';
  const mainText = normalizeWhitespace(rawText);

  return {
    title,
    mainText,
    description,
    lang,
    wordCount: mainText.length ? mainText.split(/\s+/).length : 0,
    url: doc.location ? doc.location.href : ''
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    extractPageText, extractMetadata, findMainContentElement,
    textDensityScore, classOrIdTokens, stripHintedElements
  };
} else if (typeof window !== 'undefined') {
  window.Web2MusicTextExtractor = { extractPageText, extractMetadata };
}
