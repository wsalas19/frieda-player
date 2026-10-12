#!/usr/bin/env node
/**
 * Point the landing page's absolute URLs at a given origin.
 *
 *   npm run site:url -- https://frieda-player.<sub>.workers.dev
 *
 * Rewrites the canonical + og:url + og:image + twitter:image + JSON-LD urls in
 * site/index.html, plus site/sitemap.xml and site/robots.txt. It finds the
 * current origin from index.html's canonical, so it works no matter what the
 * previous value was.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = join(root, "site", "index.html");
const SITEMAP = join(root, "site", "sitemap.xml");
const ROBOTS = join(root, "site", "robots.txt");

const raw = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!raw) {
  console.error("Usage: npm run site:url -- https://your-site.example");
  process.exit(1);
}

let next;
try {
  next = new URL(raw.includes("://") ? raw : `https://${raw}`).origin;
} catch {
  console.error(`Not a valid URL: ${raw}`);
  process.exit(1);
}

const index = readFileSync(INDEX, "utf8");
const m = /<link rel="canonical" href="(https?:\/\/[^/]+)/.exec(index);
if (!m) {
  console.error("Could not find the canonical URL in site/index.html.");
  process.exit(1);
}
const current = m[1];

if (current === next) {
  console.log(`Already pointing at ${next} — nothing to do.`);
  process.exit(0);
}

for (const file of [INDEX, SITEMAP, ROBOTS]) {
  const text = readFileSync(file, "utf8");
  const updated = text.split(current).join(next);
  if (updated !== text) {
    writeFileSync(file, updated);
    console.log(`updated ${file.replace(root + "/", "").replace(/\\/g, "/")}`);
  }
}
console.log(`\nSite URLs now use ${next}`);
