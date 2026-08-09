// ui/src/audioTabs.js — "is the page the user is looking at already making
// noise?", and what our ambient bed should do about it.
//
// This replaces the domain-list ducking background.entry.js used to do
// inline. That list (youtube.com, spotify.com, ...) was wrong in both
// directions: it ducked the whole time someone was reading YouTube comments
// with nothing playing, and it stayed at full volume for the podcast player,
// news-site video embed, Twitch clip on an aggregator, or browser game that
// wasn't on the list. Chrome already tracks the ground truth per tab —
// `tab.audible` is true when a tab has produced sound in the last couple of
// seconds — so this keys off that instead and uses the domain list only as an
// anticipatory hint (see decideAttenuation).
//
// Policy, in one place so the paper can cite it and the tests can pin it:
//
//   active tab is audible            -> MUTE   (the user chose that audio;
//                                               ambient music must get out of
//                                               the way completely, not just
//                                               get quieter)
//   a background tab is audible      -> DUCK   (they're hearing something
//                                               else, but they didn't
//                                               foreground it — back off,
//                                               don't disappear)
//   active tab is a known media site
//   but silent so far                -> DUCK   (a video is one click away;
//                                               starting quiet avoids the
//                                               clash at the moment it starts)
//   otherwise                        -> CLEAR
//
// A tab that is audible *and* muted by the user (tab.mutedInfo.muted) is not
// producing anything anyone can hear, so it never counts — Chrome keeps
// reporting audible:true for it, and treating that as "audio is playing"
// would leave our music muted for as long as the tab stayed open.

export const ATTENUATION = {
  CLEAR: "clear",
  DUCK: "duck",
  MUTE: "mute",
};

/** duckGain value for each state — offscreen.entry.js ramps to these. */
export const ATTENUATION_GAIN = {
  [ATTENUATION.CLEAR]: 1.0,
  [ATTENUATION.DUCK]: 0.1,
  [ATTENUATION.MUTE]: 0.0,
};

/** Ordered least- to most-attenuating, so escalation/release can be compared. */
const SEVERITY = {
  [ATTENUATION.CLEAR]: 0,
  [ATTENUATION.DUCK]: 1,
  [ATTENUATION.MUTE]: 2,
};

/**
 * Sites where audio is the point of the visit. Only used to *anticipate* —
 * a media domain that is demonstrably silent gets a duck, never a mute, and
 * an audible tab anywhere else outranks it.
 */
export const MEDIA_DOMAINS = [
  "youtube.com",
  "spotify.com",
  "netflix.com",
  "twitch.tv",
  "soundcloud.com",
  "music.apple.com",
  "primevideo.com",
  "hotstar.com",
  "vimeo.com",
];

export function isMediaDomain(url) {
  return !!url && MEDIA_DOMAINS.some((d) => url.includes(d));
}

/**
 * isTabPlayingAudio — Chrome's own signal, minus the muted case.
 * @param {{audible?: boolean, mutedInfo?: {muted?: boolean}}} tab
 */
export function isTabPlayingAudio(tab) {
  if (!tab || !tab.audible) return false;
  return !tab.mutedInfo?.muted;
}

/**
 * decideAttenuation — pure policy function (no chrome APIs), so the table
 * above is unit-testable without a browser.
 *
 * @param {Object}   input
 * @param {number?}  input.activeTabId
 * @param {string?}  input.activeTabUrl
 * @param {Set<number>|number[]} input.playingTabIds  tabs currently producing
 *   audible, un-muted sound (active tab included, if it is one of them)
 * @returns {{ level: string, reason: string }}
 */
export function decideAttenuation({ activeTabId = null, activeTabUrl = null, playingTabIds = [] } = {}) {
  const playing = playingTabIds instanceof Set ? playingTabIds : new Set(playingTabIds);

  if (activeTabId != null && playing.has(activeTabId)) {
    return { level: ATTENUATION.MUTE, reason: "active tab is playing audio" };
  }
  if (playing.size > 0) {
    return { level: ATTENUATION.DUCK, reason: `${playing.size} background tab(s) playing audio` };
  }
  if (isMediaDomain(activeTabUrl)) {
    return { level: ATTENUATION.DUCK, reason: "active tab is a media site (silent so far)" };
  }
  return { level: ATTENUATION.CLEAR, reason: "nothing else is playing" };
}

/**
 * createAudioTabWatcher — keeps the audible-tab set current and calls
 * onChange({ level, gain, reason }) whenever the decision changes.
 *
 * `chromeApi` is injected rather than closed over so the whole watcher can be
 * driven by a fake in tests; in the extension it is just `chrome`.
 *
 * Escalation (clear→duck→mute) is applied the instant Chrome reports it —
 * being late to get out of the way is the failure everyone notices. Release
 * back down waits `releaseDelayMs`, because `audible` flickers false in the
 * gaps a listener doesn't perceive as gaps: between two tracks in a playlist,
 * across a mid-roll ad boundary, while a video seeks. Without the delay the
 * ambient bed swells back up into every one of those and is yanked away again
 * a second later.
 *
 * MV3 note: a pending release timer dies with the service worker. That can
 * only ever leave us attenuated for longer than intended, never less, and the
 * next tab event re-evaluates from scratch — `refresh()` on startup exists so
 * that re-evaluation doesn't have to wait for one.
 */
export function createAudioTabWatcher(chromeApi, {
  onChange,
  releaseDelayMs = 2500,
  log = { debug() {}, info() {} },
} = {}) {
  const playingTabIds = new Set();
  let activeTabId = null;
  let activeTabUrl = null;

  let current = { level: ATTENUATION.CLEAR, reason: "initial" };
  let releaseTimer = null;

  function apply(next, { immediate = false } = {}) {
    if (releaseTimer) {
      clearTimeout(releaseTimer);
      releaseTimer = null;
    }
    if (next.level === current.level) return;

    const escalating = SEVERITY[next.level] > SEVERITY[current.level];
    if (escalating || immediate || releaseDelayMs <= 0) {
      const from = current.level;
      current = next;
      log.info(`attenuation ${from} -> ${next.level} (${next.reason})`);
      onChange?.({ level: next.level, gain: ATTENUATION_GAIN[next.level], reason: next.reason });
      return;
    }

    log.debug(`attenuation ${current.level} -> ${next.level} pending ${releaseDelayMs}ms (${next.reason})`);
    releaseTimer = setTimeout(() => {
      releaseTimer = null;
      const from = current.level;
      current = next;
      log.info(`attenuation ${from} -> ${next.level} after release delay (${next.reason})`);
      onChange?.({ level: next.level, gain: ATTENUATION_GAIN[next.level], reason: next.reason });
    }, releaseDelayMs);
  }

  function reevaluate(opts) {
    apply(decideAttenuation({ activeTabId, activeTabUrl, playingTabIds }), opts);
  }

  function noteTab(tab) {
    if (!tab || tab.id == null) return;
    if (isTabPlayingAudio(tab)) playingTabIds.add(tab.id);
    else playingTabIds.delete(tab.id);
    if (tab.id === activeTabId) activeTabUrl = tab.url ?? activeTabUrl;
  }

  /** Seed (or re-seed) from a full tab query — used on startup and respawn. */
  async function refresh() {
    const tabs = await chromeApi.tabs.query({});
    playingTabIds.clear();
    for (const tab of tabs) {
      if (isTabPlayingAudio(tab)) playingTabIds.add(tab.id);
    }
    // tabs.query({}) marks one tab active per window; only the focused
    // window's counts as "the tab the user is on", hence the second query.
    const [active] = await chromeApi.tabs.query({ active: true, currentWindow: true });
    if (active) {
      activeTabId = active.id;
      activeTabUrl = active.url ?? null;
    }
    log.debug(`refresh: ${playingTabIds.size} audible tab(s), active=${activeTabId}`);
    reevaluate({ immediate: true });
  }

  function start() {
    chromeApi.tabs.onActivated.addListener(async ({ tabId }) => {
      activeTabId = tabId;
      try {
        const tab = await chromeApi.tabs.get(tabId);
        activeTabUrl = tab?.url ?? null;
        noteTab(tab);
      } catch {
        activeTabUrl = null; // tab closed between the event and the lookup
      }
      reevaluate();
    });

    chromeApi.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      // Only the fields that can change the decision. `status` is included
      // because a navigation replaces the URL the media-domain hint reads,
      // and Chrome does not always send `url` on the same event.
      const relevant = changeInfo.audible !== undefined
        || changeInfo.mutedInfo !== undefined
        || changeInfo.url !== undefined
        || changeInfo.status === "complete";
      if (!relevant) return;
      noteTab({ ...tab, id: tabId });
      if (tabId === activeTabId) activeTabUrl = tab?.url ?? activeTabUrl;
      reevaluate();
    });

    chromeApi.tabs.onRemoved.addListener((tabId) => {
      const had = playingTabIds.delete(tabId);
      if (tabId === activeTabId) {
        activeTabId = null;
        activeTabUrl = null;
      }
      if (had || tabId === activeTabId) reevaluate();
    });

    refresh().catch((err) => log.debug("initial tab refresh failed:", err?.message ?? err));
  }

  return {
    start,
    refresh,
    /** Current decision — the popup reads this through audioState. */
    get state() {
      return { ...current, gain: ATTENUATION_GAIN[current.level] };
    },
    /** Test seam: drive the policy without Chrome events. */
    _set({ activeTabId: a, activeTabUrl: u, playing }) {
      if (a !== undefined) activeTabId = a;
      if (u !== undefined) activeTabUrl = u;
      if (playing !== undefined) {
        playingTabIds.clear();
        for (const id of playing) playingTabIds.add(id);
      }
      reevaluate();
    },
  };
}
