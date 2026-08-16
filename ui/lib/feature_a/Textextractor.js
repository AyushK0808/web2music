(function () {
const BOILERPLATE_TAGS = new Set([
  'NAV', 'FOOTER', 'HEADER', 'ASIDE', 'FORM', 'SCRIPT', 'STYLE',
  'NOSCRIPT', 'IFRAME', 'BUTTON', 'SVG'
]);

const BOILERPLATE_CLASS_HINTS = [
  'nav', 'footer', 'header', 'sidebar', 'ad', 'ads', 'advert',
  'banner', 'cookie', 'popup', 'modal', 'menu', 'breadcrumb',
  'social', 'share', 'comment', 'related', 'newsletter',
  // Index/homepage chrome. These pages have no single article container, so the
  // content walk legitimately stops near <body> and this chrome would otherwise
  // land in the extracted text (observed as "Skip to contentAdvertisement…" on
  // news front pages). Matched as whole tokens, so these can't clip real words.
  'advertisement', 'masthead', 'navigation', 'toolbar', 'skip', 'skiplink',
  'submenu', 'megamenu', 'promo', 'subscribe', 'paywall'
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

/*
 * Content selection: find the tightest element that still holds essentially all
 * of the page's prose.
 *
 * The previous scorer divided text length by DESCENDANT TAG COUNT, which is
 * structurally biased toward leaves: a caption with no descendants divided by 1
 * (via `|| 1`) and scored its full text length, while a real article divided by
 * its thousands of descendants. On en.wikipedia.org/wiki/Espresso that made a
 * 61-char image caption outscore the 30k-char article ~8x, so extraction
 * returned 10 words of 4,616 and tripped the isImageOnly fallback. Measured
 * across a small site sample, 5 of 7 text-rich pages lost >90% of their text
 * this way.
 *
 * Instead: start at the root (or a semantic container that holds most of the
 * text) and walk DOWN only while a single child still contains nearly all the
 * non-link text. The walk stops exactly where content fans out into sibling
 * paragraphs — the article container — and can never descend into one paragraph
 * or caption, because a single child holding ~all the text is precisely what
 * stops being true there.
 */

// A child must hold at least this share of its parent's non-link text to be
// considered "the same content, just more tightly wrapped".
const DOMINANT_CHILD_SHARE = 0.9;

// Never descend into (or select) a block below this much text; keeps the walk
// from bottoming out into a single sentence on sparse pages.
const MIN_CONTENT_TEXT_LENGTH = 200;

// A semantic <article>/<main> must hold at least this share of the root's text
// to be trusted as the starting point (some sites wrap a teaser in <article>).
const SEMANTIC_MIN_SHARE = 0.25;

/**
 * Non-link text length, via textContent rather than innerText.
 *
 * Deliberate: innerText forces layout on every call, and this runs over many
 * nodes during the descent — that made text the most expensive extraction stage.
 * textContent is layout-free. Hidden boilerplate is handled by stripping instead
 * (see stripHintedElements / BOILERPLATE_TAGS), and innerText is still used once
 * on the final selection so the returned text keeps visibility filtering.
 */
function nonLinkTextLength(el) {
  const textLength = (el.textContent || '').trim().length;
  if (textLength === 0) return 0;

  let linkTextLength = 0;
  const anchors = el.getElementsByTagName('a');
  for (let i = 0; i < anchors.length; i++) {
    linkTextLength += (anchors[i].textContent || '').length;
  }

  return Math.max(0, textLength - linkTextLength);
}

/**
 * textDensityScore — non-link text weighted by how little of it is links.
 * Kept as a named export for inspection/debugging. No longer divided by
 * descendant count; see the note above for why that was the whole bug.
 */
function textDensityScore(el) {
  const textLength = (el.textContent || '').trim().length;
  if (textLength === 0) return 0;
  const nonLink = nonLinkTextLength(el);
  return nonLink * (nonLink / textLength); // penalises link-heavy blocks
}

function findMainContentElement(root = document.body) {
  if (!root) return root;

  const rootText = nonLinkTextLength(root);
  if (rootText < MIN_CONTENT_TEXT_LENGTH) return root;

  // Prefer a semantic container, but only if it actually holds the content.
  let current = root;
  for (const sel of ['article', 'main', '[role="main"]']) {
    let el;
    try {
      el = root.querySelector(sel);
    } catch {
      el = null; // querySelector can throw on exotic selectors in some engines
    }
    if (el && !looksLikeBoilerplate(el) &&
        nonLinkTextLength(el) >= rootText * SEMANTIC_MIN_SHARE) {
      current = el;
      break;
    }
  }

  // Descend while one child still holds nearly all the non-link text AND
  // nearly all the text overall.
  //
  // Requiring both is what keeps link-dominated pages intact. Selection
  // scores by non-link text (so a nav/link farm can't win), but extraction
  // afterwards takes innerText — *all* the text — from whatever was
  // selected. On a directory/index page those two measures come apart
  // completely: crates.io's homepage is 4541 chars of text of which only
  // 249 are outside an <a>, because the page genuinely is a list of links.
  // Its one incidental prose block (the 238-char tagline) therefore held
  // 95.6% of the non-link text, counted as "dominant", and the walk
  // descended into it — returning a tagline as the page's main content and
  // throwing away everything else. crates.io extracted 36 of 632 visible
  // words this way. Any aggregator/package-index/category page has the
  // same shape.
  //
  // A real article container dominates on both measures at once, so this
  // costs article pages nothing; it only stops the walk from mistaking a
  // rounding error for the content.
  for (;;) {
    const currentText = nonLinkTextLength(current);
    if (currentText < MIN_CONTENT_TEXT_LENGTH) break;
    const currentTotal = (current.textContent || '').trim().length;

    let dominant = null;
    const children = current.children || [];
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (looksLikeBoilerplate(child)) continue;
      const childText = nonLinkTextLength(child);
      const childTotal = (child.textContent || '').trim().length;
      if (childText >= currentText * DOMINANT_CHILD_SHARE &&
          childText >= MIN_CONTENT_TEXT_LENGTH &&
          childTotal >= currentTotal * DOMINANT_CHILD_SHARE) {
        dominant = child;
        break; // only one child can hold >=90%, so the first is the one
      }
    }

    if (!dominant) break; // content fans out here — this is the container
    current = dominant;
  }

  return current;
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

/**
 * stripHiddenElements — remove content hidden via attributes.
 *
 * Selection now walks the DOM with textContent (layout-free, but unlike
 * innerText it does NOT skip hidden nodes), so hidden menus/dialogs would
 * otherwise count toward the descent. These are attribute checks only — no
 * getComputedStyle, so still no forced layout.
 */
function stripHiddenElements(root) {
  Array.from(root.querySelectorAll('[hidden], [aria-hidden="true"], template'))
    .forEach(el => el.remove());
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
  stripHiddenElements(clone);

  const mainEl = findMainContentElement(clone);
  // innerText once, on the final selection only — it forces layout, so calling
  // it during selection (as this used to) was the bulk of the text-stage cost.
  // A detached clone has no layout box in some engines, hence the textContent
  // fallback (that is also the jsdom path, where innerText is undefined).
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
    textDensityScore, nonLinkTextLength, classOrIdTokens,
    stripHintedElements, stripHiddenElements
  };
} else if (typeof window !== 'undefined') {
  window.Web2MusicTextExtractor = { extractPageText, extractMetadata };
}})();
