#!/usr/bin/env node
/**
 * C-05 — tests for the annotation tool.
 *
 *   node analysis/annotate/annotate_test.mjs
 *
 * The tool is a single offline HTML file that five people will each spend
 * about ninety minutes in. The failures worth testing for are not rendering
 * bugs, they are the ones that quietly corrupt the ground truth:
 *
 *  - every annotator getting the same presentation order (fatigue then lands
 *    on the same pages for everyone and looks like those pages being hard);
 *  - the same annotator getting a *different* order on resume (they would
 *    re-label pages they had already done and lose the ones they hadn't);
 *  - the exported file not matching what krippendorff.py reads;
 *  - the page URL being clickable, which would let an annotator label the
 *    live page instead of the frozen record.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGE_URL = `file://${path.join(__dirname, 'index.html').replace(/\\/g, '/')}`;

let failures = 0;
const check = (name, cond, detail = '') => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail && !cond ? ` — ${detail}` : ''}`);
};

function fakeCorpus(n = 12) {
  return {
    captured_at: '2026-08-10T00:00:00.000Z',
    pages: Array.from({ length: n }, (_, i) => ({
      id: `p${i}`,
      url: `https://example.com/${i}`,
      slice: 'general',
      pageData: {
        title: `Page ${i}`,
        url: `https://example.com/${i}`,
        rawText: `Body text for page ${i}. `.repeat(20),
        lang: 'en',
        wordCount: 100 + i,
        colors: { dominant: '#334455', accent: '#aabbcc' },
      },
    })),
  };
}

async function startAs(page, annotator, corpusPath) {
  await page.goto(PAGE_URL);
  await page.fill('#annotator', annotator);
  await page.setInputFiles('#corpusFile', corpusPath);
  await page.click('#start');
  await page.waitForSelector('#app:not(.hide)');
}

const currentId = (page) => page.evaluate(() => document.getElementById('pos').textContent);

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w2m-annot-'));
  const corpusPath = path.join(tmp, 'corpus.json');
  fs.writeFileSync(corpusPath, JSON.stringify(fakeCorpus()));

  const browser = await chromium.launch();

  // ── order ────────────────────────────────────────────────────────────────
  const ctxA = await browser.newContext();
  const a = await ctxA.newPage();
  await startAs(a, 'ann-one', corpusPath);
  const orderA = await a.evaluate(() => state.order.join(','));

  const ctxB = await browser.newContext();
  const b = await ctxB.newPage();
  await startAs(b, 'ann-two', corpusPath);
  const orderB = await b.evaluate(() => state.order.join(','));

  check('two annotators get different presentation orders', orderA !== orderB);
  check('every page appears exactly once in an order',
    new Set(orderA.split(',')).size === 12 && orderA.split(',').length === 12);

  // Same id, fresh context: order must be reproducible or resume breaks.
  const ctxA2 = await browser.newContext();
  const a2 = await ctxA2.newPage();
  await startAs(a2, 'ann-one', corpusPath);
  check('the same annotator id reproduces the same order',
    (await a2.evaluate(() => state.order.join(','))) === orderA);
  await ctxA2.close();

  // ── the frozen record, not the live page ────────────────────────────────
  check('the page URL is rendered as text, not as a link',
    (await a.locator('#pageUrl a').count()) === 0);
  check('no element in the tool links out to the corpus URLs',
    (await a.locator('a[href^="http"]').count()) === 0);
  check('the extracted text is shown',
    (await a.locator('#pageText').innerText()).includes('Body text for page'));

  // ── labelling and keyboard ──────────────────────────────────────────────
  await a.keyboard.press('1');           // category -> Educational
  await a.keyboard.press('a');           // mood -> calm
  await a.keyboard.press('s');           // sensitive -> yes
  let labels = await a.evaluate(() => JSON.parse(JSON.stringify(state.labels)));
  const firstId = orderA.split(',')[0];
  check('keyboard shortcuts record all three labels',
    labels[firstId]?.category === 'Educational' && labels[firstId]?.mood === 'calm'
    && labels[firstId]?.sensitive === true,
    JSON.stringify(labels[firstId]));

  await a.keyboard.press('s');
  labels = await a.evaluate(() => JSON.parse(JSON.stringify(state.labels)));
  check('s toggles sensitive back off', labels[firstId]?.sensitive === false);

  const before = await currentId(a);
  await a.keyboard.press('Enter');
  check('Enter advances', (await currentId(a)) !== before);
  await a.keyboard.press('Backspace');
  check('Backspace goes back', (await currentId(a)) === before);

  // ── skip is recorded, not silent ────────────────────────────────────────
  await a.keyboard.press('Enter');
  const skipId = await a.evaluate(() => state.order[state.idx]);
  await a.click('#skip');
  labels = await a.evaluate(() => JSON.parse(JSON.stringify(state.labels)));
  check('a skip is recorded explicitly rather than left as a gap',
    labels[skipId]?.skipped === true);

  // ── resume lands on the first unlabelled page ───────────────────────────
  const exported = await a.evaluate(() => ({
    annotator: state.annotator, labels: JSON.parse(JSON.stringify(state.labels)),
  }));
  const sessionPath = path.join(tmp, 'session.json');
  fs.writeFileSync(sessionPath, JSON.stringify(exported));

  const ctxC = await browser.newContext();
  const c = await ctxC.newPage();
  await c.goto(PAGE_URL);
  await c.fill('#annotator', 'ann-one');
  await c.setInputFiles('#corpusFile', corpusPath);
  await c.setInputFiles('#resumeFile', sessionPath);
  await c.click('#start');
  await c.waitForSelector('#app:not(.hide)');
  const resumedIdx = await c.evaluate(() => state.idx);
  const expectedIdx = await c.evaluate(() =>
    state.order.findIndex((id) => !state.labels[id]));
  check('resume opens at the first unlabelled page in that annotator\'s order',
    resumedIdx === expectedIdx && resumedIdx > 0, `idx=${resumedIdx}`);
  check('resume keeps the judgements already made',
    (await c.evaluate(() => Object.keys(state.labels).length)) === Object.keys(exported.labels).length);

  // ── export shape matches krippendorff.py ───────────────────────────────
  const payload = await c.evaluate(() => ({
    annotator: state.annotator,
    labels: state.labels,
  }));
  const sample = Object.values(payload.labels).find((l) => l.category);
  check('export carries an annotator id', typeof payload.annotator === 'string' && payload.annotator);
  check('export maps page id -> {category, mood, sensitive}',
    !!sample && 'category' in sample && 'mood' in sample && 'sensitive' in sample,
    JSON.stringify(sample));

  // ── a corpus with no extractions is rejected, loudly ───────────────────
  const emptyPath = path.join(tmp, 'empty.json');
  fs.writeFileSync(emptyPath, JSON.stringify({ pages: [{ id: 'x', url: 'u', pageData: null }] }));
  const d = await (await browser.newContext()).newPage();
  await d.goto(PAGE_URL);
  await d.setInputFiles('#corpusFile', emptyPath);
  // The change handler reads the file asynchronously; wait for it to report.
  await d.waitForFunction(() => document.getElementById('setupStatus').textContent.trim() !== '',
    null, { timeout: 5000 }).catch(() => {});
  check('a corpus with no extracted pages is refused with a reason',
    (await d.locator('#setupStatus').innerText()).toLowerCase().includes('no pages'),
    await d.locator('#setupStatus').innerText());

  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`\n${failures === 0 ? 'PASSED' : `FAILED (${failures})`}`);
  return failures === 0 ? 0 : 1;
}

main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
