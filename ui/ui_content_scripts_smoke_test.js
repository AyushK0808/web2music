/**
 * Simulates exactly how Chrome loads content_scripts: multiple classic
 * <script> files evaluated in order, sharing one window/document. Catches
 * load-order bugs, missing globals, or reference errors before testing in
 * a real browser.
 *
 * Run: node ui_content_scripts_smoke_test.js
 */
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SAMPLE_HTML = `<!DOCTYPE html>
<html lang="en"><head><title>Test Article</title>
<meta name="description" content="A sample article for smoke testing.">
</head><body style="background-color: rgb(200,210,220)">
<article><p>This is a sample paragraph with enough words to count as real
content for the extractor to find and process during this smoke test run.</p>
<p>A second paragraph adds more text so word count and readability scoring
have something real to work with, rather than an empty or trivial page.</p>
</article>
</body></html>`;

const dom = new JSDOM(SAMPLE_HTML, {
  url: "https://example.com/test-article",
  runScripts: "outside-only",
});
const { window } = dom;

// getBoundingClientRect isn't implemented in jsdom -- stub it, matching the
// data-extraction/playground.js pattern
window.Element.prototype.getBoundingClientRect = function () {
  return { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 };
};
window.innerWidth = 1280;
window.innerHeight = 800;

const UI_DIR = path.join(__dirname, "..", "ui");
const FILES_IN_MANIFEST_ORDER = [
  "lib/feature_a/Textextractor.js",
  "lib/feature_a/Colorextractor.js",
  "lib/feature_a/Readability.js",
  "lib/feature_a/behaviorTracker.js",
  "lib/feature_a/pageData.js",
];

const vmContext = dom.getInternalVMContext();

console.log("Loading files in the exact order manifest.json specifies...\n");
for (const relPath of FILES_IN_MANIFEST_ORDER) {
  const fullPath = path.join(UI_DIR, relPath);
  if (!fs.existsSync(fullPath)) {
    console.error(`FAIL: ${relPath} does not exist. Run 'cd ui && ./sync-libs.sh' first.`);
    process.exit(1);
  }
  const source = fs.readFileSync(fullPath, "utf8");
  try {
    vm.runInContext(source, vmContext, { filename: relPath });
    console.log(`  OK   ${relPath}`);
  } catch (err) {
    console.error(`  FAIL ${relPath}: ${err.message}`);
    process.exit(1);
  }
}

console.log("\nChecking expected window globals were set...");
const expectedGlobals = [
  "Web2MusicTextExtractor", "Web2MusicColorExtractor", "Web2MusicReadability",
  "Web2MusicBehaviorTracker", "Web2MusicPageData",
];
let allPresent = true;
for (const g of expectedGlobals) {
  const present = Boolean(window[g]);
  console.log(`  ${present ? "OK  " : "MISSING"} window.${g}`);
  if (!present) allPresent = false;
}
if (!allPresent) {
  console.error("\nFAIL: one or more expected globals were not set.");
  process.exit(1);
}

console.log("\nCalling window.Web2MusicPageData.buildPageData() (as content.js would)...");
(async () => {
  try {
    const behaviorTracker = window.Web2MusicBehaviorTracker.getDefaultTracker();
    const pageData = await window.Web2MusicPageData.buildPageData({
      doc: window.document,
      behaviorTracker,
    });

    console.log("\nResult:");
    console.log("  title:      ", pageData.title);
    console.log("  wordCount:  ", pageData.wordCount);
    console.log("  lang:       ", pageData.lang);
    console.log("  colors:     ", JSON.stringify(pageData.colors));
    console.log("  embedding:  ", pageData.embedding, "(expected: empty array -- embedding backend not loaded, by design)");

    if (!pageData.title || pageData.wordCount === 0) {
      console.error("\nFAIL: buildPageData() ran without throwing, but returned suspiciously empty data.");
      process.exit(1);
    }

    console.log("\nPASS -- content.js's real extraction pipeline works end-to-end.");
    process.exit(0);
  } catch (err) {
    console.error("\nFAIL: buildPageData() threw:", err);
    process.exit(1);
  }
})();
