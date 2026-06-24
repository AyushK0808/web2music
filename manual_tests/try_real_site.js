import { runFeatureB, configureFeatureB, resetConfidenceWindow } from "../feature_b/index.js";

const url = process.argv[2] || "https://en.wikipedia.org/wiki/Bioluminescence";

const res  = await fetch(url);
const html = await res.text();

function extract(re) {
  const m = html.match(re);
  return m ? m[1].trim() : "";
}

const title       = extract(/<title[^>]*>([^<]*)<\/title>/i);
const description = extract(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i);

const bodyText = html
  .replace(/<script[\s\S]*?<\/script>/gi, " ")
  .replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/\s{2,}/g, " ")
  .trim()
  .slice(0, 2000);

const pageData = {
  rawText: bodyText,
  title,
  description,
  url,
  colors:      { hue: 200, saturation: 0.3, lightness: 0.5 }, // can't extract real colors w/o a browser
  scrollSpeed: 100,
  cursorSpeed: 150,
};

resetConfidenceWindow();
configureFeatureB({
  apiKey:      process.env.ANTHROPIC_API_KEY || "",
  targetModel: "musicgen",
});

console.log("Title:", title);
await runFeatureB(pageData); // first call always null (5s window)
console.log("Waiting 5 seconds...");
await new Promise(r => setTimeout(r, 5100));

const result = await runFeatureB(pageData);
console.log(JSON.stringify(result, null, 2));