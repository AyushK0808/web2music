// ui/src/content.entry.js — Feature A extraction driver.
//
// Runs after vendor/{Textextractor,Colorextractor,Readability,
// behaviorTracker,pageData}.js (see manifest.json's content_scripts array),
// which attach window.Web2MusicPageData etc. Only the embedding + vector
// store deps are overridden with remote proxies to the offscreen document —
// everything else in buildPageData runs locally, unchanged.

import { remoteEmbedding, remoteVectorStore } from "./remoteDeps.js";
import { createLogger } from "./log.js";

const log = createLogger("content");

// Module-scope re-injection guard: background.js can re-inject this script
// (POPUP_SET_ENABLED → toggle back on) without it being silently blocked by
// a stale flag, while still preventing double-fires within the same window.
const now = Date.now();
if (window.__w2mContentLastRan && now - window.__w2mContentLastRan < 2000) {
  // Re-injected within the debounce window of a normal load — skip entirely.
  log.debug("re-injected within 2s of the last run — skipping");
} else {
  window.__w2mContentLastRan = now;
  main();
}

function main() {
  log.info("content script running on", location.href);

  // The vendor scripts attach these to window; if the manifest's
  // content_scripts order ever changes, this is undefined and main() throws
  // with a destructuring error that says nothing about the real cause.
  if (!window.Web2MusicPageData) {
    log.error("window.Web2MusicPageData is undefined — vendor/pageData.js did not load "
      + "before content.js. Check manifest.json's content_scripts order.");
    return;
  }

  const { createPageDataScheduler, getExtractionTelemetry } = window.Web2MusicPageData;

  const scheduler = createPageDataScheduler(
    {
      deps: { embedding: remoteEmbedding },
      vectorStore: remoteVectorStore,
    },
    { debounceMs: 300 }
  );

  let extractionCount = 0;
  async function runExtraction(trigger) {
    const n = ++extractionCount;
    const done = log.time(`extraction #${n} (${trigger})`);
    try {
      const pageData = await scheduler();
      done(`-> ${pageData?.text?.length ?? pageData?.content?.length ?? "?"} chars`);
      log.debug("sending A_PAGE_DATA", { url: pageData?.url, telemetry: getExtractionTelemetry() });
      chrome.runtime.sendMessage({
        type: "A_PAGE_DATA",
        pageData,
        telemetry: getExtractionTelemetry(),
      }).catch((err) => log.warn("send failed:", err.message,
        "— the service worker may have been torn down; it restarts on the next event"));
    } catch (err) {
      log.warn(`extraction #${n} (${trigger}) failed:`, err.message);
    }
  }

  // Initial run — document_idle means the page has already settled.
  runExtraction("initial");

  // SPA navigation: Navigation API where available, history-patch fallback.
  if (typeof window.navigation !== "undefined" && window.navigation.addEventListener) {
    log.debug("SPA navigation: using the Navigation API");
    window.navigation.addEventListener("navigate", () => runExtraction("navigate"));
  } else {
    log.debug("SPA navigation: falling back to history patching");
    for (const fn of ["pushState", "replaceState"]) {
      const orig = history[fn];
      history[fn] = function (...args) {
        const ret = orig.apply(this, args);
        runExtraction(fn);
        return ret;
      };
    }
    window.addEventListener("popstate", () => runExtraction("popstate"));
  }

  // Throttled MutationObserver — substantial DOM churn on an otherwise
  // static page (infinite scroll, client-rendered content swapping in)
  // re-triggers extraction, coalesced by the scheduler's own debounce.
  let mutationThrottle = null;
  const observer = new MutationObserver(() => {
    if (mutationThrottle) return;
    mutationThrottle = setTimeout(() => {
      mutationThrottle = null;
      runExtraction("mutation");
    }, 2000);
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
