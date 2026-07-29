/*
 * globals_test.js — guards a class of bug Node structurally cannot catch.
 *
 * Every module here is loaded as a content script into the SAME page global
 * scope. Two files declaring `const DEFAULT_CONFIG` at top level is therefore a
 * SyntaxError that breaks ALL of Feature A — but under CommonJS each file gets
 * its own scope, so `npm test` and `npm run play` pass happily and only a real
 * browser fails.
 *
 * That exact bug shipped once (VectorStore.js vs Embeddingmodel.js, both
 * `DEFAULT_CONFIG`) and was caught only by loading the modules into Chrome. This
 * test makes it a one-second check instead.
 *
 * Two things are verified:
 *   1. No two modules declare the same top-level name.
 *   2. Concatenating all modules and evaluating them actually parses and runs,
 *      which is the closest cheap analogue of the content-script environment.
 *
 * Run: npm test
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Load order must match the extension's content-script order (deps first).
const MODULES = [
  'Textextractor.js',
  'Colorextractor.js',
  'Embeddingmodel.js',
  'Readability.js',
  'behaviorTracker.js',
  'VectorStore.js',
  'pageData.js',
];

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/*
 * Top-level declarations only: a line that starts at column 0 with
 * const/let/var/function/class. Anything indented is inside a block or function
 * and cannot collide across files.
 */
function topLevelNames(source) {
  const names = [];
  const pattern = /^(?:const|let|var|function|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/;
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(pattern);
    if (match) names.push(match[1]);
  }
  return names;
}

console.log(`\n${'─'.repeat(70)}\nContent-script global scope (shared by all modules)\n${'─'.repeat(70)}`);

const sources = new Map();
for (const name of MODULES) {
  const file = path.join(__dirname, name);
  check(`${name} exists`, fs.existsSync(file));
  if (fs.existsSync(file)) sources.set(name, fs.readFileSync(file, 'utf8'));
}

// 1) Cross-module top-level name collisions.
const owners = new Map(); // name → [files]
for (const [file, source] of sources) {
  for (const declared of topLevelNames(source)) {
    if (!owners.has(declared)) owners.set(declared, []);
    if (!owners.get(declared).includes(file)) owners.get(declared).push(file);
  }
}

const collisions = [...owners.entries()].filter(([, files]) => files.length > 1);
check('no two modules declare the same top-level name',
  collisions.length === 0,
  collisions.map(([n, files]) => `${n} in ${files.join(' + ')}`).join('; '));

// 2) Duplicate declarations *within* a single file would also throw.
for (const [file, source] of sources) {
  const declared = topLevelNames(source);
  const dupes = declared.filter((n, i) => declared.indexOf(n) !== i);
  check(`${file} has no duplicate top-level names`,
    dupes.length === 0, [...new Set(dupes)].join(', '));
}

// 3) The real check: concatenate and evaluate, as the browser effectively does.
console.log(`\n${'─'.repeat(70)}\nConcatenated evaluation (parses + runs as one scope)\n${'─'.repeat(70)}`);

const combined = MODULES.map(n => sources.get(n) || '').join('\n;\n');

// Minimal browser-ish surface. Enough for module top-level code (which mostly
// registers window globals); nothing here needs a real DOM.
const fakeWindow = {
  addEventListener() {}, removeEventListener() {},
  setInterval: () => ({ unref() {} }), clearInterval() {},
  location: { href: 'https://example.test/' },
};
fakeWindow.window = fakeWindow;

const sandbox = {
  window: fakeWindow,
  document: { title: '', body: null, querySelector: () => null, querySelectorAll: () => [] },
  performance: { now: () => 0 },
  setInterval: () => ({ unref() {} }),
  clearInterval() {},
  setTimeout() {}, clearTimeout() {},
  console: { log() {}, warn() {}, error() {} },
  // Deliberately absent: `module`, so each file takes its BROWSER branch and
  // registers on window — matching the content-script path, not the Node one.
};

let evalError = null;
try {
  vm.createContext(sandbox);
  vm.runInContext(combined, sandbox, { timeout: 5000 });
} catch (err) {
  evalError = err;
}

check('all modules evaluate together without error',
  evalError === null,
  evalError && `${evalError.name}: ${evalError.message}`);

// 4) Each module should have registered its browser global.
const EXPECTED_GLOBALS = [
  'Web2MusicTextExtractor',
  'Web2MusicColorExtractor',
  'Web2MusicEmbedding',
  'Web2MusicReadability',
  'Web2MusicBehaviorTracker',
  'Web2MusicVectorStore',
  'Web2MusicPageData',
];

if (!evalError) {
  for (const name of EXPECTED_GLOBALS) {
    check(`window.${name} registered`, Boolean(fakeWindow[name]));
  }
  // pageData resolves its dependencies from these globals in the browser, so a
  // missing one means a silently degraded stage rather than a crash.
  check('pageData can see the vector store',
    Boolean(fakeWindow.Web2MusicVectorStore &&
            typeof fakeWindow.Web2MusicVectorStore.createVectorStore === 'function'));
}

console.log(`\n${'═'.repeat(70)}`);
console.log(`${passed} passed, ${failed} failed`);
console.log('═'.repeat(70));
if (failed > 0) process.exit(1);
