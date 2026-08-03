// ui/src/featureDClient.js — Feature D HTTP client, service-worker side.
//
// Two things the X4 plan calls out explicitly:
//   - AbortController per request: a new mood arriving while a generation is
//     in flight aborts the stale one, so a 90s CPU generation can't land long
//     after the user has moved on and yank the music to an outdated mood.
//   - Instant-fallback-then-swap: GET /fallback/{mood} first (sub-second),
//     start playing it immediately, then POST /generate in parallel and
//     crossfade to the real clip once it resolves. On a GPU box this can be
//     skipped (skipFallbackFirst); on CPU it's the difference between usable
//     and not.
//
// duration_seconds is never emitted by Feature B (see feature_b/index.js) —
// B does not control duration; this client sets it explicitly so the
// default is visible rather than implicit in D's models.py.
const DEFAULT_DURATION_SECONDS = 28;

import { createLogger } from "./log.js";

const log = createLogger("featureD");

async function getBackendUrl() {
  const { backendUrl } = await chrome.storage.local.get({ backendUrl: "http://localhost:8000" });
  return backendUrl;
}

let _activeController = null;

/**
 * fetchFallback — GET /fallback/{mood}, no generation, sub-second.
 */
export async function fetchFallback(mood) {
  const backendUrl = await getBackendUrl();
  const url = `${backendUrl}/fallback/${encodeURIComponent(mood)}`;
  const done = log.time(`GET /fallback/${mood}`);
  const res = await fetch(url);
  done(`-> ${res.status}`);
  if (!res.ok) throw new Error(`/fallback/${mood} failed: ${res.status}`);
  const clip = await res.json();
  log.debug("fallback clip:", clip.audio_url);
  return clip;
}

/**
 * requestGeneration — POST /generate with the given profile. Aborts any
 * generation already in flight from a previous call before starting this
 * one, so at most one real generation request is ever outstanding.
 *
 * @param {Object} profile  handoff2.profile (flat snake_case, see b4)
 * @returns {Promise<{audio_url, metadata, cache, timings}>}
 */
export async function requestGeneration(profile) {
  if (_activeController) {
    log.debug("aborting in-flight /generate — superseded by a newer mood");
    _activeController.abort();
  }
  const controller = new AbortController();
  _activeController = controller;

  const backendUrl = await getBackendUrl();
  const body = { duration_seconds: DEFAULT_DURATION_SECONDS, ...profile };

  log.info(`POST ${backendUrl}/generate`, {
    mood: body.mood, style: body.style, bpm: body.bpm, key: body.key,
    energy: body.energy, duration_seconds: body.duration_seconds,
    nonce: body.nonce ? "(set)" : undefined,
  });
  const done = log.time("POST /generate");

  try {
    const res = await fetch(`${backendUrl}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    done(`-> ${res.status}`);
    if (!res.ok) {
      // Include the body: FastAPI puts the reason in `detail`, and without it
      // a 503 from the "no fallback clips available" path is indistinguishable
      // from the backend being down.
      const text = await res.text().catch(() => "");
      log.error(`/generate failed: ${res.status}`, text.slice(0, 500));
      throw new Error(`/generate failed: ${res.status}`);
    }
    const clip = await res.json();
    log.debug("/generate response:", {
      audio_url: clip.audio_url, cache: clip.cache,
      is_fallback: clip.metadata?.is_fallback, timings: clip.timings,
    });
    return clip;
  } catch (err) {
    if (err.name === "AbortError") {
      log.debug("/generate aborted");
    } else if (err.name === "TypeError") {
      // fetch() rejects with a bare TypeError ("Failed to fetch") when the
      // backend isn't listening at all — the single most common cause of "the
      // extension does nothing", and unrecognisable from the message alone.
      log.error(`cannot reach Feature D at ${backendUrl} (${err.message}). `
        + "Is the container running? `docker compose -f docker/docker-compose.yml --profile cpu up -d`");
    } else {
      log.error("/generate error:", err);
    }
    throw err;
  } finally {
    if (_activeController === controller) _activeController = null;
  }
}

/**
 * requestTrack — the full instant-fallback-then-swap flow for a mood
 * transition. Calls `onFallback(clip)` as soon as the fallback resolves (or
 * never, if skipFallbackFirst / the fallback call fails), then
 * `onGenerated(clip)` once /generate resolves. Both callbacks receive
 * { audio_url, metadata }.
 *
 * @param {Object} profile
 * @param {Object} [opts]
 * @param {boolean} [opts.skipFallbackFirst=false]  Skip the instant fallback
 *   step (e.g. on a GPU backend where /generate is already sub-second).
 */
export async function requestTrack(profile, { skipFallbackFirst = false, onFallback, onGenerated } = {}) {
  log.info(`requestTrack mood=${profile.mood} skipFallbackFirst=${skipFallbackFirst}`);

  if (!skipFallbackFirst) {
    fetchFallback(profile.mood)
      .then((clip) => onFallback && onFallback(clip))
      .catch((err) => log.warn("fallback fetch failed:", err.message));
  }

  const generated = await requestGeneration(profile);
  if (onGenerated) onGenerated(generated);
  return generated;
}
