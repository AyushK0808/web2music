#!/usr/bin/env node
/**
 * Grow benchmark/top-sites.txt from the Tranco list (S-A: ~105 -> ~200 live sites).
 *
 *   node data-extraction/benchmark/make_top_sites.mjs --target 200 [--list tranco.csv]
 *
 * Without --list it downloads the current Tranco top-1M (https://tranco-list.eu,
 * "rank,domain" CSV, zipped), so the sites come from a published ranking, not
 * from anyone's suggestion. Domains already in top-sites.txt are kept; new ones
 * are appended in rank order as https://<domain>/ until --target is reached.
 * Adult sites, bare CDN/infrastructure domains and anything whose first path
 * needs a login are the likely failures; extractionCost.js records those as
 * failed loads rather than hiding them, so no filtering beyond the small blocklist
 * below is done here.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITES = path.join(__dirname, 'top-sites.txt');
const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const TARGET = Number(flag('target', 200));
const BLOCK = /(^|\.)(googleapis|gstatic|cloudfront|akamai|akamaiedge|amazonaws|doubleclick|googlesyndication|googletagmanager|facebook-hardware|fbcdn|azure|windows|microsoft|apple|root-servers|pornhub|xvideos|xnxx|xhamster)\.|^(.*\.)?(cdn|edge|static)\./i;

async function loadTranco() {
  const local = flag('list');
  if (local) return fs.readFileSync(local, 'utf8');
  const res = await fetch('https://tranco-list.eu/top-1m.csv.zip');
  if (!res.ok) throw new Error(`Tranco download failed: HTTP ${res.status}`);
  const { default: AdmZip } = await import('adm-zip').catch(() => {
    throw new Error('Downloading needs `npm i -D adm-zip`; or download and unzip top-1m.csv yourself and pass --list top-1m.csv');
  });
  return new AdmZip(Buffer.from(await res.arrayBuffer())).readAsText('top-1m.csv');
}

const existing = fs.readFileSync(SITES, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
const have = new Set(existing.filter((l) => !l.startsWith('#')).map((l) => new URL(l.startsWith('http') ? l : `https://${l}`).hostname.replace(/^www\./, '')));
const added = [];
for (const line of (await loadTranco()).split('\n')) {
  if (have.size + added.length >= TARGET) break;
  const domain = line.split(',')[1]?.trim();
  if (!domain || BLOCK.test(domain) || have.has(domain)) continue;
  added.push(`https://${domain}/`);
}
fs.appendFileSync(SITES, `${existing.length && !fs.readFileSync(SITES, 'utf8').endsWith('\n') ? '\n' : ''}${added.join('\n')}\n`);
console.log(`added ${added.length} site(s); top-sites.txt now lists ${have.size + added.length}`);
