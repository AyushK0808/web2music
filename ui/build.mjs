// ui/build.mjs — esbuild bundler for the Web2Music extension.
//
// Three bundles + a worker, per the X4 integration plan:
//   content.entry.js    -> dist/content.js       (iife, page-origin content script)
//   background.entry.js -> dist/background.js    (esm, MV3 service worker)
//   offscreen.entry.js  -> dist/offscreen.js      (iife, extension-origin offscreen doc)
//   embed.worker.js     -> dist/embed.worker.js   (iife, spawned by the offscreen doc)
//
// Static assets (manifest, html, Tone.js, models/onnx) are copied verbatim —
// load unpacked from ui/dist/, not ui/.

import * as esbuild from "esbuild";
import { cpSync, mkdirSync, existsSync, rmSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "src");
const DIST = path.join(__dirname, "dist");

const watch = process.argv.includes("--watch");

const entries = [
  { in: path.join(SRC, "content.entry.js"), out: "content", format: "iife" },
  { in: path.join(SRC, "background.entry.js"), out: "background", format: "esm" },
  { in: path.join(SRC, "offscreen.entry.js"), out: "offscreen", format: "iife" },
  { in: path.join(SRC, "embed.worker.js"), out: "embed.worker", format: "iife" },
];

function copyStaticAssets() {
  mkdirSync(DIST, { recursive: true });

  cpSync(path.join(__dirname, "manifest.json"), path.join(DIST, "manifest.json"));
  for (const html of ["popup.html", "offscreen.html"]) {
    cpSync(path.join(__dirname, html), path.join(DIST, html));
  }

  // popup.js is a classic script (popup.html loads it with a plain
  // <script src>, no type="module") with no imports, so it is copied
  // verbatim rather than bundled. Missing it doesn't fail the build or log
  // anything — it 404s at runtime and the popup silently keeps its static
  // HTML placeholders ("—", "Extracting Styles") with every control inert,
  // which reads exactly like a broken audio pipeline. Hence the assertion
  // in verifyReferencedAssets below.
  cpSync(path.join(__dirname, "popup.js"), path.join(DIST, "popup.js"));

  mkdirSync(path.join(DIST, "assets"), { recursive: true });
  cpSync(path.join(__dirname, "assets", "Tone.js"), path.join(DIST, "assets", "Tone.js"));

  // Feature A's DOM extractors are loaded as plain classic scripts (see
  // manifest.json's content_scripts array), not bundled/imported — they use
  // a `typeof module !== 'undefined'` UMD check to decide whether to attach
  // to `window`, and esbuild's CJS interop would define `module` in scope
  // for anything pulled in via import/require, silently taking the wrong
  // branch and never setting window.Web2Music*. Copied verbatim instead.
  const dataExtractionDir = path.join(__dirname, "..", "data-extraction");
  mkdirSync(path.join(DIST, "vendor"), { recursive: true });
  for (const f of ["Textextractor.js", "Colorextractor.js", "Readability.js", "behaviorTracker.js", "pageData.js", "VectorStore.js"]) {
    cpSync(path.join(dataExtractionDir, f), path.join(DIST, "vendor", f));
  }

  // Vendored ONNX runtime + MiniLM model — see models/README.md for the
  // download step if these directories don't exist yet on a fresh checkout.
  for (const dir of ["onnx", "models"]) {
    const from = path.join(__dirname, dir);
    if (existsSync(from)) {
      cpSync(from, path.join(DIST, dir), { recursive: true });
    } else {
      console.warn(`[build] ui/${dir}/ not found — skipping copy (see ui/models/README.md)`);
    }
  }
}

// Every local src= / href= in the emitted HTML must exist in dist. A missing
// one is invisible at build time and only shows up as a dead UI at runtime.
function verifyReferencedAssets() {
  const missing = [];
  for (const html of ["popup.html", "offscreen.html"]) {
    const file = path.join(DIST, html);
    if (!existsSync(file)) { missing.push(html); continue; }
    const source = readFileSync(file, "utf8");
    for (const m of source.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)) {
      const ref = m[1];
      if (/^(https?:|data:|#|\/\/)/.test(ref)) continue;
      if (!existsSync(path.join(DIST, ref.split(/[?#]/)[0]))) missing.push(`${html} -> ${ref}`);
    }
  }
  if (missing.length) {
    throw new Error(`[build] dist is missing assets referenced by HTML:\n  ${missing.join("\n  ")}`);
  }
}

async function build() {
  if (!watch && existsSync(DIST)) {
    rmSync(DIST, { recursive: true, force: true });
  }
  copyStaticAssets();

  const contexts = await Promise.all(
    entries.map((e) =>
      esbuild.context({
        entryPoints: [e.in],
        outfile: path.join(DIST, `${e.out}.js`),
        bundle: true,
        format: e.format,
        target: "chrome110",
        sourcemap: true,
        logLevel: "info",
      })
    )
  );

  if (watch) {
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log("[build] watching for changes...");
  } else {
    await Promise.all(contexts.map((ctx) => ctx.rebuild()));
    await Promise.all(contexts.map((ctx) => ctx.dispose()));
    verifyReferencedAssets();
    console.log("[build] done -> ui/dist/");
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
