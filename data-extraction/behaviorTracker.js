/*
 * behaviorTracker.js — Feature A browsing-behaviour capture.
 *
 * Feature A's Handoff 1 is defined as "text, embedding, colours, behaviour",
 * and Feature B's B2 weights mood heavily on scrollSpeed / cursorSpeed
 * (scroll > 800 px/s → energetic, < 100 → calm; cursor > 600 → restless).
 * Until now that signal only existed as a throwaway prototype on B's side
 * (manual_tests/signal_capture_test.html) — this module is the real,
 * reusable content-script implementation of it.
 *
 * It is STATEFUL: attach throttled scroll/mousemove listeners once, then let
 * buildPageData() snapshot the current rolling speeds whenever it assembles a
 * Handoff. Throttle caps mirror B's prototype (spec edge case #22):
 *   - mousemove ≤ 20 events/sec (50 ms)
 *   - scroll    ≤ 10 events/sec (100 ms)
 * Speeds are averaged over a sliding window of the last N readings and decay
 * back to 0 shortly after the user goes idle, so a snapshot taken while the
 * page is still reflects "not moving" rather than a stale burst.
 *
 * Usage (browser / content script):
 *   const tracker = createBehaviorTracker();
 *   tracker.start();
 *   ...
 *   const { scrollSpeed, cursorSpeed } = tracker.snapshot();
 *
 * A lazily-started default singleton is exported for the common case.
 */

const DEFAULTS = {
  mouseThrottleMs: 50,   // ≤ 20 events/sec
  scrollThrottleMs: 100, // ≤ 10 events/sec
  windowSize: 5,         // sliding average over last N readings
  idleResetMs: 500,      // clear readings this long after last event
};

function now() {
  return (typeof performance !== 'undefined' && performance.now)
    ? performance.now()
    : Date.now();
}

function createBehaviorTracker(userConfig = {}) {
  const config = { ...DEFAULTS, ...userConfig };

  const state = {
    running: false,
    // cursor
    lastMouseX: null,
    lastMouseY: null,
    lastMouseTime: null,
    lastMouseEventTime: 0,
    cursorReadings: [],
    // scroll
    lastScrollY: 0,
    lastScrollTime: 0,
    lastScrollEventTime: 0,
    scrollReadings: [],
  };

  const avg = (arr) =>
    arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

  const pushReading = (arr, value) => {
    arr.push(value);
    if (arr.length > config.windowSize) arr.shift();
  };

  function onMouseMove(e) {
    const t = now();
    if (t - state.lastMouseEventTime < config.mouseThrottleMs) return; // throttle
    state.lastMouseEventTime = t;

    if (state.lastMouseX !== null) {
      const dx = e.clientX - state.lastMouseX;
      const dy = e.clientY - state.lastMouseY;
      const dt = (t - state.lastMouseTime) / 1000;
      if (dt > 0) {
        pushReading(state.cursorReadings, Math.sqrt(dx * dx + dy * dy) / dt);
      }
    }
    state.lastMouseX = e.clientX;
    state.lastMouseY = e.clientY;
    state.lastMouseTime = t;
  }

  function onScroll() {
    const t = now();
    if (t - state.lastScrollEventTime < config.scrollThrottleMs) return; // throttle
    state.lastScrollEventTime = t;

    const currentY = (typeof window !== 'undefined' && window.scrollY) || 0;
    const dy = Math.abs(currentY - state.lastScrollY);
    const dt = (t - state.lastScrollTime) / 1000;
    if (dt > 0) {
      pushReading(state.scrollReadings, dy / dt);
    }
    state.lastScrollY = currentY;
    state.lastScrollTime = t;
  }

  function decayTick() {
    const t = now();
    if (t - state.lastMouseEventTime > config.idleResetMs) {
      state.cursorReadings.length = 0;
    }
    if (t - state.lastScrollEventTime > config.idleResetMs) {
      state.scrollReadings.length = 0;
    }
  }

  let decayTimer = null;

  function start() {
    if (state.running) return api;
    if (typeof window === 'undefined') {
      // No DOM (e.g. Node test harness) — tracker stays a safe zero source.
      state.running = true;
      return api;
    }
    state.lastScrollY = window.scrollY || 0;
    state.lastScrollTime = now();
    window.addEventListener('mousemove', onMouseMove, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });
    decayTimer = setInterval(decayTick, config.idleResetMs);
    state.running = true;
    return api;
  }

  function stop() {
    if (!state.running) return api;
    if (typeof window !== 'undefined') {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('scroll', onScroll);
    }
    if (decayTimer) clearInterval(decayTimer);
    decayTimer = null;
    state.running = false;
    return api;
  }

  /**
   * snapshot — current rolling behaviour speeds in px/s. Always returns finite
   * numbers, so it's safe to spread straight into Handoff 1.
   */
  function snapshot() {
    return {
      scrollSpeed: Math.round(avg(state.scrollReadings)),
      cursorSpeed: Math.round(avg(state.cursorReadings)),
    };
  }

  const api = { start, stop, snapshot, config, _state: state };
  return api;
}

// Lazily-started default singleton for the common single-page case.
let _defaultTracker = null;
function getDefaultTracker() {
  if (!_defaultTracker) {
    _defaultTracker = createBehaviorTracker();
    if (typeof window !== 'undefined') _defaultTracker.start();
  }
  return _defaultTracker;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createBehaviorTracker, getDefaultTracker };
} else if (typeof window !== 'undefined') {
  window.Web2MusicBehaviorTracker = { createBehaviorTracker, getDefaultTracker };
}
