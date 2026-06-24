// ─────────────────────────────────────────────────────────────────────────────
// content.js  –  DOM Signal Extractor (lightweight version for Feature C dev)
// Runs on every page, extracts key signals, sends to background.js
// Feature A will replace/enrich this with full signal extraction
// ─────────────────────────────────────────────────────────────────────────────

// Only run once per page navigation
if (!window.__adaptiveAudioRan) {
  window.__adaptiveAudioRan = true;

  function extractPageData() {
    const text = document.body?.innerText?.slice(0, 2000) ?? ""; // first 2000 chars
    const title = document.title;
    const url = window.location.href;
    const metaDesc = document.querySelector('meta[name="description"]')?.content ?? "";

    // Basic structural signals (Feature A will make this richer)
    const paragraphCount = document.querySelectorAll("p").length;
    const imageCount = document.querySelectorAll("img").length;
    const videoCount = document.querySelectorAll("video, iframe[src*='youtube'], iframe[src*='vimeo']").length;

    // Dominant bg color (rough approximation)
    const bodyBg = window.getComputedStyle(document.body).backgroundColor;

    return {
      url,
      title,
      metaDesc,
      text,
      structure: {
        paragraphCount,
        imageCount,
        videoCount,
      },
      style: {
        bodyBg,
      },
    };
  }

  // Wait for page to settle a bit before extracting
  setTimeout(() => {
    const pageData = extractPageData();
    console.log("[content] Sending page data to background");

    chrome.runtime.sendMessage({
      type: "PAGE_DATA",
      data: pageData,
    }).catch((err) => {
      console.warn("[content] Could not send page data:", err.message);
    });
  }, 1500);
}
