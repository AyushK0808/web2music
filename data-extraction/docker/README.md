# Feature A — Embedding Microservice (Docker)

The only piece of Feature A that needs external API access is the **OpenAI
embedding backend**. Putting an API key into a browser extension bundle makes it
trivially extractable, so this container holds the key server-side and exposes a
single local endpoint the page calls instead.

## Endpoints

| Method | Path      | Body                                         | Response |
|--------|-----------|----------------------------------------------|----------|
| `POST` | `/embed`  | `{ "input": "text", "model"?: "..." }`       | `{ "vector": number[], "dimensions": number, "model": string }` |
| `GET`  | `/health` | —                                            | `{ "ok": true, "keyConfigured": boolean }` |

## Run

```bash
cd data-extraction/docker
cp .env.example .env          # paste your OpenAI key into .env
docker compose up --build
```

The service listens on `http://localhost:8077`. Verify:

```bash
curl localhost:8077/health
curl -X POST localhost:8077/embed \
  -H 'Content-Type: application/json' \
  -d '{"input":"a calm article about espresso"}'
```

## Wire it into Feature A

`Embeddingmodel.js` gained a `service` backend that targets this container:

```js
const { getEmbedding } = window.Web2MusicEmbedding;
const emb = await getEmbedding(text, { backend: 'service' }); // → localhost:8077/embed
```

Or through the orchestrator:

```js
await buildPageData({ embeddingConfig: { backend: 'service' } });
```

The three embedding backends:

| backend  | Needs                            | Where the key/model lives |
|----------|----------------------------------|---------------------------|
| `local`  | `@xenova/transformers` bundled   | none — runs in-browser    |
| `openai` | `openaiApiKey` in config         | ⚠️ in the page (dev only) |
| `service`| this container running           | ✅ container env only      |

Prefer `local` for zero-network in-browser use, or `service` when you want
OpenAI-quality vectors without exposing the key.
