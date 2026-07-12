const apiKey = process.env.GROQ_API_KEY || "";

console.log("Key starts with:", apiKey.slice(0, 8), "| length:", apiKey.length);

const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type":  "application/json",
    "Authorization": `Bearer ${apiKey}`,
  },
  body: JSON.stringify({
    model:      "llama-3.1-8b-instant",
    max_completion_tokens: 50,
    messages:   [{ role: "user", content: "Say hello in one word." }],
  }),
});

console.log("Status:", res.status);
const data = await res.json();
console.log(JSON.stringify(data, null, 2));
