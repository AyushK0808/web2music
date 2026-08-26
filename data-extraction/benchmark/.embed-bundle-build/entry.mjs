import { pipeline, env } from '@xenova/transformers';

// Match the paper's own privacy stance for this backend: no remote model
// loading from unexpected origins. env.allowRemoteModels stays true here
// because a real MiniLM benchmark run NEEDS to fetch the actual weights
// from the Hugging Face Hub on first use (there is no getting around a real
// network call for that — it's the whole point of "real" in item 4.6), but
// we pin the local cache dir name so repeated benchmark runs reuse one
// download instead of re-fetching per site.
env.useBrowserCache = true;
env.cacheDir = 'web2music-benchmark-cache';

// Without this, the library tries same-origin "local model" resolution
// FIRST (a relative path like /models/Xenova/all-MiniLM-L6-v2/tokenizer.json,
// resolved against whatever page it's injected into) and only falls back to
// the real Hugging Face Hub if that 404s in a specific way it recognises.
// Against a real external site that relative path either 403s/404s outright
// or — worse — silently resolves to that SITE'S OWN unrelated content at
// that path, which is a much stranger failure to debug than "can't find the
// model" would have been. allowLocalModels: false skips straight to the
// real Hub fetch every time, which is what "real embedding" is supposed to
// measure in the first place.
env.allowLocalModels = false;

window.transformersPipeline = pipeline;
