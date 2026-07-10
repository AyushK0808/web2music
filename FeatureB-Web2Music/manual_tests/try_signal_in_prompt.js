import { runFeatureB, configureFeatureB, resetConfidenceWindow } from "../feature_b/index.js";

const baseText = "A calm afternoon report on local community gardening events.";

async function testPrompt(label, scrollSpeed, cursorSpeed) {
  resetConfidenceWindow();
  configureFeatureB({ apiKey: "", targetModel: "musicgen" });

  const pageData = {
    rawText: baseText,
    title: "Community Gardening Update",
    description: "A short local update about community garden volunteering and events.",
    url: "https://example.com/gardening",
    colors: { hue: 100, saturation: 0.3, lightness: 0.5 },
    scrollSpeed,
    cursorSpeed,
  };

  await runFeatureB(pageData);
  await new Promise(r => setTimeout(r, 5100));
  const result = await runFeatureB(pageData);

  console.log(`\n=== ${label} (scroll=${scrollSpeed}, cursor=${cursorSpeed}) ===`);
  console.log("energy:", result.musicProfile.energy, "| intensity:", result.musicProfile.intensity, "| bpm:", result.musicProfile.bpm);
  console.log("PROMPT:", result.prompt);
}

await testPrompt("Idle browsing",      20, 30);
await testPrompt("Frantic scrolling", 900, 700);