// ui/src/content.entry.js — Feature A extraction driver.
//
// Runs after vendor/{Textextractor,Colorextractor,Readability,
// behaviorTracker,pageData}.js (see manifest.json's content_scripts array),
// which attach window.Web2MusicPageData etc. Only the embedding + vector
// store deps are overridden with remote proxies to the offscreen document —
// everything else in buildPageData runs locally, unchanged.

import { remoteEmbedding, remoteVectorStore } from "./remoteDeps.js";

// Module-scope re-injection guard: background.js can re-inject this script
// (POPUP_SET_ENABLED → toggle back on) without it being silently blocked by
// a stale flag, while still preventing double-fires within the same window.
const now = Date.now();
if (window.__w2mContentLastRan && now - window.__w2mContentLastRan < 2000) {
  // Re-injected within the debounce window of a normal load — skip entirely.
} else {
  window.__w2mContentLastRan = now;
  main();
}

function main() {
  const { createPageDataScheduler, getExtractionTelemetry } = window.Web2MusicPageData;

  const scheduler = createPageDataScheduler(
    {
      deps: { embedding: remoteEmbedding },
      vectorStore: remoteVectorStore,
    },
    { debounceMs: 300 }
  );

  async function runExtraction() {
    try {
      const pageData = await scheduler();
      chrome.runtime.sendMessage({
        type: "A_PAGE_DATA",
        pageData,
        telemetry: getExtractionTelemetry(),
      }).catch((err) => console.warn("[content] send failed:", err.message));
    } catch (err) {
      console.warn("[content] extraction failed:", err.message);
    }
  }

  // Initial run — document_idle means the page has already settled.
  runExtraction();

  // SPA navigation: Navigation API where available, history-patch fallback.
  if (typeof window.navigation !== "undefined" && window.navigation.addEventListener) {
    window.navigation.addEventListener("navigate", () => runExtraction());
  } else {
    for (const fn of ["pushState", "replaceState"]) {
      const orig = history[fn];
      history[fn] = function (...args) {
        const ret = orig.apply(this, args);
        runExtraction();
        return ret;
      };
    }
    window.addEventListener("popstate", () => runExtraction());
  }

  // Throttled MutationObserver — substantial DOM churn on an otherwise
  // static page (infinite scroll, client-rendered content swapping in)
  // re-triggers extraction, coalesced by the scheduler's own debounce.
  let mutationThrottle = null;
  const observer = new MutationObserver(() => {
    if (mutationThrottle) return;
    mutationThrottle = setTimeout(() => {
      mutationThrottle = null;
      runExtraction();
    }, 2000);
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
