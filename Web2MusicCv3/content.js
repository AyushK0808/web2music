// ─────────────────────────────────────────────────────────────────────────────
// content.js  –  DOM Signal Extractor
// ─────────────────────────────────────────────────────────────────────────────

// Use a timestamp-based cooldown instead of a boolean flag.
// This allows background.js to re-inject this script (when toggle turns on)
// without it being silently blocked, while still preventing double-fires on
// normal page loads within the same 2-second window.
const now = Date.now();
if (!window.__adaptiveAudioLastRan || (now - window.__adaptiveAudioLastRan) > 2000) {
  window.__adaptiveAudioLastRan = now;

  function extractPageData() {
    const text = document.body?.innerText?.slice(0, 2000) ?? "";
    const title = document.title;
    const url = window.location.href;
    const metaDesc = document.querySelector('meta[name="description"]')?.content ?? "";
    const paragraphCount = document.querySelectorAll("p").length;
    const imageCount = document.querySelectorAll("img").length;
    const videoCount = document.querySelectorAll("video, iframe[src*='youtube'], iframe[src*='vimeo']").length;
    const bodyBg = window.getComputedStyle(document.body).backgroundColor;
    return { url, title, metaDesc, text,
      structure: { paragraphCount, imageCount, videoCount },
      style: { bodyBg } };
  }

  // Small delay so the page has settled; re-injection skips this since page is already loaded
  const delay = document.readyState === "complete" ? 0 : 1500;
  setTimeout(() => {
    const pageData = extractPageData();
    console.log("[content] Sending page data to background");
    chrome.runtime.sendMessage({ type: "PAGE_DATA", data: pageData })
      .catch((err) => console.warn("[content] Could not send page data:", err.message));
  }, delay);
}