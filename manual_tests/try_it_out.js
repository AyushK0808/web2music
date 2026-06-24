import { runFeatureB, configureFeatureB, resetConfidenceWindow } from "../feature_b/index.js";

resetConfidenceWindow();
configureFeatureB({ apiKey: "", targetModel: "musicgen" }); // "" = heuristic only, no real LLM call

const samplePage = {
  rawText: "Scientists discovered a deep sea fish that glows in the dark, baffling marine biologists.",
  title: "Deep Sea Discovery: Glowing Fish Found",
  description: "Marine biologists found a new bioluminescent species",
  url: "https://news.example.com/ocean-discovery",
  colors: { hue: 200, saturation: 0.4, lightness: 0.5 },
  scrollSpeed: 80,
  cursorSpeed: 120,
};

const first = await runFeatureB(samplePage);
console.log("First call (expect null — 5s stability window not met yet):", first);

console.log("Waiting 5 seconds...");
await new Promise(r => setTimeout(r, 5100));

const second = await runFeatureB(samplePage);
console.log("Second call — full output:");
console.log(JSON.stringify(second, null, 2));