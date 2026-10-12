#!/usr/bin/env node
/**
 * One-shot release helper for Frieda Player.
 *
 *   npm run release -- <version|patch|minor|major> [--dry-run] [--no-push] [--no-check]
 *
 * It bumps the version in package.json (the single source of truth — the Tauri
 * config reads `../package.json`) and src-tauri/Cargo.toml, refreshes
 * Cargo.lock, commits "release: vX.Y.Z", creates the annotated `vX.Y.Z` tag and
 * pushes both. Pushing the tag is what triggers the release workflow.
 *
 * Guardrails (learned the hard way):
 *   - version must be numeric X.Y.Z (no prerelease: WiX/MSI rejects it);
 *   - the tag must not already exist locally or on origin (never retag);
 *   - refuses to run on a dirty working tree.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = join(root, "package.json");
const CARGO = join(root, "src-tauri", "Cargo.toml");
const CARGO_DIR = join(root, "src-tauri");
const README = join(root, "README.md");

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const target = args.find((a) => !a.startsWith("--"));
const dryRun = flags.has("--dry-run");
const noPush = flags.has("--no-push");
const noCheck = flags.has("--no-check");

const log = (msg) => console.log(msg);
const die = (msg) => {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
};

function run(cmd, cmdArgs, opts = {}) {
  return execFileSync(cmd, cmdArgs, { stdio: "inherit", cwd: root, ...opts });
}
// npm is a .cmd shim on Windows, which execFile can't launch directly — go
// through the shell so it resolves on every platform.
function runNpm(npmArgs) {
  return execFileSync("npm", npmArgs, { stdio: "inherit", cwd: root, shell: true });
}
function capture(cmd, cmdArgs, opts = {}) {
  return execFileSync(cmd, cmdArgs, { encoding: "utf8", cwd: root, ...opts }).trim();
}

if (!target || flags.has("--help")) {
  log(
    [
      "Usage: npm run release -- <version|patch|minor|major> [flags]",
      "",
      "  version        exact X.Y.Z (numeric only) or patch/minor/major",
      "  --dry-run      show what would happen, change nothing",
      "  --no-push      commit + tag locally, don't push",
      "  --no-check     skip lint + tests before tagging",
    ].join("\n"),
  );
  process.exit(target ? 0 : 1);
}

const pkg = JSON.parse(readFileSync(PKG, "utf8"));
const current = pkg.version;
const next = resolveVersion(current, target);

if (!/^\d+\.\d+\.\d+$/.test(next)) {
  die(`version must be numeric X.Y.Z with no prerelease segment (got "${next}").`);
}
if (next === current) die(`already at v${current}; nothing to bump.`);

const tag = `v${next}`;

// Refuse a dirty tree so the release commit contains only the version bump.
// Refresh the stat cache first: editors/prettier can touch a file's mtime
// without changing its content, which would otherwise read as dirty.
try {
  capture("git", ["update-index", "-q", "--refresh"]);
} catch {
  /* exits non-zero when there are real changes; `status` below is authoritative */
}
const dirty = capture("git", ["status", "--porcelain"]);
if (dirty) die(`working tree is dirty — commit or stash first:\n\n${dirty}`);

// Never reuse a tag: installed apps compare versions, not commits.
if (capture("git", ["tag", "-l", tag])) die(`tag ${tag} already exists locally.`);
if (capture("git", ["ls-remote", "--tags", "origin", tag])) {
  die(`tag ${tag} already exists on origin — pick a new version.`);
}

log(`\nReleasing ${current} → ${next} (tag ${tag})${dryRun ? "  [dry-run]" : ""}\n`);

if (!noCheck && !dryRun) {
  log("• lint + tests…");
  runNpm(["run", "lint"]);
  runNpm(["test"]);
}

// 1. package.json (source of truth).
pkg.version = next;
const pkgText = JSON.stringify(pkg, null, 2) + "\n";
// 2. Cargo.toml [package].version.
const cargoText = readFileSync(CARGO, "utf8");
const cargoNext = cargoText.replace(
  /(\[package\][^]*?\nversion\s*=\s*")[^"]*(")/,
  (_m, a, b) => `${a}${next}${b}`,
);
if (cargoNext === cargoText) die("could not find [package] version in Cargo.toml.");
// 3. README installer filenames, if they name the old version.
const readmeText = readFileSync(README, "utf8");
const readmeNext = readmeText.replaceAll(`Frieda.Player_${current}_`, `Frieda.Player_${next}_`);

if (dryRun) {
  log("would write package.json version → " + next);
  log("would write Cargo.toml [package] version → " + next);
  log(
    readmeNext === readmeText
      ? "README: no installer filenames to update"
      : `README: ${current} → ${next}`,
  );
  log(`would commit "release: ${tag}" and tag ${tag}`);
  log(noPush ? "would stop before pushing" : "would push main + " + tag);
  process.exit(0);
}

writeFileSync(PKG, pkgText);
writeFileSync(CARGO, cargoNext);
if (readmeNext !== readmeText) writeFileSync(README, readmeNext);

// Keep Cargo.lock's root package version in step without a full build.
log("• refreshing Cargo.lock…");
try {
  execFileSync("cargo", ["metadata", "--format-version", "1"], {
    cwd: CARGO_DIR,
    stdio: "ignore",
  });
} catch {
  log("  (cargo not available — Cargo.lock left as-is; CI will sync it)");
}

log("• committing and tagging…");
run("git", ["add", "-A"]);
run("git", ["commit", "-m", `release: ${tag}`]);
run("git", ["tag", "-a", tag, "-m", `Frieda Player ${tag}`]);

if (noPush) {
  log(`\n✓ ${tag} committed and tagged locally. Push when ready:\n  git push --follow-tags\n`);
  process.exit(0);
}

log("• pushing main + tag…");
run("git", ["push", "--follow-tags"]);

log(
  [
    "",
    `✓ Pushed ${tag}. The release workflow is now building (~10–15 min).`,
    "",
    "Next:",
    "  1. GitHub → Actions: watch the 'Release' run finish green.",
    "  2. GitHub → Releases: edit the DRAFT, write notes, PUBLISH.",
    "     Do NOT tick 'prerelease' — the updater endpoint 404s on those.",
    "",
  ].join("\n"),
);

function resolveVersion(from, spec) {
  if (/^\d+\.\d+\.\d+$/.test(spec)) return spec;
  if (!["patch", "minor", "major"].includes(spec)) {
    die(`expected X.Y.Z or patch|minor|major, got "${spec}".`);
  }
  const [major, minor, patch] = from.split(".").map(Number);
  if (spec === "major") return `${major + 1}.0.0`;
  if (spec === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}
