---
title: Running a team-mode Make project locally
description: How make clone, install, pull and dev run a team-mode project from GitHub main without touching Make, and why kits and .npmrc are refused or ignored.
date: 2026-10-14
---

# Running a team-mode Make project locally

In team mode GitHub `main` is the source of truth ([status.md](status.md)), so people run the app from a local clone. `make clone`, `make install`, `make pull` and `make dev` live in `src/make-local.js`, wired up in `src/commands/make.js:381`. None of them writes to Make or GitHub; they shell out to the caller's own `gh` and `git`, and figma-cli stores no tokens.

## Repo resolution

`resolveCloneRepo` (`src/make-local.js:20`) takes an explicit `owner/repo`, or with `--file` the repo named by the team marker. The command reads the marker through `client.projectMarker()` (`src/commands/make.js:400`), the same client VFS read the write gate uses, and parses it with `parseMarker` (`src/make-project.js:29`). No marker, a marker for another file, an invalid marker or a non-`main` trunk refuses with `MAKE_CLONE_NO_REPO`.

## Always main

Clone passes `-- --branch main` to `gh repo clone` and checks the result is on `main` (`src/make-local.js:226`). Pull fetches `+refs/heads/main:refs/remotes/origin/main` explicitly (`src/make-local.js:253`), so the repo's default branch never matters (the scratch repo's default was moved once during testing).

## Install checks

`install` (`src/make-local.js:198`) reports committed credentials first, so they show even when a later check refuses, then checks the toolchain and refuses kits:
- **Toolchain.** `.mise.toml` `[tools]` (`node`, `npm:pnpm`), `engines` and `packageManager` (`src/make-local.js:101`); `--version` runs in the clone so mise and corepack shims answer for it. Mismatches warn, a missing pnpm refuses. Make pins Node 22 / pnpm 10.34.3; a Node 24 / pnpm 10.33.2 machine installed and ran the scratch app fine (2026-10-14).
- **`.npmrc`.** Tracked `.npmrc` files with `_authToken`, `_auth` or `_password` produce a path:line warning, never the value (`src/make-local.js:67`). Make's own `.npmrc` is Figma-managed and git-excluded ([status.md](status.md) `PROJECT_EXCLUDES`), so a clone never has it and figma-cli never copies it.
- **Kits.** Any `@make-kits/*` dependency or `figma.kitAttachments` entry refuses with `MAKE_KIT_DEPENDENCY` (`src/make-local.js:43`). A kit attached in Make's UI resolves only through Make's registry; outside Make `pnpm install` fails with `ERR_PNPM_FETCH_404`. The design answer is vendored kit source pinned by `VENDOR.json` ([drift.md](drift.md)).
- **pnpm only, frozen and script-free.** `pnpm install --frozen-lockfile --ignore-scripts` (`src/make-local.js:84`); a repo without `pnpm-lock.yaml`, or whose `packageManager` names another tool, refuses with `MAKE_NO_LOCKFILE`. Make's own install uses `--no-frozen-lockfile`; locally the lockfile only changes in dependency PRs.

## Pull

Fast-forward only. Local commits on `main` refuse (`MAKE_PULL_LOCAL_COMMITS`), as do uncommitted tracked changes on a checked-out `main` (`MAKE_PULL_DIRTY`). On another branch only the `main` ref moves via `git update-ref` with the old value as a guard (`src/make-local.js:271`). Reinstall happens only when `pnpm-lock.yaml`'s blob at `HEAD` changed across the merge, compared by git blob id, so a pull from before `package.json` existed still works.

## Dev

`devCommand` runs `pnpm run dev` from `scripts.dev` and refuses without one (`MAKE_NO_DEV_SCRIPT`, `src/make-local.js:295`). `runDev` mirrors output, scans only complete lines of each stream, buffered separately, for the first local URL (a chunk can end mid-URL, `src/make-local.js:318`), prints `figma-cli: local URL …` on stderr, and forwards SIGINT/SIGTERM/SIGHUP. It never returns while the server runs: agents background it and poll the URL. The scratch app's Vite config serves on port 8443, not 5173.

## Live proof (2026-10-14)

Against `amelie-pierce/figma-testing-workflow` in a scratch folder: clone refused on its `@make-kits/atomicaui-7-0` dependency with the clone kept; with that dependency removed locally (and the lockfile regenerated locally), `make install` and `make dev` worked and the URL answered; pull was proven up to date, fast-forward without reinstall, fast-forward with a lockfile change (reinstall refused on the kit), local-commit and dirty refusals, and a task-branch ref move. GitHub `main` was unchanged. `make clone --file` on two scratch Make files refused for lack of a marker (no Make file has one yet). `amelie-pierce/hcs-design-prototype` cloned and installed cleanly.

Tests: `tests/make-local.test.js` (real local git with a bare origin; `gh` and installs faked).
