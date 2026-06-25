// ─────────────────────────────────────────────────────────────────────────────
// popup.js  –  Web2Music Popup Logic
// ─────────────────────────────────────────────────────────────────────────────

// ── DOM refs ──────────────────────────────────────────────────────────────────

const toggleEnabled  = document.getElementById("toggleEnabled");
const btnPlayPause   = document.getElementById("btnPlayPause");
const volumeSlider   = document.getElementById("volumeSlider");
const volPctLabel    = document.getElementById("volPctLabel");

const pageCard       = document.getElementById("pageCard");
const pageFavicon    = document.getElementById("pageFavicon");
const pageTitle      = document.getElementById("pageTitle");
const pageUrl        = document.getElementById("pageUrl");
const pageStatusTag  = document.getElementById("pageStatusTag");
const dashRect       = document.getElementById("dashRect");

// ── Dash border: fit SVG rect to card size after render ───────────────────────

function fitDashBorder() {
  const card = pageCard;
  const w = card.offsetWidth;
  const h = card.offsetHeight;
  dashRect.setAttribute("width",  w - 2);
  dashRect.setAttribute("height", h - 2);
}

// ── Favicon colour extraction ─────────────────────────────────────────────────
// Loads favicon into an offscreen canvas, samples a few pixels, derives
// a light tinted background and a slightly deeper border colour.

function extractFaviconColors(imgEl, callback) {
  const size = 32;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");

  try {
    ctx.drawImage(imgEl, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size).data;

    let r = 0, g = 0, b = 0, count = 0;
    // Sample every 4th pixel, skip near-white/transparent ones
    for (let i = 0; i < data.length; i += 16) {
      const a = data[i + 3];
      const pr = data[i], pg = data[i + 1], pb = data[i + 2];
      const brightness = (pr + pg + pb) / 3;
      if (a < 30 || brightness > 230) continue; // skip transparent / white
      r += pr; g += pg; b += pb; count++;
    }

    if (count === 0) { callback(null); return; }

    r = Math.round(r / count);
    g = Math.round(g / count);
    b = Math.round(b / count);

    // Light tinted card bg: mix dominant colour with white at ~8% opacity
    const bgR = Math.round(r * 0.08 + 255 * 0.92);
    const bgG = Math.round(g * 0.08 + 255 * 0.92);
    const bgB = Math.round(b * 0.08 + 255 * 0.92);

    // Border: dominant colour lightened to ~65% lightness
    const borderR = Math.round(r * 0.55 + 255 * 0.45);
    const borderG = Math.round(g * 0.55 + 255 * 0.45);
    const borderB = Math.round(b * 0.55 + 255 * 0.45);

    callback({
      // bg:     `rgb(${bgR},${bgG},${bgB})`,
      border: `rgb(${borderR},${borderG},${borderB})`,
    });
  } catch {
    // cross-origin canvas taint — fall back to defaults
    callback(null);
  }
}

function applyCardColors(colors) {
  if (!colors) return;
  pageCard.style.background = colors.bg;
  dashRect.setAttribute("stroke", colors.border);
  fitDashBorder();
}

// ── Canvas Visualizer ─────────────────────────────────────────────────────────

const canvas = document.getElementById("visualizer");
const ctx    = canvas.getContext("2d");
let fftData  = new Array(64).fill(-100);

function drawVisualizer() {
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const bars   = 56;
  const gap    = 6;
  const barW   = (W - (bars - 1) * gap) / bars;
  const minDb  = -100, maxDb = -10;
  const midX   = W / 2;
  const fftLen = fftData.length;

  for (let i = 0; i < bars; i++) {
    // Map bar index evenly across the full FFT array using floating point
    const fftPos = (i / (bars - 1)) * (fftLen - 1);
    const lo     = Math.floor(fftPos);
    const hi     = Math.min(lo + 1, fftLen - 1);
    const t      = fftPos - lo;
    // Linear interpolate between adjacent buckets — smooth, even distribution
    const db     = (fftData[lo] ?? minDb) * (1 - t) + (fftData[hi] ?? minDb) * t;

    const norm   = Math.max(0, Math.min(1, (db - minDb) / (maxDb - minDb)));
    const barH   = Math.max(barW, norm * H * 0.88); // min = barW so it stays a pill at silence
    const x      = i * (barW + gap);
    const y      = H / 2 - barH / 2; // always vertically centered

    // Fade toward edges
    const distFromMid = Math.abs((x + barW / 2) - midX) / midX;
    const alpha       = 0.3 + (1 - distFromMid) * 0.7;
    const lightness   = 38 + norm * 20;

    ctx.globalAlpha = alpha;
    ctx.fillStyle   = `hsl(214, 85%, ${lightness}%)`;
    ctx.beginPath();
    ctx.roundRect(x, y, barW, barH, barW / 2); // full capsule radius
    ctx.fill();
  }

  ctx.globalAlpha = 1;
  requestAnimationFrame(drawVisualizer);
}

drawVisualizer();

// ── Volume ────────────────────────────────────────────────────────────────────

const sliderFill      = document.getElementById("sliderFill");
const sliderIndicator = document.getElementById("sliderIndicator");

function updateSliderFill(val) {
  sliderFill.style.width = val + "%";
  volPctLabel.textContent = val + "%";
}

updateSliderFill(parseInt(volumeSlider.value));

volumeSlider.addEventListener("input", (e) => {
  const val = parseInt(e.target.value);
  updateSliderFill(val);
  chrome.runtime.sendMessage({ type: "POPUP_VOLUME", value: val / 100 });
});

// ── Toggle ────────────────────────────────────────────────────────────────────

toggleEnabled.addEventListener("change", () => {
  const enabled = toggleEnabled.checked;

  chrome.runtime.sendMessage({ type: "POPUP_SET_ENABLED", enabled });

  if (!enabled) {
    isPlaying = false;
    fftData = new Array(64).fill(-100);
    renderPageStatus("stopped");   // toggle off = fully stopped
  } else {
    isPlaying = true;
    renderPageStatus("playing");   // toggle on = restarting
  }
});

// ── Status ────────────────────────────────────────────────────────────────────

let isPlaying = false;

function renderPageStatus(status) {
  pageCard.className = "page-card";

  switch (status) {
    case "playing":
      pageStatusTag.textContent = "Playing";
      pageCard.classList.add("status-playing");
      btnPlayPause.innerHTML = "⏸";
      btnPlayPause.title = "Pause";
      break;
    case "loading":
      pageStatusTag.textContent = "Extracting Styles";
      btnPlayPause.innerHTML = "▶";
      break;
    case "paused":
      pageStatusTag.textContent = "Paused";
      btnPlayPause.innerHTML = "▶";
      btnPlayPause.title = "Resume";
      break;
    case "error":
      pageStatusTag.textContent = "Error";
      pageCard.classList.add("status-error");
      btnPlayPause.innerHTML = "▶";
      break;
    default:
      pageStatusTag.textContent = "Stopped";
      btnPlayPause.innerHTML = "▶";
      btnPlayPause.title = "Play";
  }
}

// ── Page info renderer ────────────────────────────────────────────────────────
// Accepts a tab object (with .title, .url, .favIconUrl) for best accuracy,
// or falls back to just a URL string.

function renderPageInfo(tabOrUrl) {
  let title, url, favIconUrl;

  if (typeof tabOrUrl === "object" && tabOrUrl !== null) {
    title      = tabOrUrl.title;
    url        = tabOrUrl.url;
    favIconUrl = tabOrUrl.favIconUrl;
  } else {
    url = tabOrUrl;
  }

  // ── Title: use actual tab title, fall back to hostname ───────────────────
  if (title && title.trim()) {
    pageTitle.textContent = title;
  } else if (url) {
    try { pageTitle.textContent = new URL(url).hostname; } catch { pageTitle.textContent = url; }
  }

  // ── URL display ──────────────────────────────────────────────────────────
  if (url) {
    pageUrl.textContent = url.length > 62 ? url.slice(0, 62) + "…" : url;
  }

  // ── Favicon: prefer browser-provided favIconUrl, fall back to Google ─────
  const hostname = (() => { try { return new URL(url).hostname; } catch { return null; } })();
  const faviconSrc = favIconUrl && favIconUrl.startsWith("http")
    ? favIconUrl
    : hostname
      ? `https://www.google.com/s2/favicons?sz=64&domain=${hostname}`
      : null;

  if (faviconSrc) {
    const img = new Image();
    img.crossOrigin = "anonymous";

    img.onload = () => {
      pageFavicon.innerHTML = "";
      const clone = img.cloneNode();
      clone.style.cssText = "width:100%;height:100%;object-fit:cover;border-radius:11px;";
      pageFavicon.appendChild(clone);

      // Extract colour from loaded image
      extractFaviconColors(img, (colors) => {
        applyCardColors(colors);
      });
    };

    img.onerror = () => {
      pageFavicon.textContent = "🌐";
      fitDashBorder();
    };

    img.src = faviconSrc;
  } else {
    pageFavicon.textContent = "🌐";
    fitDashBorder();
  }
}

// ── Messages ──────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  switch (msg.type) {
    case "STATUS_UPDATE":
      // Sync toggle if background explicitly changed isEnabled
      if (msg.isEnabled !== undefined) {
        toggleEnabled.checked = msg.isEnabled;
      }
      renderPageStatus(msg.status);
      // Keep isPlaying in sync with actual background state — this is what
      // makes the play/pause button send the right message on next click
      isPlaying = msg.status === "playing";
      break;
    case "ANALYSER_DATA":
      fftData = msg.fft;
      break;
  }
});

// ── Controls ──────────────────────────────────────────────────────────────────

btnPlayPause.addEventListener("click", () => {
  if (isPlaying) {
    chrome.runtime.sendMessage({ type: "POPUP_PAUSE" });
    isPlaying = false;
  } else {
    chrome.runtime.sendMessage({ type: "POPUP_PLAY" });
    isPlaying = true;
  }
});



// ── Init ──────────────────────────────────────────────────────────────────────

// First: get the actual active tab for title + favIconUrl
chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (tab) renderPageInfo(tab);
});

// Then sync playback state from background
chrome.runtime.sendMessage({ type: "GET_STATUS" }, (response) => {
  if (!response) return;

  // Sync the master toggle to whatever background says — this is the fix
  // that makes the toggle state survive tab switches and popup closes
  toggleEnabled.checked = response.isEnabled !== false; // default true if missing

  renderPageStatus(response.status);
  isPlaying = response.status === "playing";
});

// Fit dash border once layout settles
requestAnimationFrame(fitDashBorder);