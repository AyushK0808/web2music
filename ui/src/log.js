// ui/src/log.js — shared console logger for the extension's three contexts
// (service worker, offscreen document, content script).
//
// Why this exists rather than bare console.log calls:
//
//   - MV3 service workers are killed after ~30s idle and silently restarted on
//     the next event. Without a per-context uptime stamp, a restart is
//     invisible in the console, and "state I set two minutes ago is gone" reads
//     as a bug in the state handling rather than as a normal worker teardown.
//     Every line carries +Nms since THIS context started, so a counter that
//     jumps back to +12ms is a restart, plainly.
//   - The pipeline spans four contexts (content -> worker -> offscreen, plus
//     Feature D over HTTP) that each log into a different DevTools console. A
//     consistent [tag] prefix makes the same filter work in all of them.
//
// debug() is gated on chrome.storage.local.debugLogging (default ON in this
// dev build) so the per-message firehose can be silenced without a rebuild:
//
//     chrome.storage.local.set({ debugLogging: false })
//
// info/warn/error are never gated — they are the lines you need when something
// has already gone wrong and you can't reproduce it on demand.

const START = Date.now();

let verbose = true;

// chrome.storage is async, so the first few lines of a context are logged
// before the flag resolves. Deliberate: losing the setting for ~1ms of startup
// is better than dropping the startup logs, which are the ones that explain a
// service-worker restart.
try {
  chrome.storage?.local?.get({ debugLogging: true }, ({ debugLogging }) => {
    verbose = debugLogging;
  });
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area === "local" && changes.debugLogging) verbose = changes.debugLogging.newValue;
  });
} catch {
  // Non-extension context (tests, plain page) — keep the default.
}

function uptime() {
  return `+${Date.now() - START}ms`;
}

/**
 * createLogger — one tagged logger per module.
 * @param {string} tag  e.g. "background", "offscreen", "featureD"
 */
export function createLogger(tag) {
  const prefix = `[${tag}]`;
  return {
    debug: (...args) => { if (verbose) console.log(prefix, uptime(), ...args); },
    info: (...args) => console.log(prefix, uptime(), ...args),
    warn: (...args) => console.warn(prefix, uptime(), ...args),
    error: (...args) => console.error(prefix, uptime(), ...args),

    /**
     * time — start a timer; the returned function logs the elapsed ms.
     *   const done = log.time("generate");
     *   ...
     *   done("cache=miss");   // -> [background] +812ms generate took 794ms cache=miss
     */
    time(label) {
      const t0 = Date.now();
      return (...args) => {
        console.log(prefix, uptime(), `${label} took ${Date.now() - t0}ms`, ...args);
        return Date.now() - t0;
      };
    },
  };
}
