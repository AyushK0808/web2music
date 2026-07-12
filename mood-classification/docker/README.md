# Feature B — Classification Proxy (Docker)

Feature B's two LLM calls (mood classification in `b2_moodClassifier.js`,
category classification in `b1_contentUnderstanding.js`) call GroqCloud's
OpenAI-compatible chat completions API. Calling `api.groq.com` directly from
the extension means:

1. **CORS is unconfirmed in the extension.** Unlike Anthropic (which
   documents an explicit `anthropic-dangerous-direct-browser-access` opt-in
   header for direct browser calls), Groq's docs don't say one way or the
   other whether a direct browser-origin request succeeds. It may just work;
   it may CORS-fail silently. The proxy below sidesteps the question
   entirely instead of relying on undocumented behaviour.
2. **The API key ships client-side in "direct" mode.** The key lives in
   `chrome.storage.sync` and gets attached to fetch calls made from the
   extension's own JS — inspectable via the extension's service worker
   devtools or by dumping storage.

This container is the fix for both: it holds `GROQ_API_KEY` server-side and
exposes a single local endpoint that forwards already-built chat-completions
requests. It is a **thin proxy** — unlike Feature A's `embedService.js`, it
does not own any prompt-building or response-validation logic; B1/B2 keep
building the exact same prompts (including the prompt-injection delimiters
and the mood/pageType/hint validation) and just point the request at this
container instead of at Groq directly.

## Endpoints

| Method | Path                  | Body                                          | Response |
|--------|-----------------------|------------------------------------------------|----------|
| `POST` | `/v1/chat/completions` | Same shape as Groq's chat completions API      | Groq's response, forwarded verbatim |
| `GET`  | `/health`             | —                                                | `{ "ok": true, "keyConfigured": boolean }` |

## Run

```bash
cd mood-classification/docker
cp .env.example .env          # paste your Groq key into .env (get one free at console.groq.com/keys)
docker compose up --build
```

The service listens on `http://localhost:8078`. Verify:

```bash
curl localhost:8078/health
curl -X POST localhost:8078/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"llama-3.1-8b-instant","max_completion_tokens":50,"temperature":0,"messages":[{"role":"user","content":"Say hello in one word."}]}'
```

## Wire it into Feature B

`callCategoryLLMClassifier` (B1) and `callLLMClassifier` (B2) both accept
either a bare API key string (the "direct" backend, unchanged default) or a
config object selecting the "proxy" backend:

```js
// Direct (default, back-compat) — key ships client-side:
runB1(pageData, "gsk_...");

// Proxy — no key in the browser at all:
runB1(pageData, { backend: "proxy" });                       // → http://localhost:8078/v1/chat/completions
runB1(pageData, { backend: "proxy", serviceUrl: "http://localhost:9000/v1/chat/completions" }); // custom port
```

Through the orchestrator, this is one line in `background.js`:

```js
configureFeatureB({ apiKey: { backend: "proxy" } });
```

The two backends:

| backend  | Needs                              | Where the key lives          |
|----------|-------------------------------------|-------------------------------|
| `direct` | `apiKey` string in config           | ⚠️ in the extension, CORS unconfirmed |
| `proxy`  | this container running              | ✅ container env only, CORS not applicable |

Prefer `proxy` whenever the container can be running alongside the extension;
`direct` is mainly useful for quick local testing without Docker, or if you
confirm Groq's CORS behaviour works for your setup.
