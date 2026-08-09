// ui/src/offscreenExtract.js — Feature A's embedding + vector-store server
// side, living in the offscreen document (extension origin, extension CSP,
// real IndexedDB scope — see the X4 integration plan's finding (b)).
//
// Handles the two RPC types content.entry.js's remoteDeps.js sends via the
// service worker: A_EMBED (→ the embed worker) and A_VS_SEARCH/A_VS_UPSERT
// (→ window.Web2MusicVectorStore, loaded as a classic script by
// offscreen.html before this bundle runs).

import { createLogger } from "./log.js";

const log = createLogger("offscreen-extract");

/**
 * createWorkerBridge — lazily spawns `scriptUrl` and turns its
 * postMessage/onmessage traffic into promises, correlated by an id.
 *
 * Shared by the embedding worker and the zero-shot worker: they are separate
 * Workers (a 400M-parameter MNLI pass must not queue behind, or in front of,
 * Feature A's embedding — see zeroshot.worker.js) but the plumbing around
 * them is identical, including the error handling that used to be the only
 * thing standing between an ONNX init failure and a permanently hung caller.
 */
function createWorkerBridge(scriptUrl, label) {
  let worker = null;
  let nextId = 1;
  const pending = new Map();

  function get() {
    if (worker) return worker;
    worker = new Worker(scriptUrl);
    worker.onmessage = (event) => {
      const { id, ok, ...rest } = event.data || {};
      const waiter = pending.get(id);
      if (!waiter) return;
      pending.delete(id);
      if (ok) waiter.resolve(rest);
      else waiter.reject(new Error(rest.error || `${label} worker error`));
    };
    // An uncaught error in the worker (ONNX failing to initialise, say) never
    // produces a reply, so without this every in-flight request sits in
    // `pending` forever and the only symptom is a bare "worker sent an error!"
    // line in the offscreen console. Fail the callers instead.
    //
    // The worker is deliberately kept rather than terminated and respawned: an
    // uncaught error does not necessarily kill it, and if the cause is
    // structural (as the blob:/CSP thread failure was — see embed.worker.js)
    // respawning just reloads a 10MB wasm on every request to fail the same way.
    // Later requests are bounded by the caller's own RPC timeout instead.
    worker.onerror = (event) => {
      const detail = event.message || `${label} worker crashed`;
      log.error(`${label} worker error (${pending.size} request(s) in flight):`, detail);
      for (const [id, waiter] of pending) {
        pending.delete(id);
        waiter.reject(new Error(detail));
      }
    };
    return worker;
  }

  return {
    warm: () => { get(); },
    send: (message) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      get().postMessage({ id, ...message });
    }),
  };
}

const embedBridge = createWorkerBridge("embed.worker.js", "embed");
const zeroShotBridge = createWorkerBridge("zeroshot.worker.js", "zero-shot");

// Warm the model as soon as the offscreen document exists, so the first real
// page's A_EMBED call isn't paying the ~2-5s ONNX load cost.
//
// The zero-shot worker is NOT warmed here: its model is far larger, is not
// vendored (first use downloads it), and the tier is opt-in — spawning it
// eagerly would impose that cost on every install whether or not the tier is
// ever switched on. It spawns on the first B_ZEROSHOT instead.
export function warmEmbedWorker() {
  embedBridge.warm();
}

function embed(text) {
  return embedBridge.send({ type: "EMBED", text });
}

let _vectorStore = null;
function getVectorStore() {
  if (!_vectorStore) _vectorStore = window.Web2MusicVectorStore.createVectorStore();
  return _vectorStore;
}

// Dispatched from offscreen.entry.js's chrome.runtime.onMessage listener for
// anything the SW forwards with target: "offscreen" and one of these types.
export async function handleExtractMessage(msg, sendResponse) {
  switch (msg.type) {
    case "A_EMBED": {
      try {
        const result = await embed(msg.text);
        sendResponse({ ok: true, ...result });
      } catch (err) {
        sendResponse({ ok: false, error: String(err.message || err) });
      }
      return true;
    }
    case "B_ZEROSHOT": {
      // Feature B's tier-1.5 page-type classifier, local backend. The
      // response is passed straight back in HuggingFace's { labels, scores }
      // shape — b1_zeroShotCategory.js parses and gates it, and does so
      // identically for this backend and the server-side one.
      try {
        const result = await zeroShotBridge.send({
          type: "ZERO_SHOT",
          text: msg.text,
          labels: msg.labels,
          hypothesisTemplate: msg.hypothesisTemplate,
          model: msg.model,
        });
        sendResponse({ ok: true, ...result });
      } catch (err) {
        sendResponse({ ok: false, error: String(err.message || err) });
      }
      return true;
    }
    case "A_VS_SEARCH": {
      try {
        const result = await getVectorStore().search(msg.vec, msg.opts);
        sendResponse({ ok: true, ...result });
      } catch (err) {
        sendResponse({ ok: false, error: String(err.message || err) });
      }
      return true;
    }
    case "A_VS_UPSERT": {
      try {
        const record = await getVectorStore().upsert(msg.rec);
        sendResponse({ ok: true, record });
      } catch (err) {
        sendResponse({ ok: false, error: String(err.message || err) });
      }
      return true;
    }
    case "A_VS_CLEAR": {
      try {
        await getVectorStore().clear();
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err.message || err) });
      }
      return true;
    }
    default:
      return false;
  }
}
