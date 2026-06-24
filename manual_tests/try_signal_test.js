import { runFeatureB, configureFeatureB, resetConfidenceWindow } from "../feature_b/index.js";

const baseText = "Scientists are exploring ancient ruins and ongoing archaeological digs in the region.";

async function testSignals(label, scrollSpeed, cursorSpeed) {
  resetConfidenceWindow();
  configureFeatureB({ apiKey: "", targetModel: "musicgen" });

  const pageData = {
    rawText: baseText,
    title: "Archaeology Report",
    description: "An overview of recent archaeological findings and excavation sites.",
    url: "https://example.com/archaeology",
    colors: { hue: 30, saturation: 0.3, lightness: 0.5 },
    scrollSpeed,
    cursorSpeed,
  };

  await runFeatureB(pageData); // first call discarded — 5s confidence window
  await new Promise(r => setTimeout(r, 5100));
  const result = await runFeatureB(pageData);

  console.log(`--- ${label} (scroll=${scrollSpeed}, cursor=${cursorSpeed}) ---`);
  console.log("mood:", result.musicProfile?.mood,
              "| energy:", result.musicProfile?.energy,
              "| intensity:", result.musicProfile?.intensity,
              "| bpm:", result.musicProfile?.bpm);
}

await testSignals("Slow / idle browsing", 20, 30);
await testSignals("Fast / frantic scrolling", 900, 700);
