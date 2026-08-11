// Render .mmd -> vector PDF (for LaTeX) + high-DPI PNG (for preview),
// using the repo's existing Playwright Chromium and a locally-downloaded
// mermaid UMD bundle. No network at render time, no mermaid-cli install.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const MERMAID = fs.readFileSync(path.join(HERE, 'mermaid10.js'), 'utf8');
const SRC = path.join(HERE, 'diagrams');
const OUT = process.argv[2] || path.join(HERE, 'rendered');
fs.mkdirSync(OUT, { recursive: true });

const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.mmd'));
const browser = await chromium.launch();

for (const f of files) {
  const name = path.basename(f, '.mmd');
  const code = fs.readFileSync(path.join(SRC, f), 'utf8');
  const page = await browser.newPage({ viewport: { width: 2200, height: 1600 } });

  await page.setContent(`<!doctype html><html><head><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;background:#fff;}
  #wrap{display:inline-block;padding:6px;}
  .mermaid svg{display:block;}
  /* Font sizes are set through mermaid's own config, NOT here: mermaid measures
     label boxes at render time, so enlarging text afterwards clips clusters. */
  .mermaid .cluster-label .nodeLabel{font-weight:600;}
</style></head>
<body><div id="wrap"><div class="mermaid" id="d"></div></div>
<script>${MERMAID}</script>
<script>
  window.__done = (async () => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'loose',
      theme: 'base',
      fontFamily: 'Arial, Helvetica, sans-serif',
      themeVariables: { fontSize: '19px', primaryColor:'#EAF0F9', lineColor:'#14161E',
                        textColor:'#14161E', primaryTextColor:'#14161E' },
      flowchart: { htmlLabels: true, curve: 'basis', nodeSpacing: 42, rankSpacing: 52,
                   padding: 10, useMaxWidth: false },
      sequence: { useMaxWidth: false, actorFontSize: 19, noteFontSize: 18, messageFontSize: 18,
                  boxMargin: 12, width: 190 }
    });
    const { svg } = await mermaid.render('g', ${JSON.stringify(code)});
    document.getElementById('d').innerHTML = svg;
    const s = document.querySelector('#d svg');
    s.removeAttribute('style'); s.style.maxWidth='none';
    const vb = s.viewBox.baseVal;
    s.setAttribute('width', vb.width); s.setAttribute('height', vb.height);
    return { w: vb.width, h: vb.height };
  })();
</script></body></html>`, { waitUntil: 'load' });

  const box = await page.evaluate(() => window.__done);
  const wrap = await page.locator('#wrap').boundingBox();

  // Vector PDF, page sized exactly to the diagram (72 CSS px = 1 in).
  await page.pdf({
    path: path.join(OUT, `${name}.pdf`),
    width: `${(wrap.width / 96) * 1.0}in`,
    height: `${(wrap.height / 96) * 1.0}in`,
    printBackground: true,
    margin: { top: '0', bottom: '0', left: '0', right: '0' },
    pageRanges: '1',
  });

  // PNG preview at 3x for anyone reading the bundle outside LaTeX.
  const png = await browser.newPage({
    viewport: { width: Math.ceil(wrap.width) + 12, height: Math.ceil(wrap.height) + 12 },
    deviceScaleFactor: 3,
  });
  await png.setContent(await page.content(), { waitUntil: 'load' });
  await png.waitForTimeout(400);
  await png.locator('#wrap').screenshot({ path: path.join(OUT, `${name}.png`) });
  await png.close();

  console.log(`${name}: ${Math.round(box.w)}x${Math.round(box.h)} css px -> pdf + png`);
  await page.close();
}

await browser.close();
