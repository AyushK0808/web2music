/**
 * harnessServer.mjs — the local origins the Chromium e2e harness needs.
 *
 * Two listeners, because the extension reaches them in two different ways.
 *
 * ── The site + Feature D server (ephemeral port) ───────────────────────────
 *   /sites/<name>.html   the mood corpus from moodSites.js, served over http
 *                        (not file://) so content scripts and the extension's
 *                        host permissions behave exactly as in production.
 *   /nudge.html          a content-script-bearing page with nothing to
 *                        classify, for waking an idle service worker.
 *   /d/*                 a stand-in for the Feature D audio backend the
 *                        extension normally reaches on :8000, reachable
 *                        because the harness writes its URL into
 *                        chrome.storage.local (featureDClient.js re-reads that
 *                        on every request, so no extension restart is needed).
 *                        This is the harness's main assertion surface:
 *                        featureDClient does GET /fallback/{mood} then POST
 *                        /generate with the full B4 profile, so each recorded
 *                        request is direct evidence of what B handed to D.
 *                        Recording real HTTP avoids service-worker request
 *                        interception, which Playwright gates behind an
 *                        experimental flag.
 *
 * ── The classify-proxy stub (fixed port 8078) ──────────────────────────────
 * B1's category call and B2's mood call both go to whatever llmServiceUrl is
 * in chrome.storage.sync, defaulting to http://localhost:8078. That default is
 * read once at service-worker startup by configureFeatureB(), and there is no
 * way to get ahead of it: chrome.runtime.reload() unloads a --load-extension
 * extension permanently rather than restarting it. So instead of reconfiguring
 * the extension, the harness occupies the port the extension is already going
 * to call and answers 503. Both LLM tiers then fail fast and fall back to
 * tier-1 keyword heuristics, which is what makes the per-page mood assertions
 * deterministic regardless of whether services/classify is running locally or
 * a Groq key is set.
 *
 * If 8078 is already taken — the real proxy is up — the stub stands down and
 * says so; the harness then downgrades exact-mood expectations to advisory
 * rather than reporting failures an LLM is entitled to cause.
 */

import http from "node:http";
import { SITES, renderSite } from "./moodSites.js";

/** Where feature_b/index.js's configureFeatureB default points. */
const CLASSIFY_PROXY_PORT = 8078;

/** A short, quiet WAV so the offscreen player has something real to load. */
function silentWav({ seconds = 2, sampleRate = 22050 } = {}) {
  const frames = seconds * sampleRate;
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    // A very quiet 220 Hz tone — a real decode for the audio graph, quiet
    // enough not to matter if a headed run has the speakers on.
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / sampleRate) * 600), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const WAV = silentWav();

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

/**
 * startClassifyStub — occupies localhost:8078 and answers everything 503.
 *
 * Bound to 127.0.0.1 and ::1 separately rather than to every interface: on
 * Windows "localhost" resolves to ::1 first and elsewhere to 127.0.0.1, and a
 * test-only stub has no business being reachable from off the machine.
 *
 * @returns {Promise<{active: boolean, requests: Array, close: Function}>}
 *   active:false means the port was already in use — the real proxy is up.
 */
async function startClassifyStub(requests) {
  const servers = [];
  const handler = (req, res) => {
    requests.push({ path: req.url, at: Date.now() });
    res.writeHead(503, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ error: "classify proxy held down by the e2e harness" }));
  };

  for (const host of ["127.0.0.1", "::1"]) {
    const server = http.createServer(handler);
    try {
      await listen(server, CLASSIFY_PROXY_PORT, host);
      servers.push(server);
    } catch (err) {
      // EADDRINUSE: the real proxy. EADDRNOTAVAIL: no IPv6 on this box, which
      // is fine as long as the other family bound.
      if (err.code === "EADDRINUSE") {
        await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
        return { active: false, requests, close: async () => {} };
      }
      if (err.code !== "EADDRNOTAVAIL") throw err;
    }
  }

  return {
    active: servers.length > 0,
    requests,
    close: () => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))),
  };
}

/**
 * startHarnessServer — brings up both listeners.
 *
 * @param {Object}  [opts]
 * @param {boolean} [opts.stubLlm=true]  Hold localhost:8078 down at 503 for
 *   deterministic tier-1 classification. False leaves the real classify proxy
 *   (if any) in charge.
 */
export async function startHarnessServer({ stubLlm = true } = {}) {
  const pages = new Map();
  for (const site of SITES) {
    pages.set(`/sites/${site.name}.html`, renderSite(site));
  }

  /** Every Feature D call since the last reset(), in order. */
  const dRequests = [];
  /** Every classify-proxy call since the last reset(), in order. */
  const llmRequests = [];

  let baseUrl = "";

  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url, "http://127.0.0.1").pathname;

    // The service worker holds <all_urls>, so these headers are belt-and-
    // braces — but a bare CORS failure here would look exactly like a pipeline
    // bug, which is worth not debugging twice.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    if (path === "/nudge.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end('<html lang="en"><head><title>nudge</title></head><body><p>.</p></body></html>');
      return;
    }

    if (pages.has(path)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(pages.get(path));
      return;
    }

    // ── Feature D stub ─────────────────────────────────────────────────────
    const fallbackMatch = path.match(/^\/d\/fallback\/(.+)$/);
    if (fallbackMatch) {
      const mood = decodeURIComponent(fallbackMatch[1]);
      dRequests.push({ kind: "fallback", mood, at: Date.now() });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        audio_url: `${baseUrl}/d/clip/fallback-${encodeURIComponent(mood)}.wav`,
        metadata: { mood, is_fallback: true, loop_point_ms: 0 },
        cache: "fallback",
      }));
      return;
    }

    if (path === "/d/generate" && req.method === "POST") {
      let profile = {};
      try {
        profile = JSON.parse(await readBody(req));
      } catch {
        /* recorded below as an empty profile — the assertion will say so */
      }
      dRequests.push({ kind: "generate", mood: profile.mood, profile, at: Date.now() });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        audio_url: `${baseUrl}/d/clip/generated-${encodeURIComponent(profile.mood ?? "unknown")}.wav`,
        metadata: { mood: profile.mood, is_fallback: false, loop_point_ms: 0 },
        cache: "miss",
        timings: { total_ms: 1 },
      }));
      return;
    }

    if (path.startsWith("/d/clip/")) {
      res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": WAV.length });
      res.end(WAV);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
  });

  await listen(server, 0, "127.0.0.1");
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const classifyStub = stubLlm
    ? await startClassifyStub(llmRequests)
    : { active: false, requests: llmRequests, close: async () => {} };

  return {
    baseUrl,
    nudgeUrl: `${baseUrl}/nudge.html`,
    siteUrl: (name) => `${baseUrl}/sites/${name}.html`,
    dRequests,
    llmRequests,
    /** False when localhost:8078 was already taken — the real proxy is live. */
    classifyStubbed: classifyStub.active,
    reset() {
      dRequests.length = 0;
      llmRequests.length = 0;
    },
    async close() {
      await classifyStub.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
