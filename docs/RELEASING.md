# Releasing

## TL;DR

```bash
npm run release -- patch        # or: minor | major | 0.2.2
```

That bumps the version, commits `release: vX.Y.Z`, creates the annotated tag,
and pushes both. Pushing the `v*` tag is what triggers the release workflow.

Flags:

| Flag | Effect |
| --- | --- |
| `--dry-run` | Print the plan, change nothing (still needs a clean tree). |
| `--no-push` | Commit + tag locally; push yourself later. |
| `--no-check` | Skip the `lint` + `test` run that precedes tagging. |

## What it touches

The version lives in **one place** and is mirrored:

| File | Role |
| --- | --- |
| `package.json` → `version` | **Source of truth.** `src-tauri/tauri.conf.json` reads `"version": "../package.json"`. |
| `src-tauri/Cargo.toml` → `[package] version` | Crate metadata; kept in step by the script. |
| `src-tauri/Cargo.lock` | Refreshed by the script (`cargo metadata`). |
| `README.md` | `Frieda.Player_<version>_…` installer names, if present. |

> Note: `tauri.conf.json` itself is **not** bumped — it points at `package.json`.

## The rules that bite

- **Tag names must be `v*`** — anything else won't trigger `.github/workflows/release.yml`.
- **Never tick "prerelease"** when publishing the draft — the updater endpoint
  (`releases/latest/…`) 404s on prereleases, and every installed app stops
  seeing updates.
- **Never reuse a version/tag** — installed apps compare versions, not commits.
  The script refuses a tag that already exists locally or on `origin`.
- **Version must be numeric `X.Y.Z`** — no `-beta.1`; WiX/MSI rejects semver
  prerelease segments. Put "beta" in the tag, not the version.
- **Never change `src-tauri/tauri.conf.json`'s `identifier`** — it decides where
  settings live and how autostart is registered.
- **Commits are cheap, tags are releases.** Pushing to `main` builds nothing.

## After pushing

1. GitHub → **Actions**: watch the `Release` run go green (~10–15 min).
2. GitHub → **Releases**: edit the **draft**, write notes, **publish**
   (prerelease box unticked).

## Fixing a bad release

Fix, commit, push, bump the patch (`npm run release -- patch`), publish. Never
retag. If you must delete a tag that was never published:

```bash
git tag -d v0.2.2 && git push origin :refs/tags/v0.2.2
```

## Testing updates end-to-end

Install a published build → release a newer version → in the old install, tray →
**Check for Updates** → the card offers the update → confirm → it downloads,
installs and relaunches.
