# Feature B — Classification Proxy (Docker)

Feature B's two LLM calls (mood classification in `b2_moodClassifier.js`,
category classification in `b1_contentUnderstanding.js`) originally called
`api.anthropic.com` directly from the extension, which means:

1. **CORS failure in the extension.** Anthropic doesn't send CORS headers for
   browser-origin requests unless `anthropic-dangerous-direct-browser-access`
   is set — that header is the short-term fix (already applied to both call
   sites) and is enough to make the extension work again, but it's a
   same-origin-request opt-in, not a security fix.
2. **The API key ships client-side.** Even with the header, the key still
   lives in `chrome.storage.sync` and gets attached to fetch calls made from
   the extension's own JS — inspectable via the extension's service worker
   devtools or by dumping storage.

This container is the long-term fix for (2): it holds `ANTHROPIC_API_KEY`
server-side and exposes a single local endpoint that forwards
already-built Anthropic Messages API requests. It is a **thin proxy** —
unlike Feature A's `embedService.js`, it does not own any prompt-building or
response-validation logic; B1/B2 keep building the exact same prompts
(including the prompt-injection delimiters and the mood/pageType/hint
validation) and just point the request at this container instead of at
Anthropic directly.

## Endpoints

| Method | Path           | Body                                    | Response |
|--------|----------------|------------------------------------------|----------|
| `POST` | `/v1/messages` | Same shape as the Anthropic Messages API | Anthropic's response, forwarded verbatim |
| `GET`  | `/health`      | —                                        | `{ "ok": true, "keyConfigured": boolean }` |

## Run

```bash
cd mood-classification/docker
cp .env.example .env          # paste your Anthropic key into .env
docker compose up --build
```

The service listens on `http://localhost:8078`. Verify:

```bash
curl localhost:8078/health
curl -X POST localhost:8078/v1/messages \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":50,"temperature":0,"messages":[{"role":"user","content":"Say hello in one word."}]}'
```

## Wire it into Feature B

`callCategoryLLMClassifier` (B1) and `callLLMClassifier` (B2) both accept
either a bare API key string (the "direct" backend, unchanged default) or a
config object selecting the "proxy" backend:

```js
// Direct (default, back-compat) — key ships client-side:
runB1(pageData, "sk-ant-...");

// Proxy — no key in the browser at all:
runB1(pageData, { backend: "proxy" });                       // → http://localhost:8078/v1/messages
runB1(pageData, { backend: "proxy", serviceUrl: "http://localhost:9000/v1/messages" }); // custom port
```

Through the orchestrator, this is one line in `background.js`:

```js
configureFeatureB({ apiKey: { backend: "proxy" } });
```

The two backends:

| backend  | Needs                              | Where the key lives          |
|----------|-------------------------------------|-------------------------------|
| `direct` | `apiKey` string in config           | ⚠️ in the extension (short-term) |
| `proxy`  | this container running              | ✅ container env only          |

Prefer `proxy` whenever the container can be running alongside the extension;
fall back to `direct` only for quick local testing without Docker.
