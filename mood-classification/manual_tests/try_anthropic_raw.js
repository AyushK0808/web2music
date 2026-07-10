const apiKey = process.env.ANTHROPIC_API_KEY || "";

console.log("Key starts with:", apiKey.slice(0, 12), "| length:", apiKey.length);

const res = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "Content-Type":      "application/json",
    "x-api-key":         apiKey,
    "anthropic-version": "2023-06-01",
  },
  body: JSON.stringify({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 50,
    messages:   [{ role: "user", content: "Say hello in one word." }],
  }),
});

console.log("Status:", res.status);
const data = await res.json();
console.log(JSON.stringify(data, null, 2));