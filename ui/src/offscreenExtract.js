// ui/src/offscreenExtract.js — Feature A's embedding + vector-store server
// side, living in the offscreen document (extension origin, extension CSP,
// real IndexedDB scope — see the X4 integration plan's finding (b)).
//
// Handles the two RPC types content.entry.js's remoteDeps.js sends via the
// service worker: A_EMBED (→ the embed worker) and A_VS_SEARCH/A_VS_UPSERT
// (→ window.Web2MusicVectorStore, loaded as a classic script by
// offscreen.html before this bundle runs).

let _worker = null;
let _nextId = 1;
const _pending = new Map();

function getWorker() {
  if (_worker) return _worker;
  _worker = new Worker("embed.worker.js");
  _worker.onmessage = (event) => {
    const { id, ok, ...rest } = event.data || {};
    const waiter = _pending.get(id);
    if (!waiter) return;
    _pending.delete(id);
    if (ok) waiter.resolve(rest);
    else waiter.reject(new Error(rest.error || "embed worker error"));
  };
  return _worker;
}

// Warm the model as soon as the offscreen document exists, so the first real
// page's A_EMBED call isn't paying the ~2-5s ONNX load cost.
export function warmEmbedWorker() {
  getWorker();
}

function embed(text) {
  return new Promise((resolve, reject) => {
    const id = _nextId++;
    _pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, type: "EMBED", text });
  });
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
