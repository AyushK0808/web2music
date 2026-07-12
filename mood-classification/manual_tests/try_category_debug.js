import { runB1 } from "../feature_b/b1_contentUnderstanding.js";

const url = process.argv[2];
const res  = await fetch(url);
const html = await res.text();

function extract(re) { const m = html.match(re); return m ? m[1].trim() : ""; }
const title       = extract(/<title[^>]*>([^<]*)<\/title>/i);
const description = extract(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i);

// Strip nav/header/footer/aside chrome, then prefer a real content
// container so the first 2000 chars are article text, not sidebar links.
function extractArticleText(rawHtml) {
  const withoutChrome = rawHtml
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<aside[\s\S]*?<\/aside>/gi, " ")
    .replace(/<form[\s\S]*?<\/form>/gi, " ");

  const mainMatch = withoutChrome.match(/<main[^>]*>([\s\S]*)/i)
    || withoutChrome.match(/<article[^>]*>([\s\S]*)/i);
  const wikiIdx = withoutChrome.search(/id=["']mw-content-text["']/i);
  const body = mainMatch ? mainMatch[1]
    : wikiIdx >= 0 ? withoutChrome.slice(wikiIdx)
    : withoutChrome;

  return body
    .replace(/<[^>]+>/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 2000);
}

const bodyText = extractArticleText(html);

const cleaned = await runB1({ rawText: bodyText, title, description, url }, process.env.GROQ_API_KEY || "");
console.log("Keywords:", cleaned.keywords);
console.log("Category scores:", cleaned.category.scores);
console.log("Primary picked:", cleaned.category.primary, `(source: ${cleaned.category.source})`);