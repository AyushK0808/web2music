/*
 * Manual playground for the Feature A extraction modules.
 *
 *   cd data-extraction
 *   npm install       # one-time: pulls in jsdom
 *   npm run play      # or: node playground.js
 *
 * This is NOT a test suite -- it just runs each module on sample input and
 * prints the results so you can eyeball whether they behave sensibly before
 * you commit to writing real tests.
 */

const { JSDOM } = require('jsdom');

function heading(label) {
  console.log('\n' + '='.repeat(60));
  console.log(label);
  console.log('='.repeat(60));
}

/* --------------------------------------------------------------------- */
/* 1. Pure functions -- no DOM needed                                     */
/* --------------------------------------------------------------------- */

function runPureFunctions() {
  heading('1. Pure functions (no DOM)');

  const { cosineSimilarity } = require('./Embeddingmodel.js');
  console.log('\ncosineSimilarity:');
  console.log('  identical  [1,2,3] vs [1,2,3] =', cosineSimilarity([1, 2, 3], [1, 2, 3]), '(expect 1)');
  console.log('  orthogonal [1,0]   vs [0,1]   =', cosineSimilarity([1, 0], [0, 1]), '(expect 0)');
  console.log('  opposite   [1,2]   vs [-1,-2] =', cosineSimilarity([1, 2], [-1, -2]), '(expect -1)');
  console.log('  zero-vec   [0,0]   vs [1,1]   =', cosineSimilarity([0, 0], [1, 1]), '(expect 0)');

  const { parseRgba, rgbToHsl } = require('./Colorextractor.js');
  console.log('\nparseRgba:');
  console.log('  "rgb(255, 0, 0)"        =>', parseRgba('rgb(255, 0, 0)'));
  console.log('  "rgba(0, 128, 255, 0.5)"=>', parseRgba('rgba(0, 128, 255, 0.5)'));
  console.log('  "transparent"           =>', parseRgba('transparent'));

  console.log('\nrgbToHsl:');
  console.log('  red   (255,0,0)   =>', rgbToHsl({ r: 255, g: 0, b: 0 }), '(hue ~0)');
  console.log('  green (0,255,0)   =>', rgbToHsl({ r: 0, g: 255, b: 0 }), '(hue ~120)');
  console.log('  blue  (0,0,255)   =>', rgbToHsl({ r: 0, g: 0, b: 255 }), '(hue ~240)');
  console.log('  gray  (128,128,128)=>', rgbToHsl({ r: 128, g: 128, b: 128 }), '(s ~0)');
}

/* --------------------------------------------------------------------- */
/* 2. Text extraction -- needs a DOM (jsdom)                              */
/* --------------------------------------------------------------------- */

const SAMPLE_HTML = `<!DOCTYPE html>
<html>
<head><title>The Art of Espresso — Coffee Weekly</title></head>
<body>
  <nav class="site-nav"><a href="/">Home</a> <a href="/about">About</a></nav>
  <header class="banner">Coffee Weekly — subscribe for more!</header>
  <aside class="sidebar ads"><a href="/promo">Buy our beans!</a></aside>

  <article class="post-body">
    <h1>The Art of Espresso</h1>
    <p>Espresso is a concentrated form of coffee brewed by forcing hot water
       under pressure through finely-ground beans. The result is a rich,
       full-bodied shot topped with a layer of golden crema. Good espresso
       balances sweetness, acidity, and bitterness in a single ounce.</p>
    <p>Dialing in a shot means adjusting grind size, dose, and extraction time
       until the flavours align. Baristas chase a ratio of roughly one part
       coffee to two parts liquid, pulled over twenty-five to thirty seconds.</p>
  </article>

  <div class="related">Related: How to froth milk</div>
  <footer class="site-footer">© 2026 Coffee Weekly. All rights reserved.</footer>
</body>
</html>`;

function runTextExtraction() {
  heading('2. Text extraction (jsdom)');

  const dom = new JSDOM(SAMPLE_HTML, { url: 'https://coffee.example.com/espresso' });
  // The modules read the global `document`/`window`.
  global.window = dom.window;
  global.document = dom.window.document;

  const { extractPageText } = require('./Textextractor.js');
  const result = extractPageText(dom.window.document);

  console.log('\nextractPageText result:');
  console.log('  title    :', result.title);
  console.log('  url      :', result.url);
  console.log('  wordCount:', result.wordCount);
  console.log('  mainText :', result.mainText.slice(0, 200) + (result.mainText.length > 200 ? '…' : ''));
  console.log('\n  Eyeball check: nav / footer / ads / "related" should be GONE,');
  console.log('  and the two espresso paragraphs should remain.');

  return dom;
}

/* --------------------------------------------------------------------- */
/* 3. Colour extraction -- needs DOM + layout, which jsdom fakes.         */
/*    jsdom's getBoundingClientRect() returns all-zeros and doesn't do    */
/*    layout, so we patch in element sizes so the histogram has something */
/*    to weigh. getComputedStyle DOES return inline background-color.      */
/* --------------------------------------------------------------------- */

const COLOR_HTML = `<!DOCTYPE html>
<html><body style="background-color: rgb(255,255,255)">
  <div id="hero"    style="background-color: rgb(200, 30, 30)"></div>
  <div id="band"    style="background-color: rgb(210, 40, 40)"></div>
  <div id="accent"  style="background-color: rgb(30, 90, 200)"></div>
  <div id="chrome"  style="background-color: rgb(240, 240, 240)"></div>
</body></html>`;

// approximate on-screen sizes (px) keyed by element id
const FAKE_SIZES = {
  hero:   { w: 1200, h: 400 },
  band:   { w: 1200, h: 200 },
  accent: { w: 300, h: 200 },
  chrome: { w: 1200, h: 60 },
};

function runColorExtraction() {
  heading('3. Colour extraction (jsdom + faked layout)');

  const dom = new JSDOM(COLOR_HTML, { url: 'https://coffee.example.com/espresso' });
  const win = dom.window;
  global.window = win;
  global.document = win.document;

  win.innerWidth = 1280;
  win.innerHeight = 800;

  // Patch getBoundingClientRect so visibleArea() has real numbers to work with.
  win.Element.prototype.getBoundingClientRect = function () {
    const size = FAKE_SIZES[this.id] || { w: 0, h: 0 };
    return { left: 0, top: 0, right: size.w, bottom: size.h, width: size.w, height: size.h };
  };

  const { extractDominantColors } = require('./Colorextractor.js');
  const result = extractDominantColors(win.document.body, 3);

  console.log('\nextractDominantColors result:');
  console.log('  colorEnergy    :', result.colorEnergy.toFixed(3), '(higher = more chromatic area)');
  console.log('  achromaticRatio:', result.achromaticRatio.toFixed(3), '(white/gray share)');
  console.log('  dominantHues   :', JSON.stringify(result.dominantHues));
  console.log('\n  Eyeball check: red buckets (~hue 0-15) should dominate, blue (~225)');
  console.log('  second, and the white/gray areas should land in achromaticRatio.');
  console.log('\n  NOTE: sizes here are FAKED. In jsdom real layout is 0x0, so this');
  console.log('  function is only truly meaningful in a real browser tab.');
}

/* --------------------------------------------------------------------- */
/* 4. Embedding flow -- real backends need network/model, so mock it.     */
/* --------------------------------------------------------------------- */

async function runEmbeddingFlow() {
  heading('4. Embedding flow (MOCK backend)');

  const dom = new JSDOM('<!DOCTYPE html><body></body>');
  global.window = dom.window;

  // Fake @xenova/transformers pipeline: deterministic 8-dim vector from
  // character codes. Enough to watch getEmbedding + cosineSimilarity work
  // end-to-end without downloading a 90MB model.
  dom.window.transformersPipeline = async function (/* task, model */) {
    return async function (text /*, opts */) {
      const dims = 8;
      const vec = new Array(dims).fill(0);
      for (let i = 0; i < text.length; i++) {
        vec[i % dims] += text.charCodeAt(i);
      }
      const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
      return { data: vec.map(v => v / norm) };
    };
  };

  const { getEmbedding, cosineSimilarity } = require('./Embeddingmodel.js');

  const a = await getEmbedding('espresso coffee brewing pressure crema', { backend: 'local' });
  const b = await getEmbedding('espresso coffee shot extraction ratio', { backend: 'local' });
  const c = await getEmbedding('quarterly tax filing deadlines and forms', { backend: 'local' });

  console.log('\ngetEmbedding (mock local backend):');
  console.log('  vector A dims:', a.dimensions, '| backend:', a.backend);
  console.log('\ncosineSimilarity between embeddings:');
  console.log('  coffee A vs coffee B :', cosineSimilarity(a.vector, b.vector).toFixed(3), '(expect higher)');
  console.log('  coffee A vs taxes  C :', cosineSimilarity(a.vector, c.vector).toFixed(3), '(expect lower)');

  try {
    await getEmbedding('', { backend: 'local' });
  } catch (e) {
    console.log('\n  empty input correctly throws:', e.message);
  }

  console.log('\n  NOTE: the embedder is a stand-in. Real vectors come from');
  console.log('  @xenova/transformers (browser) or OpenAI (needs API key).');
}

/* --------------------------------------------------------------------- */

/* --------------------------------------------------------------------- */
/* 5. Full Handoff-1 assembly -- buildPageData() end to end.               */
/*    Runs all extractors + behaviour + metadata + readability + embedding */
/*    (mocked) and prints the single object Feature B's runB1() consumes.  */
/* --------------------------------------------------------------------- */

const PAGE_HTML = `<!DOCTYPE html>
<html lang="en-GB">
<head>
  <title>The Art of Espresso — Coffee Weekly</title>
  <meta name="description" content="A deep dive into pulling the perfect espresso shot: grind, dose, and extraction time.">
</head>
<body style="background-color: rgb(250,248,245)">
  <nav class="site-nav"><a href="/">Home</a></nav>
  <article class="post-body" style="background-color: rgb(205, 60, 40)">
    <h1>The Art of Espresso</h1>
    <p>Espresso is a concentrated form of coffee brewed by forcing hot water
       under pressure through finely-ground beans. The result is a rich,
       full-bodied shot topped with a layer of golden crema.</p>
    <p>Dialing in a shot means adjusting grind size, dose, and extraction time
       until the flavours align, pulled over twenty-five to thirty seconds.</p>
  </article>
  <div id="accent" style="background-color: rgb(30, 90, 200)"></div>
  <footer class="site-footer">© 2026 Coffee Weekly.</footer>
</body>
</html>`;

const PAGE_FAKE_SIZES = {
  'accent': { w: 300, h: 200 },
};

async function runPageDataAssembly() {
  heading('5. Full Handoff-1 assembly (buildPageData)');

  const dom = new JSDOM(PAGE_HTML, { url: 'https://coffee.example.com/espresso' });
  const win = dom.window;
  global.window = win;
  global.document = win.document;
  win.innerWidth = 1280;
  win.innerHeight = 800;

  // Give the article + accent + body some on-screen area so colour extraction
  // has something to weigh (jsdom does no real layout).
  win.Element.prototype.getBoundingClientRect = function () {
    if (this.tagName === 'ARTICLE') return rect(1000, 500);
    if (this.tagName === 'BODY')    return rect(1280, 800);
    const size = PAGE_FAKE_SIZES[this.id];
    return size ? rect(size.w, size.h) : rect(0, 0);
  };
  function rect(w, h) {
    return { left: 0, top: 0, right: w, bottom: h, width: w, height: h };
  }

  // Mock the local embedder (deterministic 8-dim vector) so we don't download a model.
  win.transformersPipeline = async function () {
    return async function (text) {
      const dims = 8;
      const vec = new Array(dims).fill(0);
      for (let i = 0; i < text.length; i++) vec[i % dims] += text.charCodeAt(i);
      const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
      return { data: vec.map(v => v / norm) };
    };
  };

  // Stub behaviour tracker (real one needs a live browser with scroll/mouse events).
  const behaviorTracker = { snapshot: () => ({ scrollSpeed: 450, cursorSpeed: 300 }) };

  const { buildPageData, validatePageData } = require('./pageData.js');

  const handoff = await buildPageData({
    doc: win.document,
    embeddingConfig: { backend: 'local' },
    behaviorTracker,
    useCache: true,
  });

  console.log('\nbuildPageData() → Handoff-1:');
  console.log('  handoffVersion   :', handoff.handoffVersion);
  console.log('  extractedAt      :', handoff.extractedAt);
  console.log('  title            :', handoff.title);
  console.log('  description      :', handoff.description);
  console.log('  lang             :', handoff.lang);
  console.log('  url              :', handoff.url);
  console.log('  wordCount        :', handoff.wordCount);
  console.log('  rawText (start)  :', handoff.rawText.slice(0, 80) + '…');
  console.log('  colors           :', JSON.stringify(handoff.colors));
  console.log('  colorEnergy      :', handoff.colorEnergy);
  console.log('  scrollSpeed      :', handoff.scrollSpeed, '| cursorSpeed:', handoff.cursorSpeed);
  console.log('  isImageOnly      :', handoff.isImageOnly);
  console.log('  flesch           :', handoff.flesch, '| readingComplexity:', handoff.readingComplexity);
  console.log('  embedding dims   :', handoff.embedding.length);

  // Contract check: every field B's runB1 reads must be present & typed.
  const required = {
    rawText: 'string', title: 'string', description: 'string', url: 'string',
    lang: 'string', scrollSpeed: 'number', cursorSpeed: 'number',
  };
  const problems = [];
  for (const [k, t] of Object.entries(required)) {
    if (typeof handoff[k] !== t) problems.push(`${k} is ${typeof handoff[k]} (want ${t})`);
  }
  const c = handoff.colors;
  if (typeof c.hue !== 'number' || typeof c.saturation !== 'number' || typeof c.lightness !== 'number') {
    problems.push('colors is missing hue/saturation/lightness');
  }
  if (!Array.isArray(handoff.embedding)) problems.push('embedding is not an array');
  console.log('\n  Contract check:', problems.length ? '❌ ' + problems.join('; ') : '✅ all B-required fields present & typed');

  // Cache: a second identical build should reuse the cached embedding vector.
  const again = await buildPageData({ doc: win.document, embeddingConfig: { backend: 'local' }, behaviorTracker });
  const sameVec = JSON.stringify(again.embedding) === JSON.stringify(handoff.embedding);
  console.log('  Embedding cache  :', sameVec ? '✅ revisit reused cached vector' : '❌ vector changed unexpectedly');

  // validatePageData defaults: a nearly-empty object still comes out complete.
  const filled = validatePageData({ title: 'Bare' });
  console.log('\nvalidatePageData({title:"Bare"}) fills defaults:');
  console.log('  colors:', JSON.stringify(filled.colors), '| embedding:', JSON.stringify(filled.embedding),
              '| lang:', filled.lang, '| handoffVersion:', filled.handoffVersion);
  console.log('\n  Eyeball check: colours should read as a warm red (hue ~0-15), scroll/cursor');
  console.log('  reflect the stub, and the contract check + cache line should both be ✅.');
}

async function main() {
  runPureFunctions();
  runTextExtraction();
  runColorExtraction();
  await runEmbeddingFlow();
  await runPageDataAssembly();
  console.log('\nDone. Nothing above is asserted — read the output and judge for yourself.\n');
}

main().catch(err => {
  console.error('\nPlayground crashed:', err);
  process.exit(1);
});
