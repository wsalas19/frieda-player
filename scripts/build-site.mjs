#!/usr/bin/env node
/**
 * Build check for the static landing page in site/.
 *
 * There is nothing to compile — this verifies that every local file the page
 * references (styles, scripts, images) actually exists before Wrangler uploads
 * the directory. Broken references fail the Workers Builds deploy.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const site = join(root, "site");
const html = readFileSync(join(site, "index.html"), "utf8");

const refs = new Set();
for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const ref = match[1];
  if (/^(?:[a-z]+:|\/\/|#)/i.test(ref)) continue;
  refs.add(ref.split(/[?#]/)[0]);
}

const missing = [...refs].filter((ref) => !existsSync(join(site, ref)));
if (missing.length) {
  console.error(`Missing local file${missing.length > 1 ? "s" : ""} in site/:`);
  for (const ref of missing) console.error(`  ${ref}`);
  process.exit(1);
}

for (const ref of refs) console.log(`  ok  ${ref}`);
console.log(`\nsite: ${refs.size} local references checked, all present.`);
