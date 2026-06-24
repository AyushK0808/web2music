import { runB1 } from "./feature_b/b1_contentUnderstanding.js";

const url = process.argv[2];
const res  = await fetch(url);
const html = await res.text();

function extract(re) { const m = html.match(re); return m ? m[1].trim() : ""; }
const title       = extract(/<title[^>]*>([^<]*)<\/title>/i);
const description = extract(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i);
const bodyText = html
  .replace(/<script[\s\S]*?<\/script>/gi, " ")
  .replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/\s{2,}/g, " ")
  .trim()
  .slice(0, 2000);

const cleaned = runB1({ rawText: bodyText, title, description, url });
console.log("Keywords:", cleaned.keywords);
console.log("Category scores:", cleaned.category.scores);
console.log("Primary picked:", cleaned.category.primary);