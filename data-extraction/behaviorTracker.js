const DEBOUNCE_MS = 100;

function scheduleIdle(fn, delayMs) {
  return setTimeout(() => {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(fn);
    } else {
      fn();
    }
  }, delayMs);
}

/**
 * Tracks scroll velocity, cursor speed, and click density for the current
 * page. Starts immediately on construction (content-script init) rather
 * than lazily on first event — otherwise the very first handoff to
 * Feature B always reports zero activity, even if the user has already
 * been engaged with the page.
 */
function createBehaviorTracker(target = window) {
  const state = {
    scrollVelocity: 0,   // px/sec
    cursorSpeed: 0,      // px/sec
    clickCount: 0,
    startedAt: Date.now(),
  };

  let lastScrollPos = target.scrollY || 0;
  let lastScrollT = Date.now();
  let scrollDebounceHandle = null;

  let lastMouseX = null;
  let lastMouseY = null;
  let lastMouseT = Date.now();
  let mouseDebounceHandle = null;

  /**
   * Scroll events do not bubble — only capture-phase listening on the
   * document sees scroll fire on descendant elements (nested scrollable
   * containers), not just window-level scroll. This also catches
   * horizontal scroll (scrollLeft) alongside vertical.
   */
  function handleScroll(evt) {
    if (scrollDebounceHandle) return;
    scrollDebounceHandle = scheduleIdle(() => {
      scrollDebounceHandle = null;

      const scrollTarget = evt.target === document || evt.target === window
        ? target
        : evt.target;

      const posY = scrollTarget.scrollY ?? scrollTarget.scrollTop ?? 0;
      const posX = scrollTarget.scrollX ?? scrollTarget.scrollLeft ?? 0;
      const pos = Math.hypot(posY, posX);

      const now = Date.now();
      const dt = Math.max(1, now - lastScrollT);
      const dPos = Math.abs(pos - lastScrollPos);

      state.scrollVelocity = (dPos / dt) * 1000;
      lastScrollPos = pos;
      lastScrollT = now;
    }, DEBOUNCE_MS);
  }

  function handleMouseMove(evt) {
    if (mouseDebounceHandle) return;
    mouseDebounceHandle = scheduleIdle(() => {
      mouseDebounceHandle = null;
      const now = Date.now();

      if (lastMouseX !== null) {
        const dt = Math.max(1, now - lastMouseT);
        const dx = evt.clientX - lastMouseX;
        const dy = evt.clientY - lastMouseY;
        const dist = Math.hypot(dx, dy);
        state.cursorSpeed = (dist / dt) * 1000;
      }

      lastMouseX = evt.clientX;
      lastMouseY = evt.clientY;
      lastMouseT = now;
    }, DEBOUNCE_MS);
  }

  function handleClick() {
    state.clickCount += 1;
  }

  function start() {
    // capture: true so nested scrollable containers, not just window, are seen
    target.addEventListener('scroll', handleScroll, { capture: true, passive: true });
    target.addEventListener('touchmove', handleScroll, { capture: true, passive: true });
    target.addEventListener('mousemove', handleMouseMove, { passive: true });
    target.addEventListener('click', handleClick, { capture: true });
  }

  function stop() {
    target.removeEventListener('scroll', handleScroll, { capture: true });
    target.removeEventListener('touchmove', handleScroll, { capture: true });
    target.removeEventListener('mousemove', handleMouseMove);
    target.removeEventListener('click', handleClick, { capture: true });
  }

  function getState() {
    return { ...state };
  }

  start(); // start at construction, not on first event

  return { start, stop, getState };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createBehaviorTracker };
} else if (typeof window !== 'undefined') {
  window.Web2MusicBehaviorTracker = { createBehaviorTracker };
}