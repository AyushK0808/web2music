#!/bin/bash
# sync-libs.sh — copies Feature B's real source, and the subset of Feature A
# needed for real page extraction, into ui/lib/ so the extension can use them
# directly.
#
# WHY THIS EXISTS: Chrome extensions are sandboxed to their own directory
# tree -- background.js/content.js cannot reference ../mood-classification/
# or ../data-extraction/ even though the files are compatible (Feature B is
# ESM, Feature A has a browser-global fallback), because those paths are
# outside the extension's root once Chrome loads ui/ as the unpacked
# extension. There's no bundler in this repo, so the pragmatic fix is a
# straight file copy into ui/lib/ rather than a build step. Both modules'
# internal imports/requires are relative within their own folder, so copying
# each directory whole preserves them correctly with zero path rewriting.
#
# Run this after any change to mood-classification/feature_b/ or the synced
# data-extraction/ files below, and before loading/testing the extension, or
# ui/lib/ will silently drift out of sync with the real source.
#
#   cd ui && ./sync-libs.sh

set -euo pipefail
cd "$(dirname "$0")"

echo "Syncing mood-classification/feature_b/ -> ui/lib/feature_b/ ..."
rm -rf lib/feature_b
mkdir -p lib
cp -r ../mood-classification/feature_b lib/feature_b

echo "Syncing Feature A extractors -> ui/lib/feature_a/ ..."
# Only the files content.js actually loads as content scripts. Not
# VectorStore.js/Embeddingmodel.js -- the real local embedding backend needs
# a bundled ML runtime (transformers.js) which isn't wired up yet;
# pageData.js's embedding step is safely guarded and just no-ops (empty
# vector) when window.Web2MusicEmbedding isn't present. See content.js.
mkdir -p lib/feature_a
for f in Textextractor.js Colorextractor.js Readability.js behaviorTracker.js pageData.js; do
  # Wrapped in an IIFE: these files have top-level const/let (written for
  # CommonJS/Node, never intended for repeated classic-script injection).
  # Content scripts share one global scope across re-injections without a
  # full page reload (e.g. Chrome's extension-reload-during-development
  # flow re-running content scripts into an already-open tab) -- a
  # top-level const/let throws "Identifier has already been declared" on
  # the second injection. Only the COPY here is wrapped, not the original
  # data-extraction/ source, so Feature A's own Node/CommonJS testing is
  # untouched.
  { echo "(function () {"; cat "../data-extraction/$f"; echo "})();"; } > "lib/feature_a/$f"
done

echo "Done."

