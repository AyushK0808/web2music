const BOILERPLATE_TAGS = new Set([
  'NAV', 'FOOTER', 'HEADER', 'ASIDE', 'FORM', 'SCRIPT', 'STYLE',
  'NOSCRIPT', 'IFRAME', 'BUTTON', 'SVG'
]);

const BOILERPLATE_CLASS_HINTS = [
  'nav', 'footer', 'header', 'sidebar', 'ad', 'ads', 'advert',
  'banner', 'cookie', 'popup', 'modal', 'menu', 'breadcrumb',
  'social', 'share', 'comment', 'related', 'newsletter'
];

function looksLikeBoilerplate(el) {
  if (BOILERPLATE_TAGS.has(el.tagName)) return true;
  const identifier = `${el.id || ''} ${el.className || ''}`.toLowerCase();
  return BOILERPLATE_CLASS_HINTS.some(hint => identifier.includes(hint));
}

function textDensityScore(el) {
  const text = el.innerText || '';
  const textLength = text.trim().length;
  if (textLength === 0) return 0;

  const tagCount = el.getElementsByTagName('*').length || 1;
  const linkTextLength = Array.from(el.getElementsByTagName('a'))
    .reduce((sum, a) => sum + (a.innerText || '').length, 0);

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

function normalizeWhitespace(text) {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\u00A0/g, ' ')
    .trim();
}

/**
 * extractMetadata \u2014 cheap DOM reads Feature A owns: the meta description
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

  // documentElement.lang \u2192 <html lang> ; fall back to a content-language meta
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

  const clone = doc.body.cloneNode(true);
  BOILERPLATE_TAGS.forEach(tag => {
    clone.querySelectorAll(tag.toLowerCase()).forEach(el => el.remove());
  });
  BOILERPLATE_CLASS_HINTS.forEach(hint => {
    clone.querySelectorAll(`[class*="${hint}"], [id*="${hint}"]`)
      .forEach(el => el.remove());
  });

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
  module.exports = { extractPageText, extractMetadata, findMainContentElement, textDensityScore };
} else if (typeof window !== 'undefined') {
  window.Web2MusicTextExtractor = { extractPageText, extractMetadata };
}
